import { z } from "zod";
import {
  channelRef,
  ChannelRefSchema,
  IsoDateTimeSchema,
  NameSchema,
  UlidSchema,
  type Name,
} from "./ids.js";
import { RoleCharterSchema, USER_ROLE } from "./roles.js";

/**
 * The society channel the user's asks open their threads on, which the front desk follows. It
 * keeps their closing summaries out of general, which every citizen reads.
 */
export const ASK_CHANNEL = "asks";
export const SOCIETY_CHANNELS = ["general", "governance", ASK_CHANNEL] as const;
export const PROJECT_DEFAULT_CHANNELS = ["general"] as const;

/**
 * The scope of a turn that belongs to no project. Dispatches, sessions, and turn records use it in
 * place of a project slug, and the runner uses the agent's home as the working directory. No
 * project may take the name.
 */
export const SOCIETY_SCOPE = "society";

/**
 * Where a citizen takes a turn for something in `project`, or in a society channel when it is
 * null: where it was asked, so that project when the citizen belongs to it, and otherwise the
 * society scope, outside any project, with a context of its own. The scheduler wakes by it and the
 * board files the digest by it, so a turn reads what it was woken for and nothing another turn of
 * the same citizen, in another scope, will read.
 */
export function wakeScope(
  member: { readonly memberships: readonly string[] },
  project: string | null,
): string {
  return project !== null && member.memberships.includes(project) ? project : SOCIETY_SCOPE;
}

export const CliKindSchema = z.enum(["claude", "codex"]);
export type CliKind = z.infer<typeof CliKindSchema>;

export const SocietySchema = z.object({
  name: z.string().min(1),
  version: z.literal(1),
  createdAt: IsoDateTimeSchema,
  channels: z.array(NameSchema),
});
export type Society = z.infer<typeof SocietySchema>;

/** What the board does when a task's last stage completes: nothing, or land the task's branch. */
export const CompletionEffectSchema = z.enum(["none", "merge"]);
export type CompletionEffect = z.infer<typeof CompletionEffectSchema>;

export const StageIdSchema = z.string().regex(/^s[1-9][0-9]*$/, "expected a stage id such as s1");
export type StageId = z.infer<typeof StageIdSchema>;

const stageFields = {
  name: z.string().trim().min(1).max(120),
  role: NameSchema.optional(),
  agent: NameSchema.optional(),
  gate: z.boolean().default(false),
};

function oneAssignee(stage: { role?: string | undefined; agent?: string | undefined }): boolean {
  return stage.role === undefined || stage.agent === undefined;
}

const ONE_ASSIGNEE = { message: "a stage names a role or an agent, not both" };

/** A stage as a plan is written: a name, at most one assignee, and an optional gate. */
export const PlanStageSchema = z.object(stageFields).refine(oneAssignee, ONE_ASSIGNEE);
export type PlanStageInput = z.input<typeof PlanStageSchema>;
export type PlanStage = z.output<typeof PlanStageSchema>;

/** A stage passed to `plan_task`: with the id of a stage to keep, or without one for a new stage. */
export const PlanEditStageSchema = z
  .object({ id: StageIdSchema.optional(), ...stageFields })
  .refine(oneAssignee, ONE_ASSIGNEE);
export type PlanEditStage = z.output<typeof PlanEditStageSchema>;

export const PlanSchema = z.array(PlanStageSchema);
export const PlanEditSchema = z.array(PlanEditStageSchema);

