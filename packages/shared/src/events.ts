import { z } from "zod";
import { IsoDateTimeSchema, NameSchema, UlidSchema } from "./ids.js";

/** Events the board core appends to its log. */
export const BOARD_EVENT_TYPES = [
  "society.initialized",
  "project.added",
  "project.configured",
  "agent.added",
  "agent.configured",
  "message.posted",
  "thread.opened",
  "thread.closed",
  "task.created",
  "task.claimed",
  "task.released",
  "task.updated",
  "task.planned",
  "task.advanced",
  "task.moved",
  "task.completing",
  "task.completed",
  "task.reopened",
  "lease.expired",
  "subscription.changed",
  "proposal.created",
  "proposal.decided",
  "proposal.provisioned",
  "channel.added",
  "role.added",
  "agent.retired",
  "agent.joined",
  "agent.left",
  "knowledge.written",
  "skill.promoted",
  "runner.changed",
  "ops.signal",
  "paused.changed",
  "wake.requested",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "merge.completed",
  "merge.failed",
] as const;
export const BoardEventTypeSchema = z.enum(BOARD_EVENT_TYPES);
export type BoardEventType = z.infer<typeof BoardEventTypeSchema>;

export const BoardEventSchema = z.object({
  id: UlidSchema,
  ts: IsoDateTimeSchema,
  type: BoardEventTypeSchema,
  actor: NameSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type BoardEvent = z.infer<typeof BoardEventSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
});
export type Usage = z.infer<typeof UsageSchema>;

/** The structured object every turn ends with. The scheduler reads this, never prose. */
export const TurnStatusSchema = z.object({
  summary: z.string().min(1),
  claimsHeld: z.array(UlidSchema).default([]),
  blockedOn: z.array(z.string()).default([]),
  needsUserDecision: z.boolean().default(false),
  memoryUpdated: z.boolean().default(false),
});
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const TurnExitReasonSchema = z.enum([
  "completed",
  "timeout",
  "error",
  "interrupted",
  "blocked",
]);
export type TurnExitReason = z.infer<typeof TurnExitReasonSchema>;

/** One event vocabulary for every CLI. Adapters map their native streams onto this union. */
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("turn_started"),
    agent: NameSchema,
    session: z.string(),
    runner: NameSchema,
    /** The model the CLI reports running, when it reports one. */
    model: z.string().optional(),
  }),
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({ type: z.literal("tool_call"), name: z.string(), input: z.unknown() }),
  z.object({
    type: z.literal("tool_result"),
    name: z.string(),
    ok: z.boolean(),
    /** What the tool returned, cut to `OUTPUT_LIMIT` characters by `capOutput`. */
    output: z.string().optional(),
  }),
  z.object({ type: z.literal("approval_requested"), kind: z.string(), detail: z.unknown() }),
  z.object({
    type: z.literal("turn_completed"),
    usage: UsageSchema,
    costUsd: z.number().nonnegative(),
    status: TurnStatusSchema.nullable(),
    exitReason: TurnExitReasonSchema,
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/**
 * One agent event as the board server streams it live: which agent produced it, in which scope
 * (a project slug or `society`), numbered in a sequence that restarts with the server.
 */
/** The most of one tool's output a turn keeps. */
export const OUTPUT_LIMIT = 4_000;

/** A tool's output within `limit`, keeping its start and its end, where failures usually show. */
export function capOutput(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n… ${text.length - 2 * half} characters cut …\n${text.slice(-half)}`;
}

/** One step of a finished turn as its transcript keeps it, stamped when the runner received it. */
export const TranscriptEntrySchema = z.object({
  ts: IsoDateTimeSchema,
  event: AgentEventSchema,
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const LiveTurnEventSchema = z.object({
  seq: z.number().int().positive(),
  ts: IsoDateTimeSchema,
  agent: NameSchema,
  project: NameSchema,
  event: AgentEventSchema,
});
export type LiveTurnEvent = z.infer<typeof LiveTurnEventSchema>;
