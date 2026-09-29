import { z } from "zod";
import { ChannelRefSchema, IsoDateTimeSchema, NameSchema, UlidSchema } from "./ids.js";
import { RoleCharterSchema } from "./roles.js";

export const SOCIETY_CHANNELS = ["general", "ops", "governance", "decisions"] as const;
export const PROJECT_DEFAULT_CHANNELS = ["general", "dev"] as const;

/**
 * The scope of a turn that belongs to no project. Dispatches, sessions, and turn records use it in
 * place of a project slug, and the runner uses the agent's home as the working directory. No
 * project may take the name.
 */
export const SOCIETY_SCOPE = "society";

/** The runner embedded in the board server. Runners on other machines register under their own names. */
export const SERVER_RUNNER = "server";

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
  /** The plan a task gets when its creator gives none. */
  defaultPlan: z.array(PlanStageSchema).default([]),
  onDone: CompletionEffectSchema.default("none"),
});
export type Project = z.infer<typeof ProjectSchema>;

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

export const AgentStatusSchema = z.enum(["active", "retired"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentSchema = z.object({
  name: NameSchema,
  role: NameSchema,
  cli: CliKindSchema.nullable(),
  model: z.string().optional(),
  homeRunner: NameSchema,
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
  homeRunner: NameSchema,
  status: AgentStatusSchema,
  resident: z.boolean().default(false),
  /** The model configured on the record, if any; the CLI's own default applies otherwise. */
  model: z.string().optional(),
  /** The model the CLI reported on the citizen's last turn. */
  lastModel: z.string().optional(),
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
  homeRunner: NameSchema.default(SERVER_RUNNER),
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
} as const;

/** A skill as projected: an agent's own under its home, or the society's under `society/skills/`. */
export const SkillSchema = z.object({
  name: NameSchema,
  summary: z.string().default(""),
  scope: z.enum(["own", "society"]),
  path: z.string().min(1),
});
export type Skill = z.infer<typeof SkillSchema>;

/** A knowledge topic: a project's, or the society's when the project is null. */
export const KnowledgeSchema = z.object({
  topic: NameSchema,
  project: NameSchema.nullable(),
  updatedBy: NameSchema,
  updatedAt: IsoDateTimeSchema,
});
export type KnowledgeFrontmatter = z.infer<typeof KnowledgeSchema>;
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
