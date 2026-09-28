import { z } from "zod";
import { NameSchema } from "./ids.js";

/** Every board verb. A role charter grants a subset; the owner holds all of them. */
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
] as const;
export const VerbNameSchema = z.enum(VERB_NAMES);
export type VerbName = z.infer<typeof VerbNameSchema>;

export const RepoPermissionSchema = z.enum(["none", "read", "write", "merge"]);
export type RepoPermission = z.infer<typeof RepoPermissionSchema>;

/**
 * A role charter: purpose, granted verbs, repository permission, wake triggers, a review date,
 * and the scaling rule the scheduler may apply mechanically: up to `maxReplicas` active members
 * of the role per project, adding one whenever the load per member reaches `backlogThreshold`.
 * A cap of one means the role never scales on its own; hiring stays a proposal.
 */
export const RoleCharterSchema = z.object({
  name: NameSchema,
  purpose: z.string().min(1),
  verbs: z.array(VerbNameSchema),
  repoPermission: RepoPermissionSchema,
  wakeTriggers: z.array(z.string()),
  reviewDate: z.string().optional(),
  maxReplicas: z.number().int().min(1).default(1),
  backlogThreshold: z.number().positive().default(3),
});
export type RoleCharter = z.infer<typeof RoleCharterSchema>;
export type RoleCharterInput = z.input<typeof RoleCharterSchema>;

export const OWNER_ROLE = "owner";
export const OWNER_NAME = "owner";

const MEMBER_VERBS: readonly VerbName[] = [
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
];

const GOVERNANCE_VERBS: readonly VerbName[] = ["approve", "reject"];

/** Seed roles written at society initialization. Their charters are iterated after the infrastructure exists. */
export const SEED_ROLES: readonly RoleCharter[] = [
  {
    name: OWNER_ROLE,
    purpose:
      "The human owner. Approves merges to main, hiring, tool grants, and reallocation. Interacts by mention and watches turns live.",
    verbs: [...MEMBER_VERBS, ...GOVERNANCE_VERBS],
    repoPermission: "merge",
    wakeTriggers: [],
    maxReplicas: 1,
    backlogThreshold: 3,
  },
  {
    name: "engineer",
    purpose:
      "Claims tasks, works in its own worktree and branch, submits work for review, and never lands changes on main.",
    verbs: [...MEMBER_VERBS],
    repoPermission: "write",
    wakeTriggers: ["mention", "claim_event", "unclaimed_task", "heartbeat"],
    maxReplicas: 1,
    backlogThreshold: 3,
  },
  {
    name: "reviewer",
    purpose:
      "Gates what lands on main. Adversarial by charter: the definition of done is passing tests and a reviewed diff, never sentiment. Approve by moving the task to done; the board then lands the claimer's branch on main. Never merge or fast-forward main yourself.",
    verbs: [...MEMBER_VERBS],
    repoPermission: "merge",
    wakeTriggers: ["mention", "claim_event", "heartbeat"],
    maxReplicas: 1,
    backlogThreshold: 3,
  },
  {
    name: "steward",
    purpose:
      "Watches the ops channel and the task board for capacity, skill, and capability gaps, and turns signals into proposals: a member when a role is missing or a backlog persists, a retirement when a member has been idle for a long time, a channel when a topic needs one. Prefers scaling an existing role over inventing a new one; justifies a new role by repeated unclaimed work of its kind. Never approves its own proposals; hiring, roles, and retirements are decided by the owner, channels and reallocations the steward may decide. Curates society knowledge and skills.",
    verbs: [...MEMBER_VERBS, ...GOVERNANCE_VERBS],
    repoPermission: "read",
    wakeTriggers: ["mention", "ops_event", "heartbeat"],
    maxReplicas: 1,
    backlogThreshold: 3,
  },
];