export const ProjectSchema = z.object({
  slug: NameSchema,
  name: z.string().min(1),
  repo: z.string().nullable(),
  defaultBranch: z.string().min(1),
  channels: z.array(NameSchema),
  members: z.array(NameSchema),
  approvers: z.array(NameSchema),
  requiredCapabilities: z.array(z.string()),
  createdAt: IsoDateTimeSchema,
  onDone: CompletionEffectSchema.default("none"),
  /** The runner the project lives on, which holds its repository; set on the project's first turn. */
  runner: NameSchema.optional(),
  /** Set once the project is archived: nobody belongs to it, and nothing more is posted, filed, or joined there. */
  archived: z
    .object({ at: IsoDateTimeSchema, by: NameSchema, reason: z.string().min(1) })
    .optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * What a task verb did, on the post it made of its note in the task's thread: the stage it acted
 * at, and where the task went, the next stage or the one it was sent back to, or null once it left
 * its plan. `landed` and `reopened` are the board's, for a completion effect that ran or failed.
 */
export const TaskStepSchema = z.object({
  action: z.enum(["advanced", "returned", "abandoned", "landed", "reopened"]),
  stage: StageIdSchema,
  to: StageIdSchema.nullable(),
});
export type TaskStep = z.infer<typeof TaskStepSchema>;

/** The decision on a proposal, on the post the deciding verb made in the proposal's thread. */
export const ProposalStepSchema = z.object({ action: z.enum(["approved", "rejected"]) });
export type ProposalStep = z.infer<typeof ProposalStepSchema>;

/** What a verb recorded on the post it made in its subject's thread. */
export const MessageStepSchema = z.union([TaskStepSchema, ProposalStepSchema]);
export type MessageStep = z.infer<typeof MessageStepSchema>;

/** Whether a step is a task's, which names the stages it moved between. */
export function isTaskStep(step: MessageStep): step is TaskStep {
  return "stage" in step;
}

/** Message frontmatter. The author is stamped by the board, never supplied by the caller. */
export const MessageFrontmatterSchema = z.object({
  id: UlidSchema,
  author: NameSchema,
  channel: ChannelRefSchema,
  thread: UlidSchema.optional(),
  /** On a summary post, the task whose thread it closed. Written by older builds; see `closes`. */
  task: UlidSchema.optional(),
  /** On a summary post, the thread it closed. */
  closes: UlidSchema.optional(),
  /** On a post a task verb made in the task's thread, or a decision in a proposal's: the step it recorded. */
  step: MessageStepSchema.optional(),
  ts: IsoDateTimeSchema,
  mentions: z.array(NameSchema),
});
export type MessageFrontmatter = z.infer<typeof MessageFrontmatterSchema>;
export interface Message extends MessageFrontmatter {
  readonly body: string;
}

/**
 * `open`: the current stage waits for a holder. `claimed`: a member holds it. The stages between
 * open and done are the task's plan; which one is current is recorded beside the status.
 */
export const TaskStatusSchema = z.enum(["open", "claimed", "done", "abandoned"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const ThreadStateSchema = z.enum(["open", "closed"]);
export type ThreadState = z.infer<typeof ThreadStateSchema>;

/** What a thread is about. A thread with a subject takes the subject's id and ends with it. */
export const ThreadSubjectSchema = z.object({
  kind: z.enum(["task", "proposal"]),
  id: UlidSchema,
});
export type ThreadSubject = z.infer<typeof ThreadSubjectSchema>;

/**
 * A conversation hanging off a channel. Its messages carry the channel but reach only its
 * participants; closing it posts a summary to the channel, which the record's body keeps.
 */
export const ThreadFrontmatterSchema = z.object({
  id: UlidSchema,
  channel: ChannelRefSchema,
  title: z.string().min(1).max(200),
  subject: ThreadSubjectSchema.optional(),
  state: ThreadStateSchema,
  openedBy: NameSchema,
  openedAt: IsoDateTimeSchema,
  closedBy: NameSchema.optional(),
  closedAt: IsoDateTimeSchema.optional(),
});
export type ThreadFrontmatter = z.infer<typeof ThreadFrontmatterSchema>;
export interface Thread extends ThreadFrontmatter {
  readonly body: string;
}

export const StageSchema = z.object({
  id: StageIdSchema,
  name: z.string().min(1),
  role: NameSchema.optional(),
  agent: NameSchema.optional(),
  gate: z.boolean().default(false),
  /** Everyone who has held the stage, oldest first. */
  holders: z.array(NameSchema).default([]),
  completedBy: NameSchema.optional(),
  completedAt: IsoDateTimeSchema.optional(),
});
export type Stage = z.infer<typeof StageSchema>;

/** A send-back: the stage the work came back from, who sent it, and when. */
export const TaskReturnSchema = z.object({
  from: StageIdSchema,
  by: NameSchema,
  at: IsoDateTimeSchema,
});
export type TaskReturn = z.infer<typeof TaskReturnSchema>;

export const TaskFrontmatterSchema = z.object({
  id: UlidSchema,
  project: NameSchema,
  title: z.string().min(1),
  status: TaskStatusSchema,
  createdBy: NameSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  /** The holder of the current stage. */
  claimedBy: NameSchema.optional(),
  leaseExpiresAt: IsoDateTimeSchema.optional(),
  parentId: UlidSchema.optional(),
  blockedBy: z.array(UlidSchema),
  requiredCapabilities: z.array(z.string()),
  stages: z.array(StageSchema).min(1),
  stage: StageIdSchema,
  /** When the current stage last became current or lost its holder: the waiting clock. */
  stageSince: IsoDateTimeSchema,
  /** The highest stage number issued, so a removed stage's id is never reused. */
  stageSeq: z.number().int().positive(),
  onDone: CompletionEffectSchema.default("none"),
  /** The last stage is complete and the completion effect is running. */
  completing: z.boolean().default(false),
  /** The latest send-back while its rework lasts: cleared once the task reaches that stage again. */
  returned: TaskReturnSchema.optional(),
});
export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;
export interface Task extends TaskFrontmatter {
  readonly body: string;
}

export function stageIndex(task: TaskFrontmatter, id: StageId): number {
  return task.stages.findIndex((stage) => stage.id === id);
}

export function currentStage(task: TaskFrontmatter): Stage | undefined {
  return task.stages.find((stage) => stage.id === task.stage);
}

/**
 * Whether a member may hold the task's current stage: the named citizen, a member of the named
 * role, or anyone when neither is named; a gated stage excludes whoever held an earlier stage.
 * Project membership and the user's exemption are the board's to check.
 */
export function mayHoldStage(
  member: { name: string; role: string },
  task: TaskFrontmatter,
): boolean {
  const index = stageIndex(task, task.stage);
  const stage = task.stages[index];
  if (stage === undefined) {
    return false;
  }
  if (stage.agent !== undefined && stage.agent !== member.name) {
    return false;
  }
  if (stage.role !== undefined && stage.role !== member.role) {
    return false;
  }
  return !(stage.gate && task.stages.slice(0, index).some((s) => s.holders.includes(member.name)));
}

/** A model as a CLI takes it: an alias such as `opus`, or a full id such as `gpt-6-astra`. */
export const ModelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\w.:/[\]-]+$/, "a model name is one word of letters, digits, and . _ : / - [ ]");

/**
 * A reasoning effort as a CLI takes it, one lowercase word: Claude Code's `low` to `max`, or
 * whatever levels Codex lists for a model. The board names no level of its own.
 */
export const EffortSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_-]*$/, "an effort is one lowercase word, such as high");

