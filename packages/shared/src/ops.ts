import { z } from "zod";
import { NameSchema, UlidSchema } from "./ids.js";

/**
 * Operations signal kinds. Each is a counter or a timer computed from board state and event
 * metadata, never from message content, and logged as an `ops.signal` event: no channel carries
 * it, the readers of signals find it in their prompt, and the user in the interface's log.
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
  "home_conflict",
] as const;
export const OpsSignalKindSchema = z.enum(OPS_SIGNAL_KINDS);
export type OpsSignalKind = z.infer<typeof OpsSignalKindSchema>;

/** The kinds that wake roles charted for `ops_event`; the rest wait for their next turn. */
export const WAKING_SIGNAL_KINDS: readonly OpsSignalKind[] = [
  "backlog",
  "role_gap",
  "churn",
  "stale_thread",
  "idle_member",
  "blocked_capability",
  "scaled",
];

export const OpsSignalSchema = z.object({
  kind: OpsSignalKindSchema,
  /** Identifies the condition, for example `backlog:demo:engineer`, so a persisting one is not logged again every pass. */
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
