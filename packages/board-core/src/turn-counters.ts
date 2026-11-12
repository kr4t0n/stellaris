import {
  CliKindSchema,
  ResumeFailureSchema,
  type BoardEvent,
  type CliKind,
  type Usage,
} from "@stellaris/shared";
import { z } from "zod";
import { failureReason, type FailureReason } from "./failure-reason.js";
import type { MatchingCitizen } from "./mention-matching.js";
import { TurnHistoryPayloadSchema } from "./turn-history.js";
import { WakeLatency, type MentionWaitSeries, type WakeLatencySeries } from "./wake-latency.js";

/** The kinds of token a turn's usage holds, as the token counter labels them. */
export const TOKEN_KINDS = ["input", "output", "cache_read", "cache_write"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

const USAGE_FIELD: Record<TokenKind, keyof Usage> = {
  input: "inputTokens",
  output: "outputTokens",
  cache_read: "cacheReadTokens",
  cache_write: "cacheWriteTokens",
};

/** A label's value when neither the turn's end nor its citizen's record names it. */
export const UNKNOWN_LABEL = "unknown";

/** The tokens of one kind that one citizen's turns in one scope used on one CLI and model. */
export interface TurnTokenSeries {
  readonly project: string;
  readonly agent: string;
  readonly cli: string;
  readonly model: string;
  readonly kind: TokenKind;
  readonly tokens: number;
}

/** One citizen's finished turns of one outcome and trigger. */
export interface TurnSeries {
  readonly agent: string;
  readonly outcome: "completed" | "failed";
  readonly trigger: string;
  readonly turns: number;
}

/** One citizen's finished turns of one trigger that took no board action. */
export interface IdleSeries {
  readonly agent: string;
  readonly trigger: string;
  readonly turns: number;
}

/** One citizen's failed turns on one CLI for one reason. */
export interface FailedSeries {
  readonly agent: string;
  readonly cli: string;
  readonly reason: FailureReason;
  readonly turns: number;
}

/** The turns one citizen has running now in one scope: a project, or the society. */
export interface RunningSeries {
  readonly project: string;
  readonly agent: string;
  readonly turns: number;
}

/**
 * A turn running now as the counters read it: its citizen and its scope, a project or the
 * society, which `TurnInFlight` gives.
 */
export interface RunningTurn {
  readonly agent: string;
  readonly scope: string;
}

/** The stages one citizen, or the user, sent back in one project's tasks. */
export interface SendBackSeries {
  readonly project: string;
  readonly by: string;
  readonly sendBacks: number;
}

export interface TurnCounts {
  readonly tokens: readonly TurnTokenSeries[];
  readonly turns: readonly TurnSeries[];
  readonly running: readonly RunningSeries[];
  readonly idle: readonly IdleSeries[];
  readonly failed: readonly FailedSeries[];
  readonly sendBacks: readonly SendBackSeries[];
  readonly wakeLatency: readonly WakeLatencySeries[];
  readonly mentions: readonly MentionWaitSeries[];
}

// What a failed turn's end adds to the history's fields for its reason. A value a later board
// adds reads as none, so the turn still counts.
const FailedEndSchema = z.object({
  resumeFailed: ResumeFailureSchema.optional().catch(undefined),
  transient: z.boolean().optional().catch(undefined),
});

// A send-back as the metrics read it: `task.moved`, naming its task and project.
const TaskMovedSchema = z.object({ taskId: z.string(), project: z.string() });

// A turn's start as the running gauge reads it: the scope it runs in.
const TurnStartedSchema = z.object({ project: z.string() });

/**
 * The turn whose transcript a `turn.completed` needs read for the idle count: one that is not a
 * reflection, has an id, and was logged before ends carried their board actions. Null otherwise.
 */
export function transcriptToRead(event: BoardEvent): string | null {
  if (event.type !== "turn.completed") {
    return null;
  }
  const turn = TurnHistoryPayloadSchema.safeParse(event.payload);
  return turn.success &&
    turn.data.trigger !== "reflection" &&
    turn.data.boardActions === undefined &&
    turn.data.turnId !== undefined
    ? turn.data.turnId
    : null;
}

/** Orders by UTF-16 code units, as the board sorts names, never by the host's locale. */
function byKey<T>(entries: ReadonlyMap<string, T>): T[] {
  return [...entries]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, series]) => series);
}

/**
 * Every finished turn counted as it ends, for Prometheus: the turns `tokenUse` counts over all
 * time, by the same schema, so the two agree, and the tokens of those that counted them, by the
 * scope each ran in; the finished turns that took no board action, the send-backs, and the wake
 * latency of each answered mention, as the metrics count them over the window `all`; the mentions
 * still waiting and those that waited too long; the failed turns by `failureReason`; and the turns
 * running now. Labels name a citizen, a CLI, a model, a kind of token, an outcome, a trigger, a
 * reason, and a project or the society scope, never a thread, a task, a stage, or a turn. Adding
 * is the only change, so every series only grows, but the mentions waiting, which a mention's
 * answer or its age takes away, and the turns running, which are read at each `read` from the
 * turns in flight, never from the log: a start whose end was never logged, as when the server
 * stopped during the turn, runs nowhere once the process that held it is gone.
 */
