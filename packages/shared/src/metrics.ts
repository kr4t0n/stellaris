import { z } from "zod";
import { UsageSchema } from "./events.js";
import { IsoDateTimeSchema, NameSchema, UlidSchema } from "./ids.js";
import type { VerbName } from "./roles.js";

/** How far back the metrics look: a day, a week, or the whole log. */
export const MetricsWindowSchema = z.enum(["24h", "7d", "all"]);
export type MetricsWindow = z.infer<typeof MetricsWindowSchema>;

export const METRICS_WINDOW_MS: Readonly<Record<MetricsWindow, number | null>> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  all: null,
};

/** Verbs that only read; every other verb changes the board. */
export const READ_VERBS: readonly VerbName[] = ["read_inbox", "search", "get_task"];

/**
 * Whether a tool call, as a turn's transcript names it, changed the board: a board verb other than
 * a read. Both CLIs name a board verb `mcp__board__<verb>`.
 */
export function isBoardAction(tool: string): boolean {
  const verb = /^mcp__board__(.+)$/.exec(tool)?.[1];
  return verb !== undefined && !READ_VERBS.some((read) => read === verb);
}

const CountSchema = z.number().int().nonnegative();
const MsSchema = z.number().nonnegative();

/**
 * What the society did in a window, counted from the event log and the turns' transcripts, for
 * judging the charters by. Every figure is mechanical; none reads a message's words.
 */
export const MetricsSchema = z.object({
  window: MetricsWindowSchema,
  since: IsoDateTimeSchema.nullable(),
  until: IsoDateTimeSchema,
  /**
   * Finished turns that changed nothing on the board. Reflections are left out, since they write
   * memory, not the board; turns without a transcript are counted apart, their actions unknown.
   */
  idle: z.object({
    turns: CountSchema,
    idle: CountSchema,
    unknown: CountSchema,
    byTrigger: z.array(z.object({ trigger: z.string(), turns: CountSchema, idle: CountSchema })),
    byAgent: z.array(
      z.object({
        agent: NameSchema,
        role: NameSchema.nullable(),
        turns: CountSchema,
        idle: CountSchema,
      }),
    ),
  }),
  /** Work sent back to an earlier stage: over the tasks finished in the window, and by where. */
  sentBack: z.object({
    finished: CountSchema,
    sendBacks: CountSchema,
    tasksSentBack: CountSchema,
    byStage: z.array(z.object({ project: NameSchema, stage: z.string(), count: CountSchema })),
    bySender: z.array(z.object({ agent: NameSchema, count: CountSchema })),
  }),
  /** Posts in the threads of the tasks finished in the window, the board's own notices left out. */
  messages: z.object({
    finished: CountSchema,
    messages: CountSchema,
    byProject: z.array(
      z.object({ project: NameSchema, finished: CountSchema, messages: CountSchema }),
    ),
    busiest: z.array(
      z.object({
        taskId: UlidSchema,
        title: z.string(),
        project: NameSchema,
        messages: CountSchema,
      }),
    ),
  }),
  /** Time from a mention to the start of the turn it woke, in the conversation it was made in. */
  latency: z.object({
    mentions: CountSchema,
    /** Mentions no turn has followed yet. */
    unanswered: CountSchema,
    medianMs: MsSchema.nullable(),
    slowestMs: MsSchema.nullable(),
    byAgent: z.array(
      z.object({
        agent: NameSchema,
        mentions: CountSchema,
        medianMs: MsSchema,
        slowestMs: MsSchema,
      }),
    ),
  }),
  /** The user's decisions: proposals decided, questions answered, and stages passed or sent back. */
  decisions: z.object({
    total: CountSchema,
    byDay: z.array(
      z.object({
        day: z.string(),
        proposals: CountSchema,
        answers: CountSchema,
        stages: CountSchema,
      }),
    ),
  }),
  /** Tasks that needed a capability no connected runner offered, and whether they still do. */
  blocked: z.array(
    z.object({
      taskId: UlidSchema,
      title: z.string().nullable(),
      project: NameSchema.nullable(),
      summary: z.string(),
      firstAt: IsoDateTimeSchema,
      lastAt: IsoDateTimeSchema,
      holds: z.boolean(),
    }),
  ),
});
export type Metrics = z.infer<typeof MetricsSchema>;

/**
 * The turns a citizen finished in a window, by the time each one's end was logged, and the tokens
 * of those that counted them. A turn logged before turns counted tokens has none, and so does one
 * that ended without its runner's report, as when the runner went away during it; `usage` is the
 * sum over the `withUsage` turns alone, and null when none counted.
 */
export const CitizenTokensSchema = z.object({
  agent: NameSchema,
  turns: CountSchema,
  withUsage: CountSchema,
  usage: UsageSchema.nullable(),
});
export type CitizenTokens = z.infer<typeof CitizenTokensSchema>;

/** Each citizen's tokens over a window, from the event log; a citizen with no turn in it has no entry. */
export const TokenUseSchema = z.object({
  window: MetricsWindowSchema,
  since: IsoDateTimeSchema.nullable(),
  until: IsoDateTimeSchema,
  citizens: z.array(CitizenTokensSchema),
});
export type TokenUse = z.infer<typeof TokenUseSchema>;
