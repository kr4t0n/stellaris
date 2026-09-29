import { z } from "zod";
import { NameSchema, UlidSchema } from "./ids.js";

/**
 * Operations signal kinds. Each is a counter or a timer computed from board state and event
 * metadata, never from message content, and posted to the society's ops channel.
 */
export const OPS_SIGNAL_KINDS = [
  "waiting_stage",
  "backlog",
  "role_gap",
  "churn",
  "stale_thread",
  "idle_member",
  "blocked_capability",
  "turn_cost",
  "scaled",
  "runner",
] as const;
export const OpsSignalKindSchema = z.enum(OPS_SIGNAL_KINDS);
export type OpsSignalKind = z.infer<typeof OpsSignalKindSchema>;

export const OpsSignalSchema = z.object({
  kind: OpsSignalKindSchema,
  /** Identifies the condition, for example `backlog:demo:engineer`, so a persisting one is not re-posted every pass. */
  key: z.string().min(1),
  /** One line a reader can act on. */
  summary: z.string().min(1),
  /** The counter or timer value behind the signal. */
  value: z.number(),
  threshold: z.number().optional(),
  project: NameSchema.optional(),
  agent: NameSchema.optional(),
  role: NameSchema.optional(),
  taskId: UlidSchema.optional(),
});
export type OpsSignal = z.infer<typeof OpsSignalSchema>;
