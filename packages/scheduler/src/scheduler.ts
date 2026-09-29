import { SYSTEM_ACTOR, type Board } from "@stellaris/board-core";
import {
  OpsSignalSchema,
  OWNER_NAME,
  OWNER_ROLE,
  parseChannelRef,
  SOCIETY_SCOPE,
  TriggerSchema,
  TurnDispatchSchema,
  type Agent,
  type BoardEvent,
  type Name,
  type OpsSignal,
  type OpsSignalKind,
  type RoleCharter,
  type Task,
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
  /** How often operations signals are computed and the scaling rule is applied. */
  readonly opsIntervalMs: number;
  /** A condition that persists is posted again after this long; one that clears and returns posts at once. */
  readonly signalRepeatMs: number;
  /** Cadence of the spend summary in the ops channel. */
  readonly costReportMs: number;
  /** A thread with several participants and no message for this long is stale. */
  readonly staleThreadMs: number;
  /** A member with no completed turn for this long is idle. */
  readonly idleMemberMs: number;
  /** At most one replica per role and project within this window. */
  readonly scaleCooldownMs: number;
  /** Cadence of reflection turns for roles that reflect, counted from the scheduler's first sight of the member. */
  readonly reflectionMs: number;
}

/** Defaults the plan leaves open; tune once the first society has run. */
export const DEFAULT_TIMINGS: SchedulerTimings = Object.freeze({
  pollMs: 1_000,
  debounceMs: 30_000,
  ownerDebounceMs: 5_000,
  heartbeatMs: 15 * 60_000,
  unclaimedTaskMs: 10 * 60_000,
  leaseSweepMs: 60_000,
  opsIntervalMs: 5 * 60_000,
  signalRepeatMs: 6 * 3_600_000,
  costReportMs: 3_600_000,
  staleThreadMs: 24 * 3_600_000,
  idleMemberMs: 3 * 24 * 3_600_000,
  scaleCooldownMs: 3_600_000,
  reflectionMs: 24 * 3_600_000,
});

/** Partial timings as configuration, for example from an environment variable holding JSON. */
export const SchedulerTimingsSchema = z
  .object({
    pollMs: z.number().positive(),
    debounceMs: z.number().nonnegative(),
    ownerDebounceMs: z.number().nonnegative(),
    heartbeatMs: z.number().positive(),
    unclaimedTaskMs: z.number().positive(),
    leaseSweepMs: z.number().positive(),
    opsIntervalMs: z.number().positive(),
    signalRepeatMs: z.number().positive(),
    costReportMs: z.number().positive(),
    staleThreadMs: z.number().positive(),
    idleMemberMs: z.number().positive(),
    scaleCooldownMs: z.number().positive(),
    reflectionMs: z.number().positive(),
  })
  .partial();

/** Parses timing overrides and drops absent keys, so spreading them over the defaults keeps every default. */
export function parseTimings(input: unknown): Partial<SchedulerTimings> {
  const parsed = SchedulerTimingsSchema.parse(input);
  const overrides: Partial<SchedulerTimings> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "number") {
      Object.assign(overrides, { [key]: value });
    }
  }
  return overrides;
}

export interface SchedulerOptions {
  readonly board: Board;
  readonly runner: TurnRunner;
  readonly timings?: Partial<SchedulerTimings> | undefined;
  /** Simultaneous turns on this machine. A machine limit, not an agent budget. */
  readonly concurrency?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: SchedulerLog | undefined;
}

const PendingSchema = z.object({ dispatch: TurnDispatchSchema, readyAt: z.number() });

const StateSchema = z.object({
  cursor: z.string().nullable(),
  lastHeartbeat: z.record(z.string(), z.string()),
  unclaimedSeen: z.record(z.string(), z.string()),
  /** Queued dispatches survive a restart; the cursor has already moved past the events that made them. */
  pending: z.record(z.string(), PendingSchema).default({}),
  opsReported: z.record(z.string(), z.string()).default({}),
  releaseCounts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  lastOps: z.string().nullable().default(null),
  lastScaled: z.record(z.string(), z.string()).default({}),
  lastCostReport: z.string().nullable().default(null),
  costSinceReport: z.number().nonnegative().default(0),
  turnsSinceReport: z.number().int().nonnegative().default(0),
  /** When each member last reflected, or was first seen; the cadence counts from here. */
  lastReflection: z.record(z.string(), z.string()).default({}),
});
type State = z.infer<typeof StateSchema>;

