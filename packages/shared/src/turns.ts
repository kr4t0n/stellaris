import { z } from "zod";
import { CliKindSchema } from "./board.js";
import { TurnExitReasonSchema, TurnStatusSchema, UsageSchema } from "./events.js";
import { IsoDateTimeSchema, NameSchema, UlidSchema } from "./ids.js";

/** What caused a wake to be considered. Mentions and claim events wake; subscriptions never do. */
export const TriggerKindSchema = z.enum([
  "mention",
  "claim_event",
  "heartbeat",
  "unclaimed_task",
  "reflection",
  "onboarding",
  "manual",
  "ops_event",
  "user_post",
]);
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

export const TriggerSchema = z.object({
  kind: TriggerKindSchema,
  from: NameSchema.optional(),
  fromUser: z.boolean().default(false),
  reason: z.string().default(""),
  taskId: UlidSchema.optional(),
  messageId: UlidSchema.optional(),
});
export type Trigger = z.infer<typeof TriggerSchema>;
export type TriggerInput = z.input<typeof TriggerSchema>;

/** What the scheduler hands a runner: one agent, one project, one reason. */
export const TurnDispatchSchema = z.object({
  agent: NameSchema,
  project: NameSchema,
  trigger: TriggerSchema,
  priority: z.number().int().min(0).max(2),
  onboarding: z.boolean().default(false),
});
export type TurnDispatch = z.infer<typeof TurnDispatchSchema>;

/** The record a runner writes for every turn. The last one is what the next turn opens with. */
export const TurnRecordSchema = z.object({
  agent: NameSchema,
  project: NameSchema,
  runner: NameSchema.default("local"),
  cli: CliKindSchema.nullable(),
  session: z.string().nullable(),
  trigger: TriggerSchema,
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.nullable(),
  exitReason: TurnExitReasonSchema.nullable(),
  status: TurnStatusSchema.nullable(),
  error: z.string().nullable(),
  usage: UsageSchema.nullable(),
  costUsd: z.number().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  /** The model the CLI reported for this turn, else the model configured for the agent, else null. */
  model: z.string().nullable().default(null),
});
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

/** Session ids per CLI for one agent-project pair, pinned to the runner where they began. */
export const SessionsFileSchema = z.record(z.string(), z.string());
export type SessionsFile = z.infer<typeof SessionsFileSchema>;

export const WakeRequestSchema = z.object({
  agent: NameSchema,
  project: NameSchema,
  reason: z.string().default("manual wake"),
  /** A manual wake, or a reflection turn requested ahead of the cadence. */
  kind: z.enum(["manual", "reflection"]).default("manual"),
});
export type WakeRequestInput = z.input<typeof WakeRequestSchema>;

/**
 * The JSON Schema handed to a CLI's structured-output option so every turn ends with a status object.
 * Draft 7 without a `$schema` key: Claude Code's validator rejects the 2020-12 dialect reference.
 */
export function turnStatusJsonSchema(): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    ...z.toJSONSchema(TurnStatusSchema, { target: "draft-7" }),
  };
  delete schema["$schema"];
  return schema;
}
