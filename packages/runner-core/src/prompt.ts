import type {
  Knowledge,
  Member,
  Message,
  Project,
  Task,
  TurnDispatch,
  TurnRecord,
} from "@stellaris/shared";
import { renderOnboardingPreamble, type OnboardingContext } from "./render.js";

/** What the front desk reads to route: every project with its channels, every citizen with its roster line. */
export interface SocietyView {
  readonly projects: readonly Project[];
  readonly members: readonly Member[];
}

/** The shared knowledge of the turn's scope: the project's topics, or the society's in the society scope. */
export interface KnowledgeView {
  /** Where the topics are on this runner, so the agent can open one with its file tools. */
  readonly dir: string;
  readonly topics: readonly Knowledge[];
}

export interface TurnPromptInput {
  readonly dispatch: TurnDispatch;
  readonly messages: readonly Message[];
  readonly heldClaims: readonly Task[];
  readonly lastTurn: TurnRecord | null;
  readonly onboarding: OnboardingContext | null;
  /** Present for roles that route on behalf of the user; absent for everyone else. */
  readonly societyView?: SocietyView | null | undefined;
  readonly knowledge?: KnowledgeView | null | undefined;
}

/** What a reflection turn is for. It replaces new work, not the inbox. */
const REFLECTION = [
  "This turn is for your memory; take no new work, and answer the inbox only where a reply is needed. Read memory/core.md and your recent turn records, then:",
  "- Consolidate memory/core.md: keep it to lessons that still hold, about sixty lines at most, and move detail worth keeping to memory/<topic>.md in your home, which the board's search covers for you alone.",
  '- Extract a skill: a procedure you have followed twice goes to skills/<name>/SKILL.md, frontmatter with `name` and a one-line `description` and then the steps. Propose it with kind "skill" when other citizens would use it.',
  "- Refresh profile.md: one paragraph on what you do well and what to send your way; the roster the front desk routes with is built from it.",
  "- Share: a durable fact about this scope's codebase or process goes through write_knowledge; a norm the whole society should follow goes to the steward as a plain post in general.",
  "- Report memoryUpdated: true in the status object when core.md or a skill changed.",
].join("\n");

