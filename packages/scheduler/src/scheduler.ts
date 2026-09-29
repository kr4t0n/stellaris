import { SYSTEM_ACTOR, type Board } from "@stellaris/board-core";
import {
  currentStage,
  mayHoldStage,
  OpsSignalSchema,
  USER_NAME,
  USER_ROLE,
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

/** What the scheduler needs from a runner. */
export interface TurnRunner {
  runTurn(dispatch: TurnDispatch): Promise<TurnRecord>;
  /** Runs a completing task's completion effect and records the outcome on the board. */
  completeTask(project: Name, taskId: Ulid): Promise<void>;
}

export interface SchedulerLog {
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface SchedulerTimings {
  readonly pollMs: number;
  readonly debounceMs: number;
  readonly userDebounceMs: number;
  readonly heartbeatMs: number;
  /** A current stage without a holder for this long is signalled as waiting. */
  readonly waitingStageMs: number;
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

export const DEFAULT_TIMINGS: SchedulerTimings = Object.freeze({
  pollMs: 1_000,
  debounceMs: 30_000,
  userDebounceMs: 5_000,
  heartbeatMs: 15 * 60_000,
  waitingStageMs: 10 * 60_000,
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
    userDebounceMs: z.number().nonnegative(),
    heartbeatMs: z.number().positive(),
    waitingStageMs: z.number().positive(),
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

const PendingSchema = z.object({
  dispatch: TurnDispatchSchema,
  readyAt: z.number(),
  stageWakes: z.array(TriggerSchema).optional(),
});

const StateSchema = z.object({
  cursor: z.string().nullable(),
  lastHeartbeat: z.record(z.string(), z.string()),
  /** Waiting stages already signalled, as `task:stage`, so each is posted once while it waits. */
  waitingSeen: z.record(z.string(), z.string()).default({}),
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
  /** Present while every wake merged into this turn is a stage wake; they are rechecked at dispatch. */
  stageWakes?: Trigger[] | undefined;
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

const HEARTBEAT_TRIGGER = "heartbeat";

/**
 * The unread messages a heartbeat in `scope` answers for: those of its own scope and, in the
 * society scope, those of scopes the member takes no heartbeat in, so a society-scope role still
 * hears a project thread it joined. A project member without the society scope is not woken by
 * society channels; mentions wake it directly, and its next turn's digest carries the rest.
 */
export function unreadFor(
  unread: ReadonlyMap<string, number>,
  scope: string,
  scopes: readonly string[],
): number {
  let count = unread.get(scope) ?? 0;
  if (scope === SOCIETY_SCOPE) {
    for (const [other, n] of unread) {
      if (!scopes.includes(other)) {
        count += n;
      }
    }
  }
  return count;
}
const OPS_TRIGGER = "ops_event";
const USER_POST_TRIGGER = "user_post";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A task still being worked: its current stage counts toward load, gaps, and waiting. */
function inPlay(task: Task): boolean {
  return (task.status === "open" || task.status === "claimed") && !task.completing;
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
 * Turns event metadata, never message content, into debounced dispatches under the pause switch
 * and the concurrency cap. On a cadence it also publishes operations signals computed from board
 * state and applies each charter's scaling rule.
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
  /** Tasks whose completion effect waits for the turn that finished their last stage to end. */
  private readonly completions = new Map<Ulid, { project: Name; actor: Name }>();
  private readonly completing = new Set<Promise<void>>();
  private state: State = StateSchema.parse({
    cursor: null,
    lastHeartbeat: {},
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

  /** Keys of the operations conditions that held at the last pass: what holds right now, not what was posted. */
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
    await Promise.allSettled([...this.running.values(), ...this.completing]);
  }

  /** One pass: consume events, check heartbeats and waiting stages, run operations, sweep leases, dispatch. */
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
        await this.checkWaitingStages(now);
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
      this.runCompletions();
      if (!paused) {
        await this.dispatchReady(now);
      }
      await this.save();
    } finally {
      this.ticking = false;
    }
  }

  /** Waits for every running turn and in-flight completion to settle. Used by tests and by stop(). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values(), ...this.completing]);
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.state = await this.board.readState("scheduler", StateSchema, this.state);
    for (const [key, item] of Object.entries(this.state.pending)) {
      this.pending.set(key, item);
    }
    // A completion interrupted by a restart left its task completing, and its event is consumed.
    for (const project of await this.board.listProjects()) {
      for (const task of await this.board.listTasks(project.slug)) {
        if (task.completing) {
          this.completions.set(task.id, { project: project.slug, actor: USER_NAME });
        }
      }
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
          if (name === event.actor || name === USER_NAME) {
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
              fromUser: event.actor === USER_NAME,
              reason: `mentioned by ${event.actor}`,
              ...(messageId === undefined ? {} : { messageId }),
            },
            now,
          );
        }
        if (event.actor === USER_NAME) {
          await this.wakeFrontDesk(channel, messageId, now);
        }
        return;
      }
      case "task.created":
      case "task.advanced":
      case "task.moved":
      case "task.planned":
      case "task.reopened": {
        const taskId = stringOf(payload["taskId"]);
        const settled =
          (event.type === "task.planned" && payload["currentChanged"] !== true) ||
          (event.type === "task.advanced" && payload["to"] === null);
        if (taskId !== null && !settled) {
          await this.wakeStage(taskId, event.actor, now);
        }
        return;
      }
      case "task.completing": {
        const taskId = stringOf(payload["taskId"]);
        const project = stringOf(payload["project"]);
        if (taskId !== null && project !== null) {
          this.completions.set(taskId, { project, actor: event.actor });
        }
        return;
      }
      case "task.completed": {
        const taskId = stringOf(payload["taskId"]);
        const project = stringOf(payload["project"]);
        const creator = stringOf(payload["createdBy"]);
        if (taskId === null || project === null) {
          return;
        }
        delete this.state.releaseCounts[taskId];
        if (creator !== null && creator !== event.actor) {
          await this.wakeCreator(taskId, project, creator, event.actor, now);
        }
        return;
      }
      case "task.updated": {
        const taskId = stringOf(payload["taskId"]);
        if (taskId !== null && payload["to"] === "abandoned") {
          delete this.state.releaseCounts[taskId];
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
            { kind: "reflection", from: event.actor, fromUser: true, reason },
            now,
          );
          return;
        }
        this.enqueue(
          agent,
          project,
          { kind: "manual", from: event.actor, fromUser: true, reason },
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

  /** Roles charted for `user_post` wake on every post by the user, mentioned or not. */
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
      if (!charter.wakeTriggers.includes(USER_POST_TRIGGER)) {
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
          kind: "user_post",
          from: USER_NAME,
          fromUser: true,
          reason: `the user posted in ${channel ?? "a channel"}`,
          ...(messageId === undefined ? {} : { messageId }),
        },
        now,
      );
    }
  }

  /**
   * Entering a stage wakes its named citizen, else its last holder when work returns to it, else
   * the project's members of its role. An unassigned stage waits for the waiting-stage timer.
   */
  private async wakeStage(taskId: Ulid, from: Name, now: number): Promise<void> {
    let task: Task;
    try {
      task = (await this.board.findTask(taskId)).task;
    } catch {
      return;
    }
    const stage = currentStage(task);
    if (stage === undefined || task.status !== "open" || task.completing) {
      return;
    }
    const lastHolder = stage.holders.at(-1);
    const targets =
      stage.agent !== undefined
        ? [stage.agent]
        : lastHolder !== undefined
          ? [lastHolder]
          : stage.role !== undefined
            ? (await this.board.membersWithRole(task.project, stage.role)).map((a) => a.name)
            : [];
    for (const name of targets) {
      const agent = await this.tryReadAgent(name);
      if (agent === null || !mayHoldStage(agent, task)) {
        continue;
      }
      const charter = await this.board.readRole(agent.role);
      const scope = this.scopeForProject(agent, charter, task.project);
      if (scope === null) {
        continue;
      }
      this.enqueue(
        agent.name,
        scope,
        {
          kind: "stage",
          from,
          reason: `stage "${stage.name}" of task ${task.id} "${task.title}" is waiting for you`,
          taskId: task.id,
        },
        now,
      );
    }
  }

  /** The first of these stage wakes whose task still waits, unheld, on a stage the agent may hold. */
  private async stillWaiting(name: Name, wakes: Trigger[]): Promise<Trigger | undefined> {
    const agent = await this.tryReadAgent(name);
    if (agent === null) {
      return undefined;
    }
    for (const wake of wakes) {
      if (wake.taskId === undefined) {
        return wake;
      }
      try {
        const { task } = await this.board.findTask(wake.taskId);
        if (
          task.status === "open" &&
          !task.completing &&
          currentStage(task) !== undefined &&
          mayHoldStage(agent, task)
        ) {
          return wake;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async wakeCreator(
    taskId: Ulid,
    project: Name,
    creator: Name,
    from: Name,
    now: number,
  ): Promise<void> {
    const agent = await this.tryReadAgent(creator);
    if (agent === null) {
      return;
    }
    const charter = await this.board.readRole(agent.role);
    const scope = this.scopeForProject(agent, charter, project);
    if (scope === null) {
      return;
    }
    this.enqueue(
      agent.name,
      scope,
      { kind: "task_done", from, reason: `task ${taskId} you created is done`, taskId },
      now,
    );
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
    const decision = decideWake({
      trigger,
      digestSize: 0,
      claimsHeld: 0,
      waitingStages: 0,
      paused: false,
    });
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
        ...(trigger.kind === "stage" ? { stageWakes: [trigger] } : {}),
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
      ...(existing.stageWakes !== undefined && trigger.kind === "stage"
        ? { stageWakes: [...existing.stageWakes, trigger] }
        : {}),
    });
  }

  /** Debounce coalesces chatter: mentions, stage handoffs, and bursts of signals. Everything else runs at once. */
  private debounceFor(trigger: Trigger): number {
    switch (trigger.kind) {
      case "mention":
        return trigger.fromUser ? this.timings.userDebounceMs : this.timings.debounceMs;
      case "stage":
      case "task_done":
      case "ops_event":
        return this.timings.debounceMs;
      case "user_post":
        return 0;
      default:
        return 0;
    }
  }

  /**
   * A heartbeat per member and scope, each answering only for its own scope: unread messages in
   * its channels and threads, stages the member holds there, and stages waiting there for it.
   */
  private async checkHeartbeats(now: number): Promise<void> {
    for (const agent of await this.board.listAgents()) {
      if (agent.status !== "active" || agent.cli === null) {
        continue;
      }
      const charter = await this.board.readRole(agent.role);
      if (!charter.wakeTriggers.includes(HEARTBEAT_TRIGGER)) {
        continue;
      }
      const scopes =
        agent.memberships.length > 0
          ? agent.memberships
          : charter.societyScope
            ? [SOCIETY_SCOPE]
            : [];
      const actor = { name: agent.name, role: agent.role };
      let unread: ReadonlyMap<string, number> | undefined;
      let held: readonly Task[] | undefined;
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
        unread ??= await this.board.unreadByScope(actor);
        held ??= await this.board.heldClaims(agent.name);
        const waiting =
          project === SOCIETY_SCOPE
            ? []
            : (await this.board.openTasks(project)).filter((task) => {
                const stage = currentStage(task);
                const named = stage?.agent === agent.name || stage?.role === agent.role;
                return named && mayHoldStage(agent, task);
              });
        const trigger = TriggerSchema.parse({ kind: "heartbeat", reason: "heartbeat" });
        const decision = decideWake({
          trigger,
          digestSize: unreadFor(unread, project, scopes),
          claimsHeld: held.filter((task) => task.project === project).length,
          waitingStages: waiting.length,
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
   * Every `reflectionMs`, a member whose charter reflects takes a reflection turn in the scope of
   * its latest working turn, unless it has not worked since its last reflection.
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

  /**
   * A current stage without a holder past the threshold is posted to the ops channel once while it
   * waits. It wakes nobody by itself: its assignees see it on their heartbeat, and the steward
   * decides whether to replan or to mention someone.
   */
  private async checkWaitingStages(now: number): Promise<void> {
    const stillWaiting = new Set<string>();
    for (const project of await this.board.listProjects()) {
      for (const task of await this.board.openTasks(project.slug)) {
        const stage = currentStage(task);
        if (stage === undefined) {
          continue;
        }
        const key = `${task.id}:${stage.id}`;
        stillWaiting.add(key);
        if (this.state.waitingSeen[key] !== undefined) {
          continue;
        }
        const age = now - Date.parse(task.stageSince);
        if (age < this.timings.waitingStageMs) {
          continue;
        }
        this.state.waitingSeen[key] = iso(now);
        const assignee = stage.agent ?? stage.role ?? "anyone in the project";
        await this.board.publishSignal({
          kind: "waiting_stage",
          key: `waiting_stage:${key}`,
          summary: `stage "${stage.name}" of task ${task.id} "${task.title}" in ${project.slug}, for ${assignee}, has waited ${describeDuration(age)} for a holder`,
          value: age,
          threshold: this.timings.waitingStageMs,
          project: project.slug,
          taskId: task.id,
          ...(stage.role === undefined ? {} : { role: stage.role }),
          ...(stage.agent === undefined ? {} : { agent: stage.agent }),
        });
      }
    }
    for (const key of Object.keys(this.state.waitingSeen)) {
      if (!stillWaiting.has(key)) {
        delete this.state.waitingSeen[key];
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

  /** Every operations condition that holds right now, from counters and timers only. */
  private async collectSignals(now: number): Promise<OpsSignal[]> {
    const signals: OpsSignal[] = [];
    const roles = (await this.board.listRoles()).filter((role) => role.name !== USER_ROLE);
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

      const gaps = new Map<Name, number>();
      for (const task of tasks) {
        const role = inPlay(task) ? currentStage(task)?.role : undefined;
        if (role !== undefined && !members.some((member) => member.role === role)) {
          gaps.set(role, (gaps.get(role) ?? 0) + 1);
        }
      }
      for (const [role, count] of gaps) {
        signals.push({
          kind: "role_gap",
          key: `role_gap:${slug}:${role}`,
          summary: `${slug} has ${count} stage(s) waiting on the ${role} role and no active ${role}`,
          value: count,
          project: slug,
          role,
        });
      }

      for (const role of roles) {
        const count = members.filter((member) => member.role === role.name).length;
        const load = this.loadFor(role, tasks);
        if (count === 0 || load === 0) {
          continue;
        }
        const depth = load / count;
        if (depth >= role.backlogThreshold) {
          signals.push({
            kind: "backlog",
            key: `backlog:${slug}:${role.name}`,
            summary: `${slug}: ${load} current stage(s) for ${count} ${role.name}(s), depth ${depth.toFixed(1)} at threshold ${role.backlogThreshold}`,
            value: depth,
            threshold: role.backlogThreshold,
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

    for (const thread of await this.board.listThreads()) {
      if (thread.state !== "open") {
        continue;
      }
      const messages = await this.board.listThread(thread.id);
      const participants = new Set(messages.map((message) => message.author)).size;
      const quiet = now - Date.parse(messages.at(-1)?.ts ?? thread.openedAt);
      if (participants >= 3 && quiet >= this.timings.staleThreadMs) {
        const { project } = parseChannelRef(thread.channel);
        signals.push({
          kind: "stale_thread",
          key: `stale_thread:${thread.id}`,
          summary: `thread ${thread.id} "${thread.title}" in ${thread.channel} has ${participants} participants and no message for ${describeDuration(quiet)}`,
          value: quiet,
          threshold: this.timings.staleThreadMs,
          ...(project === null ? {} : { project }),
          ...(thread.subject?.kind === "task" ? { taskId: thread.subject.id } : {}),
        });
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

  /** The current stages assigned to a role: its load for backlog signals and scaling. */
  private loadFor(role: RoleCharter, tasks: readonly Task[]): number {
    return tasks.filter((task) => inPlay(task) && currentStage(task)?.role === role.name).length;
  }

  /**
   * Adds one replica of a role when the load per member reaches the charter's threshold, never past
   * its replica cap, at most once per cooldown per role and project.
   */
  private async scaleRoles(now: number): Promise<void> {
    const roles = (await this.board.listRoles()).filter(
      (role) => role.name !== USER_ROLE && role.maxReplicas > 1,
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

  private async dispatchReady(now: number): Promise<void> {
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
      let { dispatch } = item;
      if (item.stageWakes !== undefined) {
        // A stage wake queued during the agent's own turn is often stale by now: it took the stage
        // itself, or someone else did, or the task moved on.
        const current = await this.stillWaiting(dispatch.agent, item.stageWakes);
        if (current === undefined) {
          this.log.info(
            { agent: dispatch.agent, project: dispatch.project },
            "dropping stage wake, the stage no longer waits for this agent",
          );
          continue;
        }
        dispatch = { ...dispatch, trigger: current };
      }
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

  /** Starts each queued completion once the turn that finished the task's last stage has ended. */
  private runCompletions(): void {
    for (const [taskId, item] of this.completions) {
      if (this.running.has(`${item.actor}/${item.project}`)) {
        continue;
      }
      this.completions.delete(taskId);
      const promise: Promise<void> = this.runner
        .completeTask(item.project, taskId)
        .catch((error: unknown) => {
          this.log.error(
            { project: item.project, taskId, error: String(error) },
            "completion failed",
          );
        })
        .finally(() => {
          this.completing.delete(promise);
        });
      this.completing.add(promise);
    }
  }
}
