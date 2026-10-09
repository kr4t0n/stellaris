import { z } from "zod";
import { NameSchema } from "./ids.js";

/** Every board verb. A role charter grants a subset; the user holds all of them. */
export const VERB_NAMES = [
  "post_message",
  "read_inbox",
  "search",
  "open_thread",
  "close_thread",
  "create_task",
  "claim_task",
  "release_task",
  "update_task",
  "get_task",
  "subscribe",
  "unsubscribe",
  "propose",
  "approve",
  "reject",
  "create_project",
  "join_project",
  "leave_project",
  "write_knowledge",
  "plan_task",
  "advance_task",
  "configure_project",
  "archive_project",
  "remove_knowledge",
] as const;
export const VerbNameSchema = z.enum(VERB_NAMES);
export type VerbName = z.infer<typeof VerbNameSchema>;

/**
 * Wakes a charter opts into. Mentions, stages that become the member's, finished tasks for their
 * creator, onboarding, manual, and reflection wakes always fire and are never listed.
 */
export const CharterTriggerSchema = z.enum(["user_post", "ops_event", "heartbeat"]);
export type CharterTrigger = z.infer<typeof CharterTriggerSchema>;

/**
 * A role charter. The scheduler adds members of the role up to `maxReplicas` per project whenever
 * the load per member reaches `backlogThreshold`; a cap of one never scales.
 */
export const RoleCharterSchema = z.object({
  name: NameSchema,
  purpose: z.string().min(1),
  verbs: z.array(VerbNameSchema),
  /** A periodic look at the digest is on unless the charter says otherwise. */
  wakeTriggers: z.array(CharterTriggerSchema).default(["heartbeat"]),
  reviewDate: z.string().optional(),
  maxReplicas: z.number().int().min(1).default(1),
  backlogThreshold: z.number().positive().default(3),
  /** The runner keeps a warm session between turns. */
  resident: z.boolean().default(false),
  /**
   * A society role, which keeps watch over the whole society: its members are never in a project,
   * every turn of theirs is outside projects, and their heartbeat wakes them for news there. Any
   * citizen takes turns outside projects when asked there; a work role reads the news there at
   * its next turn instead.
   */
  societyScope: z.boolean().default(false),
  /** The scheduler wakes the role for a reflection turn on the society's cadence. Off for humans. */
  reflects: z.boolean().default(true),
});
export type RoleCharter = z.infer<typeof RoleCharterSchema>;
export type RoleCharterInput = z.input<typeof RoleCharterSchema>;

export const USER_ROLE = "user";
export const USER_NAME = "user";

/** The verbs every working member needs: messaging, threads, tasks and their plans, membership, knowledge. */
export const MEMBER_VERBS: readonly VerbName[] = [
  "post_message",
  "read_inbox",
  "search",
  "open_thread",
  "close_thread",
  "create_task",
  "claim_task",
  "release_task",
  "update_task",
  "get_task",
  "subscribe",
  "unsubscribe",
  "propose",
  "join_project",
  "leave_project",
  "write_knowledge",
  "remove_knowledge",
  "plan_task",
  "advance_task",
];

const GOVERNANCE_VERBS: readonly VerbName[] = ["approve", "reject"];
const FRONT_DESK_VERBS: readonly VerbName[] = ["create_project"];
const PLANNING_VERBS: readonly VerbName[] = ["configure_project"];
/** Archiving a project is the user's alone for now; other roles propose it. */
const ARCHIVE_VERBS: readonly VerbName[] = ["archive_project"];

/**
 * Seed roles, written at society initialization and aligned on every open. Roles for the work
 * itself are proposed per project; none is seeded.
 */
export const SEED_ROLES: readonly RoleCharter[] = [
  {
    name: USER_ROLE,
    purpose:
      "The human user. Decides hiring, roles and tool grants, and retirement; sets gates; may act anywhere. Interacts by mention and watches turns live.",
    verbs: [
      ...MEMBER_VERBS,
      ...GOVERNANCE_VERBS,
      ...FRONT_DESK_VERBS,
      ...PLANNING_VERBS,
      ...ARCHIVE_VERBS,
    ],
    wakeTriggers: [],
    maxReplicas: 1,
    backlogThreshold: 3,
    resident: false,
    societyScope: true,
    reflects: false,
  },
  {
    name: "steward",
    purpose:
      "Watches the operations signals and the task board for capacity, skill, and capability gaps, and turns signals into proposals: a member when a project's plans need a role nobody fills or a backlog persists, a role when a project's work needs one no existing role covers, a retirement when a member has been idle for a long time, a channel when a topic needs one. Owns how work is shaped over time: answers stages waiting too long, stages assigned to roles nobody fills, and work sent back again and again by replanning with plan_task, adjusting gates, or proposing the role a plan needs; sets each project's completion effect with configure_project; turns recurring plan shapes into society skills and planning norms into the society's norms. Prefers scaling an existing role over inventing a new one. Never approves its own proposals; hiring, roles, and retirements are decided by the user, and channels, reallocations, and skills the steward may decide. Curates society knowledge and skills.",
    verbs: [...MEMBER_VERBS, ...GOVERNANCE_VERBS, ...PLANNING_VERBS],
    wakeTriggers: ["ops_event", "heartbeat"],
    maxReplicas: 1,
    backlogThreshold: 3,
    resident: false,
    societyScope: true,
    reflects: true,
  },
  {
    name: "concierge",
    purpose:
      "The society's front desk. Wakes on every post the user makes and routes it: a question gets an answer where it was asked, in its thread when it came in one; work in an area an existing project covers gets a task there, planned when it is created, since a project is a lasting area of work and not one request; work in a new area gets a project, created on the spot, and the member or role proposals it needs for the user to approve. Reorganizes projects when the user asks: creates or picks the project the work belongs in, adds the citizens it needs, files a task there to bring over what the old projects hold (their task branches and their knowledge), and once that task is done proposes archiving each old project for the user to approve. Plans every task it routes: names stages by the work, assigns each to a role or a citizen, and gates where a second pair of eyes is worth it: before anything lands in a shared deliverable, so always before a merge; before effects outside the society; and before results are presented as findings. When a task it created is done, tells the user. Reads the roster in every digest to choose citizens by role, reach, availability, and profile, and adds a citizen to a project when the work needs it. Mentions a citizen with @ only to hand it work outside a plan, since a mention wakes it and costs a turn; lists and describes citizens by plain name. Stays silent when the user already addressed a citizen and nothing else is needed. Never does the work itself and never decides hiring.",
    verbs: [...MEMBER_VERBS, ...FRONT_DESK_VERBS, ...PLANNING_VERBS],
    wakeTriggers: ["user_post", "heartbeat"],
    maxReplicas: 1,
    backlogThreshold: 3,
    resident: true,
    societyScope: true,
    reflects: true,
  },
];
