import { z } from "zod";
import {
  CompletionEffectSchema,
  DefaultBranchSchema,
  MergeSubjectSchema,
  PlanEditStageSchema,
  PlanStageSchema,
  ProposalKindSchema,
  PullRequestUrlSchema,
  StageIdSchema,
} from "./board.js";
import { CronExpressionSchema, TimeZoneSchema } from "./crons.js";
import { ChannelRefSchema, NameSchema, UlidSchema } from "./ids.js";
import type { VerbName } from "./roles.js";

/** A moment with its offset, such as 2026-10-12T09:00:00+08:00 or 2026-10-12T01:00:00Z. */
const MomentSchema = z.iso.datetime({ offset: true });

/** What a cron is called and what it asks of the turn it starts. */
const CronTitleSchema = z.string().trim().min(1).max(120);
const CronNoteSchema = z.string().trim().min(1).max(4_000);

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
    /** A channel of the project the task belongs to, such as a release's; its thread opens there. */
    channel: NameSchema.default("general"),
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
    /**
     * The pull request a `ghpr` task lands through, on its project's repository, with the merge
     * commit's subject and body; null unlinks it.
     */
    pull_request: z
      .object({
        url: PullRequestUrlSchema,
        merge_subject: MergeSubjectSchema.optional(),
        merge_body: z.string().max(20_000).optional(),
      })
      .nullable()
      .optional(),
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
    default_branch: DefaultBranchSchema.default("main"),
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
    on_done: CompletionEffectSchema.optional(),
    /** A new display name; the slug, which everything refers to the project by, never changes. */
    name: z.string().trim().min(1).max(120).optional(),
    /** The branch tasks start from and land on from now; tasks in play keep their branches. */
    default_branch: DefaultBranchSchema.optional(),
  }),
  archive_project: z.object({ project: NameSchema, reason: z.string().min(1) }),
  create_channel: z.object({
    /** A project, or null for a channel of the society. */
    project: NameSchema.nullable().default(null),
    name: NameSchema,
    purpose: z.string().min(1),
  }),
  archive_channel: z.object({ channel: ChannelRefSchema, reason: z.string().min(1) }),
  update_dashboard: z.object({
    project: NameSchema,
    /** The whole dashboard as markdown; the board keeps its frontmatter. */
    body: z.string().min(1),
    /** The `revision` in the frontmatter of the dashboard you read, 0 when it names none. */
    revision: z.number().int().min(0),
  }),
  create_cron: z.object({
    title: CronTitleSchema,
    /** What to do when it fires; quoted in the prompt of every turn it starts. */
    note: CronNoteSchema,
    /** Minute, hour, day of month, month, day of week, such as `0 9 * * 1-5`; or `at` instead. */
    cron: CronExpressionSchema.optional(),
    /** The IANA time zone `cron` is read in; the society's when left out. */
    timezone: TimeZoneSchema.optional(),
    /** One time to fire, instead of `cron`; the cron ends once it has fired. */
    at: MomentSchema.optional(),
    /** The citizen it wakes: yourself when left out. */
    agent: NameSchema.optional(),
    /** Where it fires: a project the citizen belongs to, or `society`; this turn's scope when left out. */
    project: NameSchema.optional(),
    /** An open thread there, whose conversation it fires in. */
    thread_id: UlidSchema.optional(),
    /** An open channel of that place other than general, whose conversation it fires in. */
    channel: NameSchema.optional(),
  }),
  update_cron: z.object({
    cron_id: UlidSchema,
    /** Pause it, or resume it, which starts its schedule afresh from now. */
    paused: z.boolean().optional(),
    title: CronTitleSchema.optional(),
    note: CronNoteSchema.optional(),
    /** A new expression, or `at` for one time; either starts the schedule afresh. */
    cron: CronExpressionSchema.optional(),
    /** The zone `cron` is read in; null for the society's. */
    timezone: TimeZoneSchema.nullable().optional(),
    at: MomentSchema.optional(),
  }),
  remove_cron: z.object({ cron_id: UlidSchema, reason: z.string().trim().min(1) }),
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
    "Create a task in a project with its plan: stages of {name, role or agent, gate}. Without stages it gets one stage, work, that anyone in the project may take. File it in a channel of the project, such as a release's, or general by default; its thread opens there with it, under the task's id, for everything said about the work.",
  claim_task:
    "Hold the task's current stage. Claims are leases renewed by every turn that touches the task.",
  release_task: "Let go of the stage you hold so someone else can take it.",
  update_task:
    "Move a task back to an earlier stage, abandon it, set what it is blocked by, or link its pull request (pull_request: url, with the merge commit's merge_subject and merge_body), which a ghpr task needs before its last stage completes. A note is posted to the task's thread.",
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
    "Create a project with its general channel: a slug, a display name, a git remote when one exists, and optionally a completion effect (none, merge, or ghpr for a GitHub remote).",
  join_project:
    "Join a project, or add another citizen to one when your role allows it. Membership gives the pair a worktree and an onboarding turn, and follows the project's general; the result lists its other open channels, to subscribe to when the work needs them.",
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
    "Set a project's completion effect (none; merge to land each finished task's branch on the default branch; ghpr, for a project on GitHub, to merge each finished task's linked pull request), its display name, or its default branch, any of them at once. Tasks already filed keep theirs. The slug never changes.",
  archive_project:
    "Archive a project whose work is finished or has moved: its members leave, its open threads close, and nothing more is posted, filed, or joined there, while its files and history stay. Refused while a task there is in play.",
  create_channel:
    "Open a channel in a project, or with project null in the society, for a workstream such as a release, whose tasks are filed there. You follow it; a notice in the place's general announces it, and members subscribe when it concerns them. User, steward, concierge.",
  archive_channel:
    "Archive a channel whose workstream is done: its open threads close, its followers stop following it, and nothing more is posted or filed there, while its history stays readable. Refused while a task filed there is in play, and for the channels the board itself uses. User, steward, concierge.",
  update_dashboard:
    "Replace the dashboard of a project you are a member of, the status page the user reads on its view, with a whole markdown body. Pass the revision from the frontmatter of the dashboard you read; if it was updated since, the call is refused with the current text to merge yours into. dashboard.md in the board projection is a copy, so editing it changes nothing.",
  create_cron:
    "Set a cron that wakes you later: a title, a note on what to do then, and either cron, a five-field expression (minute hour day-of-month month day-of-week) read in timezone or the society's, or at, one time. It fires in this turn's conversation unless you name a project, thread_id, or channel, at most every 15 minutes, and every fire is a turn. Only the user, the steward, and the concierge set one that wakes another citizen (agent).",
  update_cron:
    "Pause or resume a cron, or change its title, note, or schedule; resuming or rescheduling starts it afresh from now. Yours, or anyone's for the user, the steward, and the concierge.",
  remove_cron:
    "End a cron for good, with a reason. Yours, or anyone's for the user, the steward, and the concierge. A cron also ends with its conversation, and a one-time cron once it fires.",
};