interface PendingTurn {
  dispatch: TurnDispatch;
  readyAt: number;
}

const SILENT_LOG: SchedulerLog = { info() {}, warn() {}, error() {} };

/** Signals that wake roles charted for `ops_event`. The rest inform through the ops channel at the next wake. */
const WAKING_SIGNALS: ReadonlySet<OpsSignalKind> = new Set<OpsSignalKind>([
  "backlog",
  "role_gap",
  "churn",
  "stale_thread",
  "idle_member",
  "blocked_capability",
  "scaled",
]);

const UNCLAIMED_TRIGGER = "unclaimed_task";
const CLAIM_TRIGGER = "claim_event";
const OPS_TRIGGER = "ops_event";
const OWNER_POST_TRIGGER = "owner_post";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The dumb scheduler from PLAN.md section 6. It reads event metadata, never message content,
 * turns it into triggers, debounces them, respects the pause switch and the concurrency cap,
 * and hands dispatches to a runner. On a cadence it also computes the operations signals of
 * section 6.5 from board state and applies the scaling rule of section 8.3 within each charter's cap.
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
  private state: State = StateSchema.parse({
    cursor: null,
    lastHeartbeat: {},
    unclaimedSeen: {},
  });
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

  /** Keys of the operations conditions that held at the last pass: what the playground shows as weather. */
  get activeSignals(): string[] {
    return Object.keys(this.state.opsReported).toSorted();
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

  /** One pass: consume events, check heartbeats and unclaimed tasks, run operations, sweep leases, dispatch. */
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
        await this.checkReflections(now);
        if (
          this.state.lastOps === null ||
          now - Date.parse(this.state.lastOps) >= this.timings.opsIntervalMs
        ) {
          await this.runOperations(now);
          this.state.lastOps = iso(now);
        }
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
    for (const [key, item] of Object.entries(this.state.pending)) {
      this.pending.set(key, item);
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    this.state.pending = Object.fromEntries(this.pending);
    await this.board.writeState("scheduler", this.state);
  }

  private async handleEvent(event: BoardEvent, now: number): Promise<void> {
    const payload = event.payload;
    switch (event.type) {
      case "message.posted": {
        const mentions = stringArray(payload["mentions"]);
        const channel = stringOf(payload["channel"]);
        const messageId = stringOf(payload["id"]) ?? undefined;
        for (const name of mentions) {
          if (name === event.actor || name === OWNER_NAME) {
            continue;
          }
          const agent = await this.tryReadAgent(name);
          if (agent === null) {
            continue;
          }
          const charter = await this.board.readRole(agent.role);
          const scope = this.scopeFor(agent, charter, channel);
          if (scope === null) {
            continue;
          }
          this.enqueue(
            agent.name,
            scope,
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
        if (event.actor === OWNER_NAME) {
          await this.wakeFrontDesk(channel, messageId, now);
        }
        return;
      }
      case "task.updated": {
        const taskId = stringOf(payload["taskId"]);
        const project = stringOf(payload["project"]);
        const from = stringOf(payload["from"]);
        const to = stringOf(payload["to"]);
        if (taskId === null || project === null) {
          return;
        }
        if (to === "done" || to === "abandoned") {
          delete this.state.releaseCounts[taskId];
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
      case "task.released":
      case "lease.expired": {
        const taskId = stringOf(payload["taskId"]);
        if (taskId !== null) {
          this.state.releaseCounts[taskId] = (this.state.releaseCounts[taskId] ?? 0) + 1;
        }
        return;
      }
      case "turn.completed": {
        const cost = payload["costUsd"];
        this.state.costSinceReport += typeof cost === "number" ? cost : 0;
        this.state.turnsSinceReport += 1;
        return;
      }
      case "wake.requested": {
        const agent = stringOf(payload["agent"]);
        const project = stringOf(payload["project"]);
        const reason = stringOf(payload["reason"]) ?? "manual wake";
        if (agent === null || project === null) {
          return;
        }
        if (payload["kind"] === "reflection") {
          // A reflection asked for ahead of the cadence restarts the cadence.
          this.state.lastReflection[agent] = iso(now);
          this.enqueue(
            agent,
            project,
            { kind: "reflection", from: event.actor, fromOwner: true, reason },
            now,
          );
          return;
        }
        this.enqueue(
          agent,
          project,
          { kind: "manual", from: event.actor, fromOwner: true, reason },
          now,
        );
        return;
      }
      case "agent.added": {
        const name = stringOf(payload["name"]);
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
      case "agent.retired": {
        const name = stringOf(payload["name"]);
        if (name === null) {
          return;
        }
        // Deleting the current entry while iterating a Map is safe; the iterator skips it.
        for (const key of this.pending.keys()) {
          if (key.startsWith(`${name}/`)) {
            this.pending.delete(key);
          }
        }
        return;
      }
      case "agent.joined": {
        const name = stringOf(payload["name"]);
        const project = stringOf(payload["project"]);
        const cli = payload["cli"];
        if (name === null || project === null || cli === null || cli === undefined) {
          return;
        }
        this.enqueue(name, project, { kind: "onboarding", reason: "joined the project" }, now);
        return;
      }
      case "agent.left": {
        const name = stringOf(payload["name"]);
        const project = stringOf(payload["project"]);
        if (name !== null && project !== null) {
          this.pending.delete(`${name}/${project}`);
        }
        return;
      }
      case "ops.signal": {
        const parsed = OpsSignalSchema.safeParse(payload);
        if (!parsed.success || !WAKING_SIGNALS.has(parsed.data.kind)) {
          return;
        }
        await this.wakeSignalReaders(parsed.data, event.actor, now);
        return;
      }
      default:
        return;
    }
  }

  /** Roles charted for `ops_event` wake on a signal, on the signal's project when they belong to it. */
  private async wakeSignalReaders(signal: OpsSignal, from: Name, now: number): Promise<void> {
    for (const agent of await this.board.listAgents()) {
      if (agent.status !== "active" || agent.cli === null) {
        continue;
      }
      const charter = await this.board.readRole(agent.role);
      if (!charter.wakeTriggers.includes(OPS_TRIGGER)) {
        continue;
      }
      const scope = this.scopeForProject(agent, charter, signal.project ?? null);
      if (scope === null) {
        continue;
      }
      this.enqueue(
        agent.name,
        scope,
        {
          kind: "ops_event",
          from,
          reason: signal.summary,
          ...(signal.taskId === undefined ? {} : { taskId: signal.taskId }),
        },
        now,
      );
    }
  }

  /**
   * The front desk: roles charted for `owner_post` wake on every post by the owner, mentioned or
   * not, at owner priority and without debounce. The only trigger that fires without a mention.
   */
  private async wakeFrontDesk(
    channel: string | null,
    messageId: string | undefined,
    now: number,
  ): Promise<void> {
    for (const agent of await this.board.listAgents()) {
      if (agent.status !== "active" || agent.cli === null) {
        continue;
      }
      const charter = await this.board.readRole(agent.role);
      if (!charter.wakeTriggers.includes(OWNER_POST_TRIGGER)) {
        continue;
      }
      const scope = this.scopeFor(agent, charter, channel);
      if (scope === null) {
        continue;
      }
      this.enqueue(
        agent.name,
        scope,
        {
          kind: "owner_post",
          from: OWNER_NAME,
          fromOwner: true,
          reason: `the owner posted in ${channel ?? "a channel"}`,
          ...(messageId === undefined ? {} : { messageId }),
        },
        now,
      );
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

  /**
   * A turn needs a scope: the channel's project if the agent belongs, else its first membership,
   * else the society scope for roles allowed to work outside projects, else nothing.
   */
  private scopeFor(agent: Agent, charter: RoleCharter, channel: string | null): Name | null {
    const project = channel === null ? null : parseChannelRef(channel).project;
    return this.scopeForProject(agent, charter, project);
  }

  private scopeForProject(agent: Agent, charter: RoleCharter, project: Name | null): Name | null {
    if (project !== null && agent.memberships.includes(project)) {
      return project;
    }
    return agent.memberships[0] ?? (charter.societyScope ? SOCIETY_SCOPE : null);
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

  /** Debounce coalesces chatter: mentions, claim events, and bursts of signals. Everything else runs at once. */
  private debounceFor(trigger: Trigger): number {
    switch (trigger.kind) {
      case "mention":
        return trigger.fromOwner ? this.timings.ownerDebounceMs : this.timings.debounceMs;
      case "claim_event":
      case "ops_event":
        return this.timings.debounceMs;
      case "owner_post":
        return 0;
      default:
        return 0;
    }
  }

  private async checkHeartbeats(now: number): Promise<void> {
    for (const agent of await this.board.listAgents()) {
      if (agent.status !== "active" || agent.cli === null) {
        continue;
      }
      const charter = await this.board.readRole(agent.role);
      const scopes =
        agent.memberships.length > 0
          ? agent.memberships
          : charter.societyScope
            ? [SOCIETY_SCOPE]
            : [];
      for (const project of scopes) {
        const key = `${agent.name}/${project}`;
        const last = this.state.lastHeartbeat[key];
        if (last === undefined) {
          this.state.lastHeartbeat[key] = iso(now);
          continue;
        }
        if (now - new Date(last).getTime() < this.timings.heartbeatMs) {
          continue;
        }
        this.state.lastHeartbeat[key] = iso(now);
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

  /**
   * Reflection turns, PLAN.md section 5.4: every `reflectionMs`, a member whose charter reflects
   * takes a turn for its memory in the scope of its latest working turn. A member that has not
   * worked since its last reflection has nothing to consolidate and is left alone.
   */
  private async checkReflections(now: number): Promise<void> {
    for (const agent of await this.board.listAgents()) {
      if (agent.status !== "active" || agent.cli === null) {
        continue;
      }
      const charter = await this.board.readRole(agent.role);
      if (!charter.reflects) {
        continue;
      }
      const last = this.state.lastReflection[agent.name];
      if (last === undefined) {
        this.state.lastReflection[agent.name] = iso(now);
        continue;
      }
      if (now - Date.parse(last) < this.timings.reflectionMs) {
        continue;
      }
      const latest = await this.latestWorkingTurn(agent, charter);
      if (latest === null) {
        this.state.lastReflection[agent.name] = iso(now);
        continue;
      }
      const key = `${agent.name}/${latest.scope}`;
      if (this.pending.has(key) || this.running.has(key)) {
        // Busy: try again next tick rather than merge the reflection into a working turn.
        continue;
      }
      this.state.lastReflection[agent.name] = iso(now);
      if (Date.parse(latest.endedAt) < Date.parse(last)) {
        continue;
      }
      this.enqueue(
        agent.name,
        latest.scope,
        { kind: "reflection", reason: "scheduled reflection" },
        now,
      );
    }
  }

  /** The member's most recent turn that was not itself a reflection, with the scope it ran in. */
  private async latestWorkingTurn(
    agent: Agent,
    charter: RoleCharter,
  ): Promise<{ scope: Name; endedAt: string } | null> {
    const scopes = charter.societyScope
      ? [...agent.memberships, SOCIETY_SCOPE]
      : [...agent.memberships];
    let latest: { scope: Name; endedAt: string } | null = null;
    for (const scope of scopes) {
      const turn = await this.board.readLastTurn(agent.name, scope);
      if (turn === null || turn.trigger.kind === "reflection") {
        continue;
      }
      const endedAt = turn.endedAt ?? turn.startedAt;
      if (latest === null || Date.parse(endedAt) > Date.parse(latest.endedAt)) {
        latest = { scope, endedAt };
      }
    }
    return latest;
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
        const age = now - new Date(task.createdAt).getTime();
        if (age < this.timings.unclaimedTaskMs) {
          continue;
        }
        this.state.unclaimedSeen[task.id] = iso(now);
        for (const member of await this.board.projectMembers(project.slug)) {
          if (member.cli === null) {
            continue;
          }
          const charter = await this.board.readRole(member.role);
          if (!charter.wakeTriggers.includes(UNCLAIMED_TRIGGER)) {
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
        await this.board.publishSignal({
          kind: "unclaimed_task",
          key: `unclaimed_task:${task.id}`,
          summary: `task ${task.id} "${task.title}" in ${project.slug} has been open for ${describeDuration(age)}`,
          value: age,
          threshold: this.timings.unclaimedTaskMs,
          project: project.slug,
          taskId: task.id,
        });
      }
    }
    for (const id of Object.keys(this.state.unclaimedSeen)) {
      if (!stillOpen.has(id)) {
        delete this.state.unclaimedSeen[id];
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Operations: signals from state, the scaling rule, and the spend report
  // ---------------------------------------------------------------------------------------------

  private async runOperations(now: number): Promise<void> {
    const signals = await this.collectSignals(now);
    const current = new Set(signals.map((signal) => signal.key));
    for (const key of Object.keys(this.state.opsReported)) {
      if (!current.has(key)) {
        delete this.state.opsReported[key];
      }
    }
    for (const signal of signals) {
      const reported = this.state.opsReported[signal.key];
      if (reported !== undefined && now - Date.parse(reported) < this.timings.signalRepeatMs) {
        continue;
      }
      await this.board.publishSignal(signal);
      this.state.opsReported[signal.key] = iso(now);
    }
    await this.scaleRoles(now);
    await this.reportCost(now);
  }

  /** Every condition from PLAN.md section 6.5 that holds right now. Counters and timers only. */
  private async collectSignals(now: number): Promise<OpsSignal[]> {
    const signals: OpsSignal[] = [];
    const roles = (await this.board.listRoles()).filter((role) => role.name !== OWNER_ROLE);
    const takers = roles.filter((role) => role.wakeTriggers.includes(UNCLAIMED_TRIGGER));
    const reviewers = roles.filter(
      (role) =>
        !role.wakeTriggers.includes(UNCLAIMED_TRIGGER) && role.wakeTriggers.includes(CLAIM_TRIGGER),
    );
    const offered = new Set(
      (await this.board.listRunners())
        .filter((runner) => runner.status === "connected")
        .flatMap((runner) => runner.capabilities),
    );

    for (const project of await this.board.listProjects()) {
      const slug = project.slug;
      const tasks = await this.board.listTasks(slug);
      const members = (await this.board.projectMembers(slug)).filter(
        (member) => member.cli !== null,
      );
      const open = tasks.filter((task) => task.status === "open").length;
      const claimed = tasks.filter((task) => task.status === "claimed").length;
      const inReview = tasks.filter((task) => task.status === "in_review").length;

      for (const role of takers) {
        const count = members.filter((member) => member.role === role.name).length;
        if (count === 0) {
          if (open > 0) {
            signals.push({
              kind: "role_gap",
              key: `role_gap:${slug}:${role.name}`,
              summary: `${slug} has ${open} open task(s) and no active ${role.name}`,
              value: open,
              project: slug,
              role: role.name,
            });
          }
          continue;
        }
        const depth = (open + claimed) / count;
        if (depth >= role.backlogThreshold) {
          signals.push({
            kind: "backlog",
            key: `backlog:${slug}:${role.name}`,
            summary: `${slug}: ${open + claimed} open or claimed task(s) for ${count} ${role.name}(s), depth ${depth.toFixed(1)} at threshold ${role.backlogThreshold}`,
            value: depth,
            threshold: role.backlogThreshold,
            project: slug,
            role: role.name,
          });
        }
      }
      for (const role of reviewers) {
        const count = members.filter((member) => member.role === role.name).length;
        if (count === 0 && inReview > 0) {
          signals.push({
            kind: "role_gap",
            key: `role_gap:${slug}:${role.name}`,
            summary: `${slug} has ${inReview} task(s) in review and no active ${role.name}`,
            value: inReview,
            project: slug,
            role: role.name,
          });
        }
      }

      for (const task of tasks) {
        const terminal = task.status === "done" || task.status === "abandoned";
        const releases = this.state.releaseCounts[task.id] ?? 0;
        if (!terminal && releases >= 2) {
          signals.push({
            kind: "churn",
            key: `churn:${task.id}`,
            summary: `task ${task.id} "${task.title}" in ${slug} was claimed and released ${releases} times`,
            value: releases,
            threshold: 2,
            project: slug,
            taskId: task.id,
          });
        }
        if (task.thread === "open") {
          const messages = await this.board.listThread(task.id);
          const participants = new Set(messages.map((message) => message.author)).size;
          const last = messages.at(-1)?.ts ?? task.updatedAt;
          const quiet = now - Date.parse(last);
          if (terminal) {
            signals.push({
              kind: "stale_thread",
              key: `stale_thread:${task.id}`,
              summary: `thread for ${task.status} task ${task.id} "${task.title}" in ${slug} was never closed`,
              value: participants,
              project: slug,
              taskId: task.id,
            });
          } else if (participants >= 3 && quiet >= this.timings.staleThreadMs) {
            signals.push({
              kind: "stale_thread",
              key: `stale_thread:${task.id}`,
              summary: `thread for task ${task.id} "${task.title}" in ${slug} has ${participants} participants and no message for ${describeDuration(quiet)}`,
              value: quiet,
              threshold: this.timings.staleThreadMs,
              project: slug,
              taskId: task.id,
            });
          }
        }
        if (!terminal) {
          const required = new Set([...project.requiredCapabilities, ...task.requiredCapabilities]);
          const missing = [...required].filter((capability) => !offered.has(capability));
          if (missing.length > 0) {
            signals.push({
              kind: "blocked_capability",
              key: `blocked_capability:${task.id}`,
              summary: `task ${task.id} "${task.title}" in ${slug} needs ${missing.join(", ")} and no connected runner offers it`,
              value: missing.length,
              project: slug,
              taskId: task.id,
            });
          }
        }
      }
    }

    for (const agent of await this.board.listAgents()) {
      if (agent.status !== "active" || agent.cli === null) {
        continue;
      }
      let last = Date.parse(agent.createdAt);
      for (const project of [...agent.memberships, SOCIETY_SCOPE]) {
        const turn = await this.board.readLastTurn(agent.name, project);
        const ended = turn?.endedAt ?? turn?.startedAt;
        if (ended !== undefined) {
          last = Math.max(last, Date.parse(ended));
        }
      }
      const idle = now - last;
      if (idle >= this.timings.idleMemberMs) {
        signals.push({
          kind: "idle_member",
          key: `idle_member:${agent.name}`,
          summary: `${agent.name} (${agent.role}) has not completed a turn for ${describeDuration(idle)}`,
          value: idle,
          threshold: this.timings.idleMemberMs,
          agent: agent.name,
          role: agent.role,
        });
      }
    }
    return signals;
  }

  /** The load a role answers for: open and claimed tasks for task-taking roles, tasks in review for reviewing roles. */
  private loadFor(role: RoleCharter, tasks: readonly Task[]): number {
    if (role.wakeTriggers.includes(UNCLAIMED_TRIGGER)) {
      return tasks.filter((task) => task.status === "open" || task.status === "claimed").length;
    }
    if (role.wakeTriggers.includes(CLAIM_TRIGGER)) {
      return tasks.filter((task) => task.status === "in_review").length;
    }
    return 0;
  }

  /**
   * Scaling is mechanism, hiring is policy: one more replica of an existing role when the load per
   * member reaches the charter's threshold, never past its replica cap, at most once per cooldown.
   */
  private async scaleRoles(now: number): Promise<void> {
    const roles = (await this.board.listRoles()).filter(
      (role) => role.name !== OWNER_ROLE && role.maxReplicas > 1,
    );
    if (roles.length === 0) {
      return;
    }
    for (const project of await this.board.listProjects()) {
      const tasks = await this.board.listTasks(project.slug);
      const members = (await this.board.projectMembers(project.slug)).filter(
        (member) => member.cli !== null,
      );
      for (const role of roles) {
        const key = `${project.slug}:${role.name}`;
        const last = this.state.lastScaled[key];
        if (last !== undefined && now - Date.parse(last) < this.timings.scaleCooldownMs) {
          continue;
        }
        const count = members.filter((member) => member.role === role.name).length;
        if (count >= role.maxReplicas) {
          continue;
        }
        const load = this.loadFor(role, tasks);
        if (load === 0 || (count > 0 && load / count < role.backlogThreshold)) {
          continue;
        }
        this.state.lastScaled[key] = iso(now);
        try {
          const replica = await this.board.addReplica(SYSTEM_ACTOR, {
            project: project.slug,
            role: role.name,
          });
          await this.board.publishSignal({
            kind: "scaled",
            key: `scaled:${key}:${replica.name}`,
            summary: `added ${replica.name} as ${role.name} number ${count + 1} on ${project.slug}: load ${load} across ${count} member(s), threshold ${role.backlogThreshold}, cap ${role.maxReplicas}`,
            value: count + 1,
            threshold: role.maxReplicas,
            project: project.slug,
            role: role.name,
            agent: replica.name,
          });
          this.log.info(
            { project: project.slug, role: role.name, replica: replica.name },
            "scaled",
          );
        } catch (error) {
          this.log.warn(
            { project: project.slug, role: role.name, error: String(error) },
            "scaling failed",
          );
        }
      }
    }
  }

  private async reportCost(now: number): Promise<void> {
    if (this.state.turnsSinceReport === 0) {
      return;
    }
    if (
      this.state.lastCostReport !== null &&
      now - Date.parse(this.state.lastCostReport) < this.timings.costReportMs
    ) {
      return;
    }
    const { turnsSinceReport: turns, costSinceReport: cost } = this.state;
    await this.board.publishSignal({
      kind: "turn_cost",
      key: "turn_cost",
      summary: `${turns} turn(s) completed for $${cost.toFixed(2)} since the last report`,
      value: cost,
    });
    this.state.lastCostReport = iso(now);
    this.state.costSinceReport = 0;
    this.state.turnsSinceReport = 0;
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