const MAX_BODY_CHARS = 1_500;
const MAX_PROFILE_CHARS = 200;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_BODY_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_BODY_CHARS)}\n[... truncated]`;
}

/** The first line of a profile that is not a heading, clipped. */
function profileLine(profile: string): string {
  const line = profile
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith("#"));
  if (line === undefined) {
    return "no profile yet";
  }
  return line.length <= MAX_PROFILE_CHARS ? line : `${line.slice(0, MAX_PROFILE_CHARS)}…`;
}

function rosterLine(member: Member): string {
  const model = member.lastModel ?? member.model;
  const parts = [
    `${member.role} on ${member.cli ?? "no CLI"}${model === undefined ? "" : ` (${model})`}`,
    member.status,
    member.resident ? "resident" : "",
    member.memberships.length === 0 ? "no projects" : `projects ${member.memberships.join(", ")}`,
    member.subscriptions.length === 0 ? "" : `follows ${member.subscriptions.join(", ")}`,
    member.skills.length === 0 ? "" : `skills ${member.skills.join(", ")}`,
    `${member.claimsHeld} claim(s) held`,
    `${member.tasksDone} done`,
    member.lastTurnOutcome === undefined
      ? "no turn yet"
      : `last turn ${member.lastTurnAt ?? ""} ${member.lastTurnOutcome}`.trim(),
  ].filter((part) => part.length > 0);
  return `- ${member.name}: ${parts.join("; ")}. Profile: ${profileLine(member.profile)}`;
}

/** The digest injected into every turn's prompt. */
export function buildTurnPrompt(input: TurnPromptInput): string {
  const { dispatch } = input;
  const lines: string[] = [];
  lines.push(`# Turn for ${dispatch.agent} on ${dispatch.project}`);
  lines.push("");
  const from = dispatch.trigger.from === undefined ? "" : ` from ${dispatch.trigger.from}`;
  lines.push(`Trigger: ${dispatch.trigger.kind}${from}. ${dispatch.trigger.reason}`.trim());
  if (dispatch.trigger.taskId !== undefined) {
    lines.push(`Task in question: ${dispatch.trigger.taskId}`);
  }
  if (dispatch.trigger.kind === "ops_event") {
    lines.push(
      "Operations signals arrived; the ops posts below carry them. Decide whether a proposal is warranted, and stay silent if not.",
    );
  }
  if (dispatch.trigger.kind === "user_post") {
    lines.push(
      "The user posted. Route it: answer in the same channel, or create the task, thread, or project it needs and mention the citizens who will do it, adding them to the project first when they are not members. Stay silent when the user already addressed a citizen and nothing else is needed.",
    );
  }

  if (dispatch.trigger.kind === "reflection") {
    lines.push("", "## Reflection", "", REFLECTION);
  }

  if (input.onboarding !== null) {
    lines.push("", "## First turn", "", renderOnboardingPreamble(input.onboarding));
  }

  const last = input.lastTurn;
  if (last !== null && (last.exitReason === "error" || last.exitReason === "timeout")) {
    lines.push(
      "",
      "## Your previous turn did not finish",
      "",
      `It ended with ${last.exitReason}${last.error === null ? "" : `: ${last.error}`}.`,
      "The worktree may hold uncommitted changes. Run git status before doing anything else.",
    );
  }

  const society = input.societyView;
  if (society !== undefined && society !== null) {
    lines.push("", "## The society", "", "### Projects", "");
    if (society.projects.length === 0) {
      lines.push("None yet.");
    }
    for (const project of society.projects) {
      lines.push(
        `- ${project.slug} "${project.name}": channels ${project.channels.join(", ")}; members ${
          project.members.length === 0 ? "none" : project.members.join(", ")
        }`,
      );
    }
    lines.push("", "### Citizens", "");
    for (const member of society.members) {
      lines.push(rosterLine(member));
    }
  }

  const knowledge = input.knowledge;
  if (knowledge !== undefined && knowledge !== null) {
    lines.push("", `## Knowledge of ${dispatch.project}`, "");
    if (knowledge.topics.length === 0) {
      lines.push(
        "None yet. A durable fact about this scope's codebase or process is worth a write_knowledge call.",
      );
    } else {
      lines.push(
        `Topics under ${knowledge.dir}; open one with your file tools when it is relevant.`,
        "",
      );
      for (const topic of knowledge.topics) {
        lines.push(`- ${topic.topic}: updated by ${topic.updatedBy} at ${topic.updatedAt}`);
      }
    }
  }

  lines.push("", "## Claims you hold", "");
  if (input.heldClaims.length === 0) {
    lines.push("None.");
  } else {
    for (const task of input.heldClaims) {
      lines.push(
        `- ${task.id} "${task.title}" (${task.status}, lease until ${task.leaseExpiresAt ?? "unknown"})`,
      );
    }
  }

  lines.push("", `## Inbox (${input.messages.length} unread)`, "");
  if (input.messages.length === 0) {
    lines.push("Nothing new.");
  } else {
    for (const message of input.messages) {
      const where =
        message.thread === undefined
          ? message.channel
          : `${message.channel} thread ${message.thread}`;
      lines.push(
        `### [${message.ts}] ${where} from @${message.author} (message ${message.id})`,
        "",
        clip(message.body),
        "",
      );
    }
  }

  lines.push(
    "## What to do",
    "",
    "Act on the inbox and your claims through the board tools. Post replies with post_message, claim work with claim_task, submit with update_task, and ask for what the society lacks with propose. Silence is allowed when nothing needs a reply. End with the status object.",
  );
  return `${lines.join("\n")}\n`;
}
