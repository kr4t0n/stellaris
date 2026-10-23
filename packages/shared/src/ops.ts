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
  "stuck_workspace",
  "cron_failing",
] as const;
export const OpsSignalKindSchema = z.enum(OPS_SIGNAL_KINDS);
export type OpsSignalKind = z.infer<typeof OpsSignalKindSchema>;

/**
 * The kinds that wake roles charted for `ops_event`; the rest wait for their next turn. A signal
 * the operations pass logs carries `wakes`, which says whether that one log of it woke them.
 */
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
  /**
   * Whether this log of the condition wakes the roles charted for `ops_event`, as its publisher
   * decided: the operations pass wakes them when a condition is new, and again only at the steps
   * it names, not at every repeat. Absent, the kind decides.
   */
  wakes: z.boolean().optional(),
});
export type OpsSignal = z.infer<typeof OpsSignalSchema>;

const WAKING: ReadonlySet<OpsSignalKind> = new Set(WAKING_SIGNAL_KINDS);

/** Whether a logged signal wakes the roles charted for `ops_event`: as it is marked, else by its kind. */
export function signalWakes(signal: OpsSignal): boolean {
  return signal.wakes ?? WAKING.has(signal.kind);
}
