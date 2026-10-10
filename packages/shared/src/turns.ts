import { z } from "zod";
import { CliKindSchema, SOCIETY_SCOPE } from "./board.js";
import { TurnExitReasonSchema, TurnStatusSchema, UsageSchema } from "./events.js";
import { ChannelRefSchema, IsoDateTimeSchema, NameSchema, UlidSchema } from "./ids.js";
import { TurnWorkSchema } from "./runner.js";

/**
 * What caused a wake. `stage`: a stage became current and is the member's to take. `task_done`: a
 * task the member created is done. `proposal_decided`: a proposal the member made was approved or
 * rejected. `cron`: a cron set for the member came due.
 */
export const TriggerKindSchema = z.enum([
  "mention",
  "stage",
  "task_done",
  "proposal_decided",
  "heartbeat",
  "reflection",
  "onboarding",
  "manual",
  "ops_event",
  "user_post",
  "closing",
  "cron",
]);
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

export const TriggerSchema = z.object({
  kind: TriggerKindSchema,
  from: NameSchema.optional(),
  fromUser: z.boolean().default(false),
  reason: z.string().default(""),
  taskId: UlidSchema.optional(),
  messageId: UlidSchema.optional(),
  /** The channel the waking message was posted in. */
  channel: ChannelRefSchema.optional(),
  /** The cron that came due, for a `cron` wake. */
  cronId: UlidSchema.optional(),
});
export type Trigger = z.infer<typeof TriggerSchema>;
export type TriggerInput = z.input<typeof TriggerSchema>;

/**
 * The thread a turn's conversation is: its id, and whether it is a task's thread in the turn's own
 * project, whose turns get a worktree of their own on the task's branch and may run beside others.
 */
export const TurnThreadSchema = z.object({ id: UlidSchema, task: z.boolean() });
export type TurnThread = z.infer<typeof TurnThreadSchema>;

/**
 * What the scheduler hands a runner: one agent, one project, one conversation, one reason. With
 * `thread` the turn is in that thread's conversation, with `channel` in the conversation of that
 * channel of the place, never its general, and without either in the agent's home conversation for
 * the scope, which general's posts and work tied to no channel or thread go to.
 */
export const TurnDispatchSchema = z.object({
  agent: NameSchema,
  project: NameSchema,
  thread: TurnThreadSchema.optional(),
  channel: NameSchema.optional(),
  trigger: TriggerSchema,
  priority: z.number().int().min(0).max(2),
  onboarding: z.boolean().default(false),
  /** Every cron that came due for this turn, whatever wake it merged into; its prompt quotes each. */
  crons: z.array(UlidSchema).optional(),
});
export type TurnDispatch = z.infer<typeof TurnDispatchSchema>;

/**
 * Which conversation of a scope: a thread's by its id, a channel's other than general as
 * `#channel`, or the home conversation as undefined. The `#` keeps a channel apart from a thread.
 */
export function conversationPart(conversation: {
  readonly thread?: string | undefined;
  readonly channel?: string | undefined;
}): string | undefined {
  return (
    conversation.thread ??
    (conversation.channel === undefined ? undefined : `#${conversation.channel}`)
  );
}

/**
 * A session's key: `agent/scope` for the home conversation, `agent/scope/thread` for a thread's,
 * and `agent/scope/#channel` for a channel's; `part` is what `conversationPart` gives.
 */
export function sessionKey(agent: string, scope: string, part?: string): string {
  return part === undefined ? `${agent}/${scope}` : `${agent}/${scope}/${part}`;
}

/** The parts of a session key, or null for anything else. */
export function parseSessionKey(
  key: string,
): { agent: string; scope: string; thread?: string; channel?: string } | null {
  const [agent, scope, part, rest] = key.split("/");
  if (agent === undefined || scope === undefined || rest !== undefined) {
    return null;
  }
  if (part === undefined) {
    return { agent, scope };
  }
  return part.startsWith("#")
    ? { agent, scope, channel: part.slice(1) }
    : { agent, scope, thread: part };
}

