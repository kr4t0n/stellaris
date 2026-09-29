import { z } from "zod";
import { ChannelRefSchema, IsoDateTimeSchema, NameSchema, UlidSchema } from "./ids.js";
import { RoleCharterSchema } from "./roles.js";

export const SOCIETY_CHANNELS = ["general", "ops", "governance", "decisions"] as const;
export const PROJECT_DEFAULT_CHANNELS = ["general", "dev"] as const;

/**
 * The scope of a turn that belongs to no project: the front desk answering the owner, the
 * steward reading signals. Dispatches, sessions, and turn records use it in place of a project
 * slug, and the runner uses the agent's home as the working directory. No project may take the name.
 */
export const SOCIETY_SCOPE = "society";

export const CliKindSchema = z.enum(["claude", "codex"]);
export type CliKind = z.infer<typeof CliKindSchema>;

export const SocietySchema = z.object({
  name: z.string().min(1),
  version: z.literal(1),
  createdAt: IsoDateTimeSchema,
  channels: z.array(NameSchema),
});
export type Society = z.infer<typeof SocietySchema>;

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
});
export type Project = z.infer<typeof ProjectSchema>;

/** Message frontmatter. The author is stamped by the board, never supplied by the caller. */
export const MessageFrontmatterSchema = z.object({
  id: UlidSchema,
  author: NameSchema,
  channel: ChannelRefSchema,
  thread: UlidSchema.optional(),
  task: UlidSchema.optional(),
  ts: IsoDateTimeSchema,
  mentions: z.array(NameSchema),
});
export type MessageFrontmatter = z.infer<typeof MessageFrontmatterSchema>;
export interface Message extends MessageFrontmatter {
  readonly body: string;
}

export const TaskStatusSchema = z.enum([
  "open",
  "claimed",
  "in_review",
  "done",
  "blocked",
  "abandoned",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const ThreadStateSchema = z.enum(["none", "open", "closed"]);
export type ThreadState = z.infer<typeof ThreadStateSchema>;

export const TaskFrontmatterSchema = z.object({
  id: UlidSchema,
  project: NameSchema,
  title: z.string().min(1),
  status: TaskStatusSchema,
  thread: ThreadStateSchema,
  createdBy: NameSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  claimedBy: NameSchema.optional(),
  leaseExpiresAt: IsoDateTimeSchema.optional(),
  parentId: UlidSchema.optional(),
  blockedBy: z.array(UlidSchema),
  requiredCapabilities: z.array(z.string()),
});
export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;
export interface Task extends TaskFrontmatter {
  readonly body: string;
}

/** Legal status transitions. Who may perform each one is enforced by the board. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  open: ["claimed", "abandoned"],
  claimed: ["open", "in_review", "blocked", "abandoned"],
  in_review: ["claimed", "done"],
  blocked: ["claimed"],
  done: [],
  abandoned: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
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
  homeRunner: NameSchema.default("local"),
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
/** Retirement mirrors hiring: the decision is policy, the execution is mechanical. */
export const RetirementProposalSchema = z.object({
  agent: NameSchema,
  reason: z.string().min(1),
});
export type RetirementProposal = z.infer<typeof RetirementProposalSchema>;

/** A skill proposed for the society: reviewed like code, then available to every citizen. */
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
