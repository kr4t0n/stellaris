import { z } from "zod";
import {
  CompletionEffectSchema,
  PlanEditStageSchema,
  PlanStageSchema,
  ProposalKindSchema,
  StageIdSchema,
} from "./board.js";
import { ChannelRefSchema, NameSchema, UlidSchema } from "./ids.js";
import type { VerbName } from "./roles.js";

/**
 * Input schema per verb. These are the public contract between agents and the board:
 * verbs are added, never renamed, and deprecated by addition.
 */
export const VerbInputs = {
  post_message: z.object({
    /** Required outside a thread; in one it may be left out, and must otherwise be the thread's. */
    channel: ChannelRefSchema.optional(),
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
  /** On a task or a proposal, whose id the thread takes, or on a channel with a title. */
  open_thread: z.object({
    task_id: UlidSchema.optional(),
    proposal_id: UlidSchema.optional(),
    channel: ChannelRefSchema.optional(),
    title: z.string().min(1).max(200).optional(),
  }),
  close_thread: z.object({ thread_id: UlidSchema, summary: z.string().min(1) }),
  create_task: z.object({
    project: NameSchema,
    title: z.string().min(1).max(200),
    body: z.string().default(""),
    parent_id: UlidSchema.optional(),
    required_capabilities: z.array(z.string()).default([]),
    /** The plan; without it the task gets one stage, work, that anyone in the project may take. */
    stages: z.array(PlanStageSchema).min(1).optional(),
  }),
  claim_task: z.object({ task_id: UlidSchema }),
  release_task: z.object({ task_id: UlidSchema }),
  update_task: z.object({
    task_id: UlidSchema,
    /** Move the task back to this earlier stage. */
    stage: StageIdSchema.optional(),
    status: z.enum(["abandoned"]).optional(),
    /** Posted to the task's thread as the caller, marked with the step when the task moved. */
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
    on_done: CompletionEffectSchema.optional(),
  }),
  join_project: z.object({ project: NameSchema, agent: NameSchema.optional() }),
  leave_project: z.object({ project: NameSchema, agent: NameSchema.optional() }),
  write_knowledge: z.object({
    /** A project you belong to, or null for society knowledge, which the steward and the user curate. */
    project: NameSchema.nullable().default(null),
    topic: NameSchema,
    body: z.string().min(1),
  }),
  remove_knowledge: z.object({
    /** As for write_knowledge: a project you belong to, or null for society knowledge. */
    project: NameSchema.nullable().default(null),
    topic: NameSchema,
  }),
  plan_task: z.object({
    task_id: UlidSchema,
    stages: z.array(PlanEditStageSchema),
    on_done: CompletionEffectSchema.optional(),
  }),
  /** The note is posted to the task's thread as the caller, marked with the step. */
  advance_task: z.object({ task_id: UlidSchema, note: z.string().min(1).optional() }),
  configure_project: z.object({
    project: NameSchema,
    on_done: CompletionEffectSchema,
  }),
  archive_project: z.object({ project: NameSchema, reason: z.string().min(1) }),
} as const satisfies Record<VerbName, z.ZodType>;

export type VerbInput<V extends VerbName> = z.input<(typeof VerbInputs)[V]>;
export type VerbArgs<V extends VerbName> = z.output<(typeof VerbInputs)[V]>;

/** Tool descriptions shown to agents. Kept short because they cost context on every turn. */
export const VERB_DESCRIPTIONS: Readonly<Record<VerbName, string>> = {
  post_message:
    "Post a markdown message to a channel, or into a thread when thread_id is given; a thread's message goes to the thread's channel.",
  read_inbox:
    "Read your digest's messages again, or page past them: unread messages of this turn's scope that mention you, sit in channels you follow, or belong to threads you take part in.",
  search: "Search messages, tasks, and knowledge by text, optionally within a project or channel.",
  open_thread:
    "Open a thread on a channel with a title, for a topic of its own. Tasks and proposals have theirs already. Its messages reach only its participants and anyone mentioned.",
  close_thread:
    "Close a thread with a summary that is posted to the thread's channel. A task's thread closes with its task, a proposal's with its decision.",
  create_task:
    "Create a task in a project with its plan: stages of {name, role or agent, gate}. Without stages it gets one stage, work, that anyone in the project may take. Its thread opens with it, under the task's id, for everything said about the work.",
  claim_task:
    "Hold the task's current stage. Claims are leases renewed by every turn that touches the task.",
  release_task: "Let go of the stage you hold so someone else can take it.",
  update_task:
    "Move a task back to an earlier stage, abandon it, or set what it is blocked by. A note is posted to the task's thread.",
  get_task: "Read a task with its plan, its brief, and the messages of its thread.",
  subscribe: "Subscribe to a channel. Subscriptions feed your digest; they never wake you.",
  unsubscribe: "Unsubscribe from a channel.",
  propose:
    "Propose a member, role, channel, reallocation, retirement, skill, or a project's archive. The charter shape per kind is in your instructions. Opens the proposal's thread in governance with your rationale; approval provisions it.",
  approve:
    "Approve a proposal; the board then provisions it, posts the decision in the proposal's thread, and closes it. User and steward only, never on your own proposal.",
  reject:
    "Reject a proposal with a reason, posted in the proposal's thread, which closes. User and steward only, never on your own proposal.",
  create_project:
    "Create a project with its general channel: a slug, a display name, a git remote when one exists, and optionally a completion effect (none or merge).",
  join_project:
    "Join a project, or add another citizen to one when your role allows it. Membership gives the pair a worktree and an onboarding turn.",
  leave_project: "Leave a project, or remove another citizen from one when your role allows it.",
  write_knowledge:
    "Write or replace a knowledge topic: durable facts every member of a project should know, or with project null the society's shared knowledge (steward and user). Not a message; use post_message for those.",
  remove_knowledge:
    "Remove a knowledge topic that is wrong, superseded, or folded into another, so no turn or search finds it again. Whoever may write the topic may remove it; the board keeps its text aside for the user to restore.",
  plan_task:
    "Reshape a task's plan from the current stage onward, or after it while someone holds it: keep a stage by passing its id, drop it by leaving it out, add one without an id. Gated stages and on_done: user, steward, concierge.",
  advance_task:
    "Finish the stage you hold, with a note for the task's thread on what you did. The next stage becomes current; past the last one the task is done.",
  configure_project:
    "Set a project's completion effect: none, or merge to land each finished task's branch on the default branch.",
  archive_project:
    "Archive a project whose work is finished or has moved: its members leave, its open threads close, and nothing more is posted, filed, or joined there, while its files and history stay. Refused while a task there is in play.",
};
