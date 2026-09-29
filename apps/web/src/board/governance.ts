import {
  ChannelProposalSchema,
  channelRef,
  describeCharter,
  MemberProposalSchema,
  RetirementProposalSchema,
  ROLE_KIND_APPROVERS,
  RoleCharterSchema,
  SkillProposalSchema,
  USER_NAME,
  USER_ROLE,
  type Member,
  type Message,
  type Proposal,
  type RoleCharter,
  type Skill,
  type Stage,
  type Task,
} from "@stellaris/shared";
import { phaseOf } from "./tasks.js";

/** Where a proposal stands for the user, as the proposals view groups it. */
export type ProposalGroup = "yours" | "others" | "decided";

export const PROPOSAL_GROUPS: ReadonlyArray<{
  readonly group: ProposalGroup;
  readonly label: string;
}> = [
  { group: "yours", label: "Waiting on you" },
  { group: "others", label: "Waiting on others" },
  { group: "decided", label: "Decided" },
];

/** The proposal in one line, as the board announces it. */
export function proposalTitle(proposal: Proposal): string {
  const line = describeCharter(proposal.kind, proposal.charter);
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Whether the user may decide the proposal now. A proposer never decides its own. */
export function waitingOnYou(proposal: Proposal): boolean {
  return (
    proposal.status === "proposed" &&
    proposal.proposedBy !== USER_NAME &&
    ROLE_KIND_APPROVERS[proposal.kind].includes(USER_ROLE)
  );
}

export function groupOf(proposal: Proposal): ProposalGroup {
  if (proposal.status !== "proposed") {
    return "decided";
  }
  return waitingOnYou(proposal) ? "yours" : "others";
}

/** Open proposals oldest first, as a queue; decided ones newest decision first. */
export function groupProposals(
  proposals: readonly Proposal[],
): Array<{ group: ProposalGroup; proposals: Proposal[] }> {
  return PROPOSAL_GROUPS.map(({ group }) => {
    const members = proposals.filter((proposal) => groupOf(proposal) === group);
    return {
      group,
      proposals:
        group === "decided"
          ? members.toSorted((a, b) =>
              (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt),
            )
          : members.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
  }).filter((each) => each.proposals.length > 0);
}

const EITHER = new Intl.ListFormat("en", { type: "disjunction" });

/**
 * Who may decide it, in words: "you", or "you or another steward" when the proposer holds a role
 * that may decide it, since the proposer itself may not.
 */
export function decidersOf(proposal: Proposal, proposerRole: string | undefined): string {
  const who = ROLE_KIND_APPROVERS[proposal.kind].flatMap((role) => {
    if (role === USER_ROLE) {
      return proposal.proposedBy === USER_NAME ? [] : ["you"];
    }
    return [role === proposerRole ? `another ${role}` : `the ${role}`];
  });
  return who.length === 0 ? "nobody" : EITHER.format(who);
}

/** A role proposal's charter with the defaults the board fills in when it writes it. */
export function proposedRole(proposal: Proposal): RoleCharter | null {
  const parsed = RoleCharterSchema.safeParse(proposal.charter);
  return proposal.kind === "role" && parsed.success ? parsed.data : null;
}

export interface RoleChange {
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

export interface RoleDiff {
  readonly verbsAdded: readonly string[];
  readonly verbsRemoved: readonly string[];
  readonly changes: readonly RoleChange[];
  readonly purposeChanged: boolean;
}

function shown(value: unknown): string {
  if (value === undefined) {
    return "unset";
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "none" : value.join(", ");
  }
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : JSON.stringify(value);
}

const ROLE_FIELDS: ReadonlyArray<readonly [keyof RoleCharter, string]> = [
  ["wakeTriggers", "wake triggers"],
  ["maxReplicas", "replicas per project"],
  ["backlogThreshold", "backlog per member before scaling"],
  ["resident", "warm session"],
  ["societyScope", "turns outside projects"],
  ["reflects", "reflects"],
  ["reviewDate", "review date"],
];

/** What approving a role proposal changes in the charter the role has now. */
export function roleDiff(current: RoleCharter, next: RoleCharter): RoleDiff {
  return {
    verbsAdded: next.verbs.filter((verb) => !current.verbs.includes(verb)),
    verbsRemoved: current.verbs.filter((verb) => !next.verbs.includes(verb)),
    purposeChanged: current.purpose.trim() !== next.purpose.trim(),
    changes: ROLE_FIELDS.flatMap(([field, label]) => {
      const from = shown(current[field]);
      const to = shown(next[field]);
      return from === to ? [] : [{ field: label, from, to }];
    }),
  };
}

/** A SKILL.md body without its frontmatter, which the proposal already shows as fields. */
export function skillText(body: string): string {
  return body.replace(/^\s*---\n[\s\S]*?\n---[ \t]*\n?/, "").trim();
}

interface BoardNow {
  readonly members: readonly Member[];
  readonly roles: readonly RoleCharter[];
  readonly skills: readonly Skill[];
}

/** What approving the proposal does, in one sentence, against the board as it is now. */
export function consequenceOf(proposal: Proposal, board: BoardNow): string {
  switch (proposal.kind) {
    case "member": {
      const parsed = MemberProposalSchema.safeParse(proposal.charter);
      if (!parsed.success) break;
      const { name, role, cli, memberships } = parsed.data;
      const where = memberships.length === 0 ? "" : ` in ${memberships.join(", ")}`;
      return `Creates the citizen ${name} (${role}, ${cli})${where} and starts its first turn.`;
    }
    case "role": {
      const next = proposedRole(proposal);
      if (next === null) break;
      if (!board.roles.some((role) => role.name === next.name)) {
        return `Adds the role ${next.name}; nobody holds it until a member proposal is approved.`;
      }
      const holders = board.members.filter(
        (member) => member.role === next.name && member.status === "active",
      ).length;
      if (holders === 0) {
        return `Rewrites the ${next.name} charter; no active member holds the role.`;
      }
      return `Rewrites the ${next.name} charter for ${
        holders === 1 ? "its member" : `its ${holders} members`
      }, from their next turn.`;
    }
    case "channel": {
      const parsed = ChannelProposalSchema.safeParse(proposal.charter);
      if (!parsed.success) break;
      return `Creates #${channelRef(parsed.data.project, parsed.data.name)}.`;
    }
    case "retirement": {
      const parsed = RetirementProposalSchema.safeParse(proposal.charter);
      if (!parsed.success) break;
      return `Retires ${parsed.data.agent}: its stages go back to open and its home is archived, not deleted.`;
    }
    case "skill": {
      const parsed = SkillProposalSchema.safeParse(proposal.charter);
      if (!parsed.success) break;
      return board.skills.some((skill) => skill.name === parsed.data.name)
        ? `Replaces the society's ${parsed.data.name} skill with this text.`
        : `Publishes ${parsed.data.name} to the society's skills, which every citizen's instructions list.`;
    }
    case "reallocation":
      return "Records the decision; the board carries out nothing for a reallocation.";
    default:
      break;
  }
  return "The charter does not parse as its kind; approving it will fail.";
}

/** Something that waits on the user, and since when. */
export type Attention =
  | { readonly kind: "proposal"; readonly since: string; readonly proposal: Proposal }
  | { readonly kind: "stage"; readonly since: string; readonly task: Task; readonly stage: Stage }
  | { readonly kind: "request"; readonly since: string; readonly message: Message };

/** The task's current stage when it waits on the user: named for the user, and nobody else holds it. */
export function stageForYou(task: Task): Stage | null {
  const phase = phaseOf(task);
  if (phase === "landing" || phase === "done" || phase === "abandoned") {
    return null;
  }
  const stage = task.stages.find((candidate) => candidate.id === task.stage);
  if (stage === undefined || (stage.agent !== USER_NAME && stage.role !== USER_ROLE)) {
    return null;
  }
  return task.status === "open" || task.claimedBy === USER_NAME ? stage : null;
}

/**
 * What waits on the user, derived from the board: proposals the user may decide, stages that name
 * the user, and requests addressed to the user in #decisions since this browser last opened it.
 * The first two are board state and leave when it changes; the requests are messages, so reading
 * #decisions clears them.
 */
export function needsYou(input: {
  readonly proposals: readonly Proposal[];
  readonly tasks: readonly Task[];
  readonly decisions: readonly Message[];
  /** The newest #decisions message this browser has shown, or null before it has listed any. */
  readonly seenDecisions: string | null;
}): Attention[] {
  const oldestFirst = (a: Attention, b: Attention): number => a.since.localeCompare(b.since);
  const proposals = input.proposals
    .filter(waitingOnYou)
    .map((proposal): Attention => ({ kind: "proposal", since: proposal.createdAt, proposal }));
  const stages = input.tasks.flatMap((task): Attention[] => {
    const stage = stageForYou(task);
    return stage === null ? [] : [{ kind: "stage", since: task.stageSince, task, stage }];
  });
  const seen = input.seenDecisions;
  const requests =
    seen === null
      ? []
      : input.decisions
          .filter(
            (message) =>
              message.id > seen &&
              message.author !== USER_NAME &&
              message.mentions.includes(USER_NAME),
          )
          .map((message): Attention => ({ kind: "request", since: message.ts, message }));
  return [
    ...proposals.toSorted(oldestFirst),
    ...stages.toSorted(oldestFirst),
    ...requests.toSorted(oldestFirst),
  ];
}