/**
 * The channel conversation a top-level post in `channel` is filed in for a citizen woken in
 * `scope`: the channel's name when it belongs to that scope's place and is not its general, else
 * undefined for the scope's home, as for a post in a project the citizen is not in.
 */
export function channelConversation(scope: string, channel: string): string | undefined {
  const at = channel.indexOf("/");
  const place = at < 0 ? SOCIETY_SCOPE : channel.slice(0, at);
  const name = at < 0 ? channel : channel.slice(at + 1);
  return place === scope && name !== "general" ? name : undefined;
}

/** The record a runner writes for every turn. The last one is what the next turn opens with. */
export const TurnRecordSchema = z.object({
  /** Assigned by the board when the turn begins; the turn's transcript is filed under it. */
  id: UlidSchema.optional(),
  agent: NameSchema,
  project: NameSchema,
  /** The thread whose conversation the turn was in; absent for the home conversation. */
  thread: UlidSchema.optional(),
  /** The channel, never general, whose conversation the turn was in. */
  channel: NameSchema.optional(),
  runner: NameSchema,
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
  /**
   * The running total the CLI reported for the session after this turn, when it reports one. A
   * resumed session starts from it, so the next turn's own cost is measured from here.
   */
  sessionCostUsd: z.number().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().default(0),
  /** The model the CLI reported for this turn, else the model configured for the agent, else null. */
  model: z.string().nullable().default(null),
  /** The task branch the turn left work on, with its commit, as the runner reported it. */
  work: TurnWorkSchema.optional(),
  /** Who stopped the turn, for one that ended `stopped`. */
  stoppedBy: NameSchema.optional(),
  /** The crons whose fire started the turn, which record how it ended. */
  crons: z.array(UlidSchema).optional(),
});
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

/**
 * A turn in flight as the interface sees it: its conversation, and whether its runner can deliver
 * a post into it or stop it. `askedIn` is the channel its wake came from, where a mention reaches
 * a home conversation's turn.
 */
export const RunningTurnSchema = z.object({
  turnId: UlidSchema,
  agent: NameSchema,
  scope: NameSchema,
  thread: UlidSchema.optional(),
  channel: NameSchema.optional(),
  cli: CliKindSchema,
  askedIn: ChannelRefSchema.optional(),
  steerable: z.boolean(),
  stoppable: z.boolean(),
});
export type RunningTurn = z.infer<typeof RunningTurnSchema>;

/** Session ids per CLI for one conversation, and the runner where they began, which keeps them. */
export const SessionsFileSchema = z.object({
  claude: z.string().optional(),
  codex: z.string().optional(),
  runner: NameSchema.optional(),
});
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

/** One finished turn as the event log recorded it: an entry in a citizen's turn history. */
export const TurnHistoryEntrySchema = z.object({
  /** The id of the event that ended the turn. */
  id: UlidSchema,
  /** The turn's own id, when it has a transcript to open; turns before transcripts have none. */
  turnId: UlidSchema.optional(),
  ts: IsoDateTimeSchema,
  outcome: z.enum(["completed", "failed"]),
  /** A project slug, or the society scope. */
  project: NameSchema,
  /** The thread whose conversation the turn was in; absent for the home conversation. */
  thread: UlidSchema.optional(),
  /** The channel, never general, whose conversation the turn was in. */
  channel: NameSchema.optional(),
  trigger: z.string(),
  exitReason: z.string().nullable(),
  costUsd: z.number(),
  /** The tokens the turn used; absent for turns logged before turns recorded them. */
  usage: UsageSchema.optional(),
  model: z.string().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  /** When the log recorded the turn's start; absent when the start is missing from the log. */
  startedAt: IsoDateTimeSchema.optional(),
  toolCalls: z.number().int().nonnegative().optional(),
});
export type TurnHistoryEntry = z.infer<typeof TurnHistoryEntrySchema>;
