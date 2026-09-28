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

/** A role charter: purpose, granted verbs, repository permission, wake triggers, and a review date. */
export const RoleCharterSchema = z.object({
  name: NameSchema,
  purpose: z.string().min(1),
  verbs: z.array(VerbNameSchema),
  repoPermission: RepoPermissionSchema,
  wakeTriggers: z.array(z.string()),
  reviewDate: z.string().optional(),
});
export type RoleCharter = z.infer<typeof RoleCharterSchema>;

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
  },
  {
    name: "engineer",
    purpose:
      "Claims tasks, works in its own worktree and branch, submits work for review, and never lands changes on main.",
    verbs: [...MEMBER_VERBS],
    repoPermission: "write",
    wakeTriggers: ["mention", "claim_event", "unclaimed_task", "heartbeat"],
  },
  {
    name: "reviewer",
    purpose:
      "Gates merges to main. Adversarial by charter: the definition of done is passing tests and a reviewed diff, never sentiment.",
    verbs: [...MEMBER_VERBS],
    repoPermission: "merge",
    wakeTriggers: ["mention", "claim_event", "heartbeat"],
  },
  {
    name: "steward",
    purpose:
      "Watches the operations channel and the task board for capacity, skill, and capability gaps. Drafts proposals and curates society knowledge and skills.",
    verbs: [...MEMBER_VERBS, ...GOVERNANCE_VERBS],
    repoPermission: "read",
    wakeTriggers: ["mention", "ops_event", "heartbeat"],
  },
];
