import { z } from "zod";
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