/** An effort level a model supports, as the CLI's own listing describes it. */
export const EffortOptionSchema = z.object({
  id: EffortSchema,
  description: z.string().default(""),
});
export type EffortOption = z.infer<typeof EffortOptionSchema>;

/**
 * A model a CLI offers, as its own listing describes it; `isDefault` marks the one it runs unset.
 * `efforts` lists the reasoning efforts it supports, empty when it takes none or the CLI did not
 * say, and `defaultEffort` the one it runs when none is set.
 */
export const ModelOptionSchema = z.object({
  id: ModelNameSchema,
  name: z.string(),
  description: z.string().default(""),
  isDefault: z.boolean().default(false),
  efforts: z.array(EffortOptionSchema).default([]),
  defaultEffort: EffortSchema.optional(),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

/** A CLI's models as one runner's install of it lists them, and which runner that was. */
export const RunnerModelsSchema = z.object({
  runner: NameSchema,
  cli: CliKindSchema,
  models: z.array(ModelOptionSchema),
});
export type RunnerModels = z.infer<typeof RunnerModelsSchema>;

export const AgentStatusSchema = z.enum(["active", "retired"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentSchema = z.object({
  name: NameSchema,
  role: NameSchema,
  cli: CliKindSchema.nullable(),
  model: z.string().optional(),
  /** The reasoning effort set for the agent's turns; the model's own default applies otherwise. */
  effort: z.string().optional(),
  /** The runner preferred for the agent's turns where nothing else decides; any runner with its CLI otherwise. */
  homeRunner: NameSchema.optional(),
  memberships: z.array(NameSchema),
  subscriptions: z.array(ChannelRefSchema),
  status: AgentStatusSchema,
  createdAt: IsoDateTimeSchema,
  tokenHash: z.string().min(1),
  retiredAt: IsoDateTimeSchema.optional(),
  retiredReason: z.string().optional(),
});
export type Agent = z.infer<typeof AgentSchema>;

/**
 * The roster entry the board projects for every citizen, what dispatch reads: identity, reach
 * (memberships and subscriptions), and availability (claims, tasks done, the last turn).
 * The body of the file is the citizen's own profile. Never the token hash.
 */
export const MemberSchema = z.object({
  name: NameSchema,
  role: NameSchema,
  cli: CliKindSchema.nullable(),
  homeRunner: NameSchema.optional(),
  status: AgentStatusSchema,
  resident: z.boolean().default(false),
  /** The model configured on the record, if any; the CLI's own default applies otherwise. */
  model: z.string().optional(),
  /** The model the CLI reported on the citizen's last turn. */
  lastModel: z.string().optional(),
  /** The reasoning effort configured on the record, if any; the model's own default applies otherwise. */
  effort: z.string().optional(),
  /** The citizen's own skills, by name. */
  skills: z.array(NameSchema).default([]),
  memberships: z.array(NameSchema),
  subscriptions: z.array(ChannelRefSchema),
  claimsHeld: z.number().int().nonnegative().default(0),
  tasksDone: z.number().int().nonnegative().default(0),
  lastTurnAt: IsoDateTimeSchema.optional(),
  lastTurnOutcome: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  retiredAt: IsoDateTimeSchema.optional(),
});
export type MemberFrontmatter = z.infer<typeof MemberSchema>;
export interface Member extends MemberFrontmatter {
  readonly profile: string;
}

export const RunnerOsSchema = z.enum(["linux", "windows", "darwin"]);
export const RunnerSchema = z.object({
  name: NameSchema,
  os: RunnerOsSchema,
  clis: z.array(CliKindSchema),
  capabilities: z.array(z.string()),
  status: z.enum(["connected", "disconnected"]),
  lastSeen: IsoDateTimeSchema.optional(),
});
export type Runner = z.infer<typeof RunnerSchema>;

export const ProposalKindSchema = z.enum([
  "role",
  "member",
  "channel",
  "reallocation",
  "retirement",
  "skill",
  "archive",
]);
export type ProposalKind = z.infer<typeof ProposalKindSchema>;

export const ProposalStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "provisioned",
  "retired",
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/** A member proposal: the role, the CLI and model, the home runner, seed instructions, and subscriptions. */
export const MemberProposalSchema = z.object({
  name: NameSchema,
  role: NameSchema,
  cli: CliKindSchema,
  model: z.string().optional(),
  homeRunner: NameSchema.optional(),
  memberships: z.array(NameSchema).default([]),
  subscriptions: z.array(ChannelRefSchema).default([]),
  seedInstructions: z.string().optional(),
});
export type MemberProposal = z.infer<typeof MemberProposalSchema>;
export const ChannelProposalSchema = z.object({
  project: NameSchema.nullable().default(null),
  name: NameSchema,
  purpose: z.string().min(1),
});
export type ChannelProposal = z.infer<typeof ChannelProposalSchema>;
export const ReallocationProposalSchema = z.object({
  description: z.string().min(1),
});
export const RetirementProposalSchema = z.object({
  agent: NameSchema,
  reason: z.string().min(1),
});
export type RetirementProposal = z.infer<typeof RetirementProposalSchema>;
/** A project to archive once its work is finished or has moved to another project. */
export const ArchiveProposalSchema = z.object({
  project: NameSchema,
  reason: z.string().min(1),
});
export type ArchiveProposal = z.infer<typeof ArchiveProposalSchema>;

/** A skill proposed for the society; approval copies the body under `society/skills/`. */
export const SkillProposalSchema = z.object({
  name: NameSchema,
  summary: z.string().min(1).max(200),
  body: z.string().min(1),
});
export type SkillProposal = z.infer<typeof SkillProposalSchema>;

/** Charter schema per proposal kind. */
export const ProposalCharterSchemas = {
  role: RoleCharterSchema,
  member: MemberProposalSchema,
  channel: ChannelProposalSchema,
  reallocation: ReallocationProposalSchema,
  retirement: RetirementProposalSchema,
  skill: SkillProposalSchema,
  archive: ArchiveProposalSchema,
} as const;

/** The roles that may decide a proposal of each kind. A proposer never decides its own. */
export const ROLE_KIND_APPROVERS: Readonly<Record<ProposalKind, readonly Name[]>> = {
  role: [USER_ROLE],
  member: [USER_ROLE],
  retirement: [USER_ROLE],
  archive: [USER_ROLE],
  channel: [USER_ROLE, "steward"],
  reallocation: [USER_ROLE, "steward"],
  skill: [USER_ROLE, "steward"],
};

/**
 * One line for a proposal's charter, as the governance and decisions channels, its thread, and
 * the interface title it.
 */
export function describeCharter(kind: ProposalKind, charter: Record<string, unknown>): string {
  switch (kind) {
    case "member": {
      const parsed = MemberProposalSchema.safeParse(charter);
      if (!parsed.success) break;
      const { name, role, cli, memberships } = parsed.data;
      const where = memberships.length === 0 ? "" : ` for ${memberships.join(", ")}`;
      return `member ${name} as ${role} on ${cli}${where}`;
    }
    case "role": {
      const parsed = RoleCharterSchema.safeParse(charter);
      if (!parsed.success) break;
      const { name, verbs, maxReplicas } = parsed.data;
      return `role ${name} (${verbs.length} verbs, up to ${maxReplicas} per project)`;
    }
    case "channel": {
      const parsed = ChannelProposalSchema.safeParse(charter);
      if (!parsed.success) break;
      return `channel ${channelRef(parsed.data.project, parsed.data.name)}: ${parsed.data.purpose}`;
    }
    case "retirement": {
      const parsed = RetirementProposalSchema.safeParse(charter);
      if (!parsed.success) break;
      return `retirement of ${parsed.data.agent}: ${parsed.data.reason}`;
    }
    case "reallocation": {
      const parsed = ReallocationProposalSchema.safeParse(charter);
      if (!parsed.success) break;
      return `reallocation: ${parsed.data.description}`;
    }
    case "skill": {
      const parsed = SkillProposalSchema.safeParse(charter);
      if (!parsed.success) break;
      return `skill ${parsed.data.name}: ${parsed.data.summary.trim().replace(/\.+$/, "")}`;
    }
    case "archive": {
      const parsed = ArchiveProposalSchema.safeParse(charter);
      if (!parsed.success) break;
      return `archive of project ${parsed.data.project}: ${parsed.data.reason}`;
    }
    default:
      break;
  }
  return `${kind} ${JSON.stringify(charter)}`;
}

/** A skill as projected: an agent's own under its home, or the society's under `society/skills/`. */
export const SkillSchema = z.object({
  name: NameSchema,
  summary: z.string().default(""),
  scope: z.enum(["own", "society"]),
  path: z.string().min(1),
});
export type Skill = z.infer<typeof SkillSchema>;

/**
 * A conflict copy in an agent's home: the agent's own version of a file, which a runner kept
 * beside the board's when two of its turns changed the same lines on different runners, until the
 * agent merges it into the file and deletes it.
 */
export const HomeConflictSchema = z.object({
  /** The copy, relative to the home. */
  path: z.string().min(1),
  /** The file beside it, whose version the board kept. */
  file: z.string().min(1),
  /** When the copy reached the board. */
  since: IsoDateTimeSchema,
});
export type HomeConflict = z.infer<typeof HomeConflictSchema>;

/** A runner's conflict copy, `<file>.conflict-<label>`, capturing the file it sits beside. */
const CONFLICT_COPY = /^(.+)\.conflict-[^/.]+$/;

/** The file a conflict copy sits beside, or null when the path is not a conflict copy. */
export function conflictCopyOf(copy: string): string | null {
  return CONFLICT_COPY.exec(copy)?.[1] ?? null;
}

/** A commit id in a home's repository, as git prints it in full. */
export const CommitIdSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** One file a change to a home touched. */
export const HomeFileChangeSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted"]),
  /** Lines added and removed, or null for a binary file. */
  added: z.number().int().nonnegative().nullable(),
  removed: z.number().int().nonnegative().nullable(),
});
export type HomeFileChange = z.infer<typeof HomeFileChangeSchema>;

/**
 * One change in a home's history: what a turn left, what the board wrote, or a merge of two
 * runners' work that kept conflict copies, listing only those copies.
 */
export const HomeChangeSchema = z.object({
  commit: CommitIdSchema,
  at: IsoDateTimeSchema,
  kind: z.enum(["turn", "board", "merge"]),
  author: z.string(),
  /** The turn that made it, from the runner's commit message. */
  turnId: UlidSchema.optional(),
  subject: z.string(),
  files: z.array(HomeFileChangeSchema),
});
export type HomeChange = z.infer<typeof HomeChangeSchema>;

export const HomeHistorySchema = z.object({
  changes: z.array(HomeChangeSchema),
  /** Whether older commits remain past the ones read. */
  more: z.boolean(),
});
export type HomeHistory = z.infer<typeof HomeHistorySchema>;

/** One file of a change with its patch: the hunks, or null for a binary file. */
export const HomeFileDiffSchema = HomeFileChangeSchema.pick({ path: true, status: true }).extend({
  patch: z.string().nullable(),
  /** The patch was cut at its size limit. */
  truncated: z.boolean(),
});
export type HomeFileDiff = z.infer<typeof HomeFileDiffSchema>;

/** A knowledge topic: a project's, or the society's when the project is null. */
export const KnowledgeSchema = z.object({
  topic: NameSchema,
  project: NameSchema.nullable(),
  updatedBy: NameSchema,
  updatedAt: IsoDateTimeSchema,
});
export type KnowledgeFrontmatter = z.infer<typeof KnowledgeSchema>;

/** A topic taken out of a scope's knowledge, by whom and when. */
export const RemovedKnowledgeSchema = z.object({
  topic: NameSchema,
  project: NameSchema.nullable(),
  removedBy: NameSchema,
  removedAt: IsoDateTimeSchema,
});
export type RemovedKnowledge = z.infer<typeof RemovedKnowledgeSchema>;
export interface Knowledge extends KnowledgeFrontmatter {
  readonly body: string;
}

export const ProposalFrontmatterSchema = z.object({
  id: UlidSchema,
  kind: ProposalKindSchema,
  proposedBy: NameSchema,
  status: ProposalStatusSchema,
  createdAt: IsoDateTimeSchema,
  decidedBy: NameSchema.optional(),
  decidedAt: IsoDateTimeSchema.optional(),
  reason: z.string().optional(),
  charter: z.record(z.string(), z.unknown()),
  /** What approval created, for kinds the board provisions: the agent, channel, role, or retirement. */
  provisionedAt: IsoDateTimeSchema.optional(),
  provision: z.record(z.string(), z.unknown()).optional(),
});
export type ProposalFrontmatter = z.infer<typeof ProposalFrontmatterSchema>;
export interface Proposal extends ProposalFrontmatter {
  readonly body: string;
}

export const DecisionSchema = z.object({
  id: UlidSchema,
  proposalId: UlidSchema,
  decidedBy: NameSchema,
  outcome: z.enum(["approved", "rejected"]),
  reason: z.string().optional(),
  ts: IsoDateTimeSchema,
});
export type Decision = z.infer<typeof DecisionSchema>;
