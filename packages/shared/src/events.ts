import { z } from "zod";
import { IsoDateTimeSchema, NameSchema, UlidSchema } from "./ids.js";

/** Events the board core appends to its log. The scheduler and the UI read these; nothing else does. */
export const BOARD_EVENT_TYPES = [
  "society.initialized",
  "project.added",
  "agent.added",
  "message.posted",
  "thread.opened",
  "thread.closed",
  "task.created",
  "task.claimed",
  "task.released",
  "task.updated",
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
  needsOwnerDecision: z.boolean().default(false),
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
  z.object({ type: z.literal("tool_result"), name: z.string(), ok: z.boolean() }),
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