export class TurnCounters {
  private readonly tokens = new Map<string, TurnTokenSeries>();
  private readonly turns = new Map<string, TurnSeries>();
  private readonly idle = new Map<string, IdleSeries>();
  private readonly failed = new Map<string, FailedSeries>();
  private readonly sendBacks = new Map<string, SendBackSeries>();
  /** Each scope and citizen that has started or ended a turn, whose running series is kept at 0. */
  private readonly ran = new Map<string, { project: string; agent: string }>();
  private readonly wakes: WakeLatency;

  /**
   * `cliOf` names a citizen's CLI for an end logged before ends named theirs: a turn runs on the
   * CLI its citizen's record names, which nothing changes after the citizen is added.
   * `actionsOf` gives the board actions of a turn whose end was logged before ends carried them,
   * read from its transcript, and null or nothing for a turn that kept none. `citizens` are those
   * a mention can name, read as each post is counted, so a map kept current names one added since.
   * `inFlight` gives the turns running now, read at each `read`.
   */
  constructor(
    private readonly cliOf: (agent: string) => CliKind | null,
    private readonly actionsOf: (turnId: string) => number | null | undefined = () => undefined,
    citizens: ReadonlyMap<string, MatchingCitizen> = new Map(),
    private readonly inFlight: () => readonly RunningTurn[] = () => [],
  ) {
    this.wakes = new WakeLatency(citizens);
  }

  /**
   * Counts a turn's end, `turn.completed` or `turn.failed`, a send-back, `task.moved`, and for the
   * wake latency a post, a turn's start, and a steer, notes the scope and citizen of a turn's start
   * and end, and passes over any other event.
   */
  add(event: BoardEvent): void {
    this.wakes.add(event);
    if (event.type === "turn.started") {
      const started = TurnStartedSchema.safeParse(event.payload);
      if (started.success) {
        this.noteRan(started.data.project, event.actor);
      }
      return;
    }
    if (event.type === "task.moved") {
      const moved = TaskMovedSchema.safeParse(event.payload);
      if (moved.success) {
        const { project } = moved.data;
        const by = event.actor;
        const key = JSON.stringify([project, by]);
        this.sendBacks.set(key, {
          project,
          by,
          sendBacks: (this.sendBacks.get(key)?.sendBacks ?? 0) + 1,
        });
      }
      return;
    }
    if (event.type !== "turn.completed" && event.type !== "turn.failed") {
      return;
    }
    const turn = TurnHistoryPayloadSchema.safeParse(event.payload);
    if (!turn.success) {
      return;
    }
    const agent = event.actor;
    const project = turn.data.project;
    this.noteRan(project, agent);
    const outcome = event.type === "turn.failed" ? "failed" : "completed";
    const trigger = turn.data.trigger;
    const counted = JSON.stringify([agent, outcome, trigger]);
    this.turns.set(counted, {
      agent,
      outcome,
      trigger,
      turns: (this.turns.get(counted)?.turns ?? 0) + 1,
    });
    const named = CliKindSchema.safeParse(event.payload["cli"]);
    const cli = (named.success ? named.data : this.cliOf(agent)) ?? UNKNOWN_LABEL;
    if (outcome === "failed") {
      const end = FailedEndSchema.parse(event.payload);
      const reason = failureReason({ ...turn.data, ...end });
      const key = JSON.stringify([agent, cli, reason]);
      this.failed.set(key, {
        agent,
        cli,
        reason,
        turns: (this.failed.get(key)?.turns ?? 0) + 1,
      });
    } else if (trigger !== "reflection") {
      // A turn with no transcript took actions nobody knows, so it is never idle.
      const actions =
        turn.data.boardActions ??
        (turn.data.turnId === undefined ? null : (this.actionsOf(turn.data.turnId) ?? null));
      if (actions === 0) {
        const key = JSON.stringify([agent, trigger]);
        this.idle.set(key, { agent, trigger, turns: (this.idle.get(key)?.turns ?? 0) + 1 });
      }
    }
    const usage = turn.data.usage;
    if (usage === undefined) {
      return;
    }
    const model = turn.data.model ?? UNKNOWN_LABEL;
    for (const kind of TOKEN_KINDS) {
      const key = JSON.stringify([project, agent, cli, model, kind]);
      this.tokens.set(key, {
        project,
        agent,
        cli,
        model,
        kind,
        tokens: (this.tokens.get(key)?.tokens ?? 0) + usage[USAGE_FIELD[kind]],
      });
    }
  }

  private noteRan(project: string, agent: string): void {
    const key = JSON.stringify([project, agent]);
    if (!this.ran.has(key)) {
      this.ran.set(key, { project, agent });
    }
  }

  /**
   * The turns in flight now by scope and citizen, with 0 for every scope and citizen that has run
   * a turn, so a series stays while nothing runs.
   */
  private running(): RunningSeries[] {
    const running = new Map<string, RunningSeries>();
    for (const [key, { project, agent }] of this.ran) {
      running.set(key, { project, agent, turns: 0 });
    }
    for (const { scope: project, agent } of this.inFlight()) {
      const key = JSON.stringify([project, agent]);
      running.set(key, { project, agent, turns: (running.get(key)?.turns ?? 0) + 1 });
    }
    return byKey(running);
  }

  /** The counts so far, in an order that holds from one read to the next. */
  read(): TurnCounts {
    return {
      tokens: byKey(this.tokens),
      turns: byKey(this.turns),
      running: this.running(),
      idle: byKey(this.idle),
      failed: byKey(this.failed),
      sendBacks: byKey(this.sendBacks),
      wakeLatency: this.wakes.latencies(),
      mentions: this.wakes.unanswered(),
    };
  }
}
