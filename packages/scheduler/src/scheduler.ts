import type { Board } from "@stellaris/board-core";
import {
  OWNER_NAME,
  parseChannelRef,
  TriggerSchema,
  type Agent,
  type BoardEvent,
  type Name,
  type Trigger,
  type TriggerInput,
  type TurnDispatch,
  type TurnRecord,
  type Ulid,
} from "@stellaris/shared";
import { z } from "zod";
import { decideWake } from "./wake.js";

/** What the scheduler needs from a runner. The local runner and, later, remote runners implement it. */
export interface TurnRunner {
  runTurn(dispatch: TurnDispatch): Promise<TurnRecord>;
  mergeTask(project: Name, taskId: Ulid): Promise<void>;
}

export interface SchedulerLog {
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface SchedulerTimings {
  readonly pollMs: number;
  readonly debounceMs: number;
  readonly ownerDebounceMs: number;
  readonly heartbeatMs: number;
  readonly unclaimedTaskMs: number;
  readonly leaseSweepMs: number;
}

/** Defaults the plan leaves open; tune once the first society has run. */
export const DEFAULT_TIMINGS: SchedulerTimings = Object.freeze({
  pollMs: 1_000,
  debounceMs: 30_000,
  ownerDebounceMs: 5_000,
  heartbeatMs: 15 * 60_000,
  unclaimedTaskMs: 10 * 60_000,
  leaseSweepMs: 60_000,
});

export interface SchedulerOptions {
  readonly board: Board;
  readonly runner: TurnRunner;
  readonly timings?: Partial<SchedulerTimings> | undefined;
  /** Simultaneous turns on this machine. A machine limit, not an agent budget. */
  readonly concurrency?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: SchedulerLog | undefined;
}

const StateSchema = z.object({
  cursor: z.string().nullable(),
  lastHeartbeat: z.record(z.string(), z.string()),
  unclaimedSeen: z.record(z.string(), z.string()),
});
type State = z.infer<typeof StateSchema>;

interface PendingTurn {
  dispatch: TurnDispatch;
  readyAt: number;
}

const SILENT_LOG: SchedulerLog = { info() {}, warn() {}, error() {} };

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The dumb scheduler from PLAN.md section 6. It reads event metadata, never message content,
 * turns it into triggers, debounces them, respects the pause switch and the concurrency cap,
 * and hands dispatches to a runner. Its only persistent state is a cursor and two timestamps maps.
 */
export class Scheduler {
  private readonly board: Board;
  private readonly runner: TurnRunner;
  private readonly timings: SchedulerTimings;
  private readonly concurrency: number;
  private readonly now: () => Date;
  private readonly log: SchedulerLog;
  private readonly pending = new Map<string, PendingTurn>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly merging = new Set<Promise<void>>();
  private state: State = { cursor: null, lastHeartbeat: {}, unclaimedSeen: {} };
  private loaded = false;
  private ticking = false;
  private lastSweep = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SchedulerOptions) {
    this.board = options.board;
    this.runner = options.runner;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.concurrency = options.concurrency ?? 2;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? SILENT_LOG;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get runningCount(): number {
    return this.running.size;
  }

  /** Agent-project pairs waiting for dispatch, as `agent/project`. */
  get pendingPairs(): string[] {
    return [...this.pending.keys()].toSorted();
  }

  /** Agent-project pairs with a turn in flight, as `agent/project`. */
  get runningPairs(): string[] {
    return [...this.running.keys()].toSorted();
  }

  async start(): Promise<void> {
    await this.load();
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        this.log.error({ error: String(error) }, "scheduler tick failed");
      });
    }, this.timings.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.allSettled([...this.running.values(), ...this.merging]);
  }

  /** One pass: consume events, check heartbeats and unclaimed tasks, sweep leases, dispatch. */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.load();
      const now = this.now().getTime();
      const paused = await this.board.isPaused();
      const events = await this.board.readEvents(this.state.cursor, 500);
      for (const event of events) {
        await this.handleEvent(event, now);
        this.state.cursor = event.id;
      }
      if (!paused) {
        await this.checkHeartbeats(now);
        await this.checkUnclaimedTasks(now);
      }
      if (now - this.lastSweep >= this.timings.leaseSweepMs) {
        await this.board.expireLeases();
        this.lastSweep = now;
      }
      if (!paused) {
        this.dispatchReady(now);
      }
      await this.save();
    } finally {
      this.ticking = false;
    }
  }

  /** Waits for every running turn and in-flight merge to settle. Used by tests and by stop(). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values(), ...this.merging]);
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.state = await this.board.readState("scheduler", StateSchema, this.state);
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.board.writeState("scheduler", this.state);
  }

  private async handleEvent(event: BoardEvent, now: number): Promise<void> {
    const payload = event.payload;
    switch (event.type) {
      case "message.posted": {
        const mentions = stringArray(payload["mentions"]);
        const channel = typeof payload["channel"] === "string" ? payload["channel"] : null;
        const messageId = typeof payload["id"] === "string" ? payload["id"] : undefined;
        for (const name of mentions) {
          if (name === event.actor || name === OWNER_NAME) {
            continue;
          }
          const agent = await this.tryReadAgent(name);
          if (agent === null) {
            continue;
          }
          const project = this.projectFor(agent, channel);
          if (project === null) {
            continue;
          }
          this.enqueue(
            agent.name,
            project,
            {
              kind: "mention",
              from: event.actor,
              fromOwner: event.actor === OWNER_NAME,
              reason: `mentioned by ${event.actor}`,
              ...(messageId === undefined ? {} : { messageId }),
            },
            now,
          );
        }
        return;
      }
      case "task.updated": {
        const taskId = typeof payload["taskId"] === "string" ? payload["taskId"] : null;
        const project = typeof payload["project"] === "string" ? payload["project"] : null;
        const from = typeof payload["from"] === "string" ? payload["from"] : null;
        const to = typeof payload["to"] === "string" ? payload["to"] : null;
        if (taskId === null || project === null) {
          return;
        }
        if (to === "in_review") {
          for (const reviewer of await this.board.membersWithRole(project, "reviewer")) {
            if (reviewer.name !== event.actor && reviewer.cli !== null) {
              this.enqueue(
                reviewer.name,
                project,
                {
                  kind: "claim_event",
                  from: event.actor,
                  reason: "task submitted for review",
                  taskId,
                },
                now,
              );
            }
          }
          return;
        }
        if (to === "done") {
          this.merge(project, taskId);
          await this.wakeClaimer(taskId, project, event.actor, "task approved", now);
          return;
        }
        if (to === "claimed" && from === "in_review") {
          await this.wakeClaimer(taskId, project, event.actor, "changes requested", now);
        }
        return;
      }
      case "wake.requested": {
        const agent = typeof payload["agent"] === "string" ? payload["agent"] : null;
        const project = typeof payload["project"] === "string" ? payload["project"] : null;
        const reason = typeof payload["reason"] === "string" ? payload["reason"] : "manual wake";
        if (agent !== null && project !== null) {
          this.enqueue(
            agent,
            project,
            { kind: "manual", from: event.actor, fromOwner: true, reason },
            now,
          );
        }
        return;
      }
      case "agent.added": {
        const name = typeof payload["name"] === "string" ? payload["name"] : null;
        const cli = payload["cli"];
        const memberships = stringArray(payload["memberships"]);
        if (name === null || cli === null || cli === undefined) {
          return;
        }
        for (const project of memberships) {
          this.enqueue(name, project, { kind: "onboarding", reason: "joined the project" }, now);
        }
        return;
      }
      default:
        return;
    }
  }

  private async wakeClaimer(
    taskId: Ulid,
    project: Name,
    from: Name,
    reason: string,
    now: number,
  ): Promise<void> {
    try {
      const { task } = await this.board.findTask(taskId);
      if (task.claimedBy !== undefined && task.claimedBy !== from) {
        const agent = await this.tryReadAgent(task.claimedBy);
        if (agent !== null) {
          this.enqueue(agent.name, project, { kind: "claim_event", from, reason, taskId }, now);
        }
      }
    } catch (error) {
      this.log.warn({ taskId, error: String(error) }, "could not resolve task claimer");
    }
  }

  private async tryReadAgent(name: Name): Promise<Agent | null> {
    try {
      const agent = await this.board.readAgent(name);
      return agent.status === "active" && agent.cli !== null ? agent : null;
    } catch {
      return null;
    }
  }

  /** A turn needs a project for its working directory: the channel's project if the agent belongs, else its first membership. */
  private projectFor(agent: Agent, channel: string | null): Name | null {
    if (channel !== null) {
      const parsed = parseChannelRef(channel);
      if (parsed.project !== null && agent.memberships.includes(parsed.project)) {
        return parsed.project;
      }
    }
    return agent.memberships[0] ?? null;
  }

  private enqueue(agent: Name, project: Name, input: TriggerInput, now: number): void {
    const trigger = TriggerSchema.parse(input);
    const decision = decideWake({ trigger, digestSize: 0, claimsHeld: 0, paused: false });
    if (!decision.wake) {
      return;
    }
    const debounce = this.debounceFor(trigger);
    const key = `${agent}/${project}`;
    const readyAt = now + debounce;
    const existing = this.pending.get(key);
    if (existing === undefined) {
      this.pending.set(key, {
        dispatch: {
          agent,
          project,
          trigger,
          priority: decision.priority,
          onboarding: trigger.kind === "onboarding",
        },
        readyAt,
      });
      return;
    }
    const keepNew = decision.priority > existing.dispatch.priority;
    const priority = keepNew ? decision.priority : existing.dispatch.priority;
    this.pending.set(key, {
      dispatch: {
        ...existing.dispatch,
        trigger: keepNew ? trigger : existing.dispatch.trigger,
        priority,
        onboarding: existing.dispatch.onboarding || trigger.kind === "onboarding",
      },
      readyAt: Math.min(existing.readyAt, readyAt),
    });
  }

  /** Debounce coalesces chatter. Only mentions and claim events are chatter; everything else runs at once. */
  private debounceFor(trigger: Trigger): number {
    switch (trigger.kind) {
      case "mention":
        return trigger.fromOwner ? this.timings.ownerDebounceMs : this.timings.debounceMs;
      case "claim_event":
        return this.timings.debounceMs;
      default:
        return 0;
    }
  }

  private async checkHeartbeats(now: number): Promise<void> {
    for (const agent of await this.board.listAgents()) {
      if (agent.status !== "active" || agent.cli === null) {
        continue;
      }
      for (const project of agent.memberships) {
        const key = `${agent.name}/${project}`;
        const last = this.state.lastHeartbeat[key];
        if (last === undefined) {
          this.state.lastHeartbeat[key] = new Date(now).toISOString();
          continue;
        }
        if (now - new Date(last).getTime() < this.timings.heartbeatMs) {
          continue;
        }
        this.state.lastHeartbeat[key] = new Date(now).toISOString();
        if (this.pending.has(key) || this.running.has(key)) {
          continue;
        }
        const inbox = await this.board.readInbox(
          { name: agent.name, role: agent.role },
          { advance: false, limit: 1 },
        );
        const held = await this.board.heldClaims(agent.name);
        const trigger = TriggerSchema.parse({ kind: "heartbeat", reason: "heartbeat" });
        const decision = decideWake({
          trigger,
          digestSize: inbox.messages.length,
          claimsHeld: held.length,
          paused: false,
        });
        if (decision.wake) {
          this.pending.set(key, {
            dispatch: {
              agent: agent.name,
              project,
              trigger,
              priority: decision.priority,
              onboarding: false,
            },
            readyAt: now,
          });
        }
      }
    }
  }

  private async checkUnclaimedTasks(now: number): Promise<void> {
    const stillOpen = new Set<string>();
    for (const project of await this.board.listProjects()) {
      const open = await this.board.openTasks(project.slug);
      for (const task of open) {
        stillOpen.add(task.id);
        if (this.state.unclaimedSeen[task.id] !== undefined) {
          continue;
        }
        if (now - new Date(task.createdAt).getTime() < this.timings.unclaimedTaskMs) {
          continue;
        }
        this.state.unclaimedSeen[task.id] = new Date(now).toISOString();
        for (const member of await this.board.projectMembers(project.slug)) {
          if (member.cli === null) {
            continue;
          }
          const charter = await this.board.readRole(member.role);
          if (!charter.wakeTriggers.includes("unclaimed_task")) {
            continue;
          }
          this.enqueue(
            member.name,
            project.slug,
            {
              kind: "unclaimed_task",
              reason: `task ${task.id} has been open too long`,
              taskId: task.id,
            },
            now,
          );
        }
      }
    }
    for (const id of Object.keys(this.state.unclaimedSeen)) {
      if (!stillOpen.has(id)) {
        delete this.state.unclaimedSeen[id];
      }
    }
  }

  private dispatchReady(now: number): void {
    const ready = [...this.pending.entries()]
      .filter(([key, item]) => item.readyAt <= now && !this.running.has(key))
      .toSorted(
        ([, a], [, b]) => b.dispatch.priority - a.dispatch.priority || a.readyAt - b.readyAt,
      );
    for (const [key, item] of ready) {
      if (this.running.size >= this.concurrency) {
        break;
      }
      this.pending.delete(key);
      const { dispatch } = item;
      this.log.info(
        { agent: dispatch.agent, project: dispatch.project, trigger: dispatch.trigger.kind },
        "dispatching turn",
      );
      const promise = (async (): Promise<void> => {
        try {
          const record = await this.runner.runTurn(dispatch);
          this.log.info(
            {
              agent: dispatch.agent,
              project: dispatch.project,
              exitReason: record.exitReason,
              costUsd: record.costUsd,
            },
            "turn finished",
          );
        } catch (error) {
          this.log.error(
            { agent: dispatch.agent, project: dispatch.project, error: String(error) },
            "turn crashed",
          );
        } finally {
          this.running.delete(key);
        }
      })();
      this.running.set(key, promise);
    }
  }

  private merge(project: Name, taskId: Ulid): void {
    const promise: Promise<void> = this.runner
      .mergeTask(project, taskId)
      .catch((error: unknown) => {
        this.log.error({ project, taskId, error: String(error) }, "merge failed");
      })
      .finally(() => {
        this.merging.delete(promise);
      });
    this.merging.add(promise);
  }
}
