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
  create_project: z.object({
    slug: NameSchema,
    name: z.string().min(1).optional(),
    repo: z.string().min(1).nullable().default(null),
    default_branch: z.string().min(1).default("main"),
  }),
  join_project: z.object({ project: NameSchema, agent: NameSchema.optional() }),
  leave_project: z.object({ project: NameSchema, agent: NameSchema.optional() }),
  write_knowledge: z.object({
    /** A project you belong to, or null for society knowledge, which the steward and the user curate. */
    project: NameSchema.nullable().default(null),
    topic: NameSchema,
    body: z.string().min(1),
  }),
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
  propose:
    "Propose a member, role, channel, reallocation, or retirement. The charter shape per kind is in your instructions; approval provisions it.",
  approve:
    "Approve a proposal; the board then provisions it. User and steward only, never on your own proposal.",
  reject: "Reject a proposal with a reason. User and steward only, never on your own proposal.",
  create_project:
    "Create a project with its default channels. Give it a slug, a display name, and a git remote when one exists.",
  join_project:
    "Join a project, or add another citizen to one when your role allows it. Membership gives the pair a worktree and an onboarding turn.",
  leave_project: "Leave a project, or remove another citizen from one when your role allows it.",
  write_knowledge:
    "Write or replace a knowledge topic: durable facts every member of a project should know, or with project null the society's shared knowledge (steward and user). Not a message; use post_message for those.",
};
