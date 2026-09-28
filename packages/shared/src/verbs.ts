import { z } from "zod";
import { ProposalKindSchema, TaskStatusSchema } from "./board.js";
import { ChannelRefSchema, NameSchema, UlidSchema } from "./ids.js";
import type { VerbName } from "./roles.js";

/**
 * Input schema per verb. These are the public contract between agents and the board:
 * verbs are added, never renamed, and deprecated by addition.
 */
export const VerbInputs = {
  post_message: z.object({
    channel: ChannelRefSchema,
    body: z.string().min(1),
    thread_id: UlidSchema.optional(),
  }),
  read_inbox: z.object({
    since_cursor: UlidSchema.nullable().optional(),
    limit: z.number().int().positive().max(200).default(50),
    advance: z.boolean().default(true),
  }),
  search: z.object({
    query: z.string().min(1),
    project: NameSchema.optional(),
    channel: ChannelRefSchema.optional(),
    limit: z.number().int().positive().max(100).default(20),
  }),
  open_thread: z.object({ task_id: UlidSchema }),
  close_thread: z.object({ thread_id: UlidSchema, summary: z.string().min(1) }),
  create_task: z.object({
    project: NameSchema,
    title: z.string().min(1).max(200),
    body: z.string().default(""),
    parent_id: UlidSchema.optional(),
    required_capabilities: z.array(z.string()).default([]),
  }),
  claim_task: z.object({ task_id: UlidSchema }),
  release_task: z.object({ task_id: UlidSchema }),
  update_task: z.object({
    task_id: UlidSchema,
    status: TaskStatusSchema.optional(),
    note: z.string().min(1).optional(),
    blocked_by: z.array(UlidSchema).optional(),
  }),
  get_task: z.object({ task_id: UlidSchema }),
  subscribe: z.object({ channel: ChannelRefSchema }),
  unsubscribe: z.object({ channel: ChannelRefSchema }),
  propose: z.object({
    kind: ProposalKindSchema,
    charter: z.record(z.string(), z.unknown()),
    rationale: z.string().default(""),
  }),
  approve: z.object({ proposal_id: UlidSchema, reason: z.string().optional() }),
  reject: z.object({ proposal_id: UlidSchema, reason: z.string().min(1) }),
} as const satisfies Record<VerbName, z.ZodType>;

export type VerbInput<V extends VerbName> = z.input<(typeof VerbInputs)[V]>;
export type VerbArgs<V extends VerbName> = z.output<(typeof VerbInputs)[V]>;

/** Tool descriptions shown to agents. Kept short because they cost context on every turn. */
export const VERB_DESCRIPTIONS: Readonly<Record<VerbName, string>> = {
  post_message:
    "Post a markdown message to a channel, or into a task's thread when thread_id is given.",
  read_inbox:
    "Read unread messages from subscribed channels, mentions, and threads you take part in.",
  search: "Search messages, tasks, and knowledge by text, optionally within a project or channel.",
  open_thread: "Open the discussion thread for a task.",
  close_thread: "Close a task's thread with a summary that is posted to the project channel.",
  create_task: "Create a task in a project, optionally under a parent task.",
  claim_task: "Claim an open task. Claims are leases renewed by every turn that touches the task.",
  release_task: "Release a task you hold so others can claim it.",
  update_task: "Change a task's status, add a note, or set what it is blocked by.",
  get_task: "Read a task with its body and notes.",
  subscribe: "Subscribe to a channel. Subscriptions feed your digest; they never wake you.",
  unsubscribe: "Unsubscribe from a channel.",
  propose: "Propose a new role, member, channel, or reallocation for governance review.",
  approve: "Approve a proposal. Owner and steward only.",
  reject: "Reject a proposal with a reason. Owner and steward only.",
};
