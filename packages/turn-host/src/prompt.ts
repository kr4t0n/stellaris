import {
  stageIndex,
  type HomeConflict,
  type Knowledge,
  type Member,
  type Message,
  type OpsSignal,
  type Project,
  type Stage,
  type Task,
  isTaskStep,
  type MessageStep,
  type Thread,
  type TurnDispatch,
  type TurnRecord,
  type Ulid,
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
  /** Tasks in the turn's project whose current stage waits for a holder the agent could be. */
  readonly waitingStages?: readonly Task[] | undefined;
  /** The turn's project, or null in the society scope. */
  readonly project?: Project | null | undefined;
  readonly lastTurn: TurnRecord | null;
  readonly onboarding: OnboardingContext | null;
  /** Present for roles that route on behalf of the user; absent for everyone else. */
  readonly societyView?: SocietyView | null | undefined;
  readonly knowledge?: KnowledgeView | null | undefined;
  /** The threads the unread messages belong to, by id, for their titles. */
  readonly threads?: ReadonlyMap<Ulid, Thread> | undefined;
  /**
   * The thread whose conversation the turn is in, with its task when it is a task's thread, and
   * whether the conversation is new, in which case `messages` is the whole thread so far. Absent
   * for a turn in the home conversation.
   */
  readonly conversation?: Conversation | null | undefined;
  /**
   * For roles that read operations signals, those logged for this scope since the reader's last
   * turn here, oldest first; absent for everyone else.
   */
  readonly signals?:
    | ReadonlyArray<{ readonly ts: string; readonly signal: OpsSignal }>
    | null
    | undefined;
  /**
   * Files in the citizen's home that two of its turns changed at once on different runners: the
   * kept copies, each beside the file whose version won.
   */
  readonly conflicts?: readonly HomeConflict[] | undefined;
}

/** A thread's conversation as its turn's prompt describes it. */
export interface Conversation {
  readonly thread: Thread;
  readonly task: Task | null;
  readonly fresh: boolean;
}

/** What a reflection turn is for. It replaces new work, not the unread messages. */
const REFLECTION_INTRO =
  "This turn is for your memory; take no new work, and answer unread messages only where a reply is needed. Read memory/core.md and your recent turn records, then:";

/** The first step of a reflection while edits wait in the home, so what it consolidates is whole. */
const RECONCILE =
  "- Reconcile first: merge each copy listed under Edits to reconcile in your home into the file beside it, then delete the copy.";

const REFLECTION_STEPS = [
  "- Consolidate memory/core.md: keep it to lessons that still hold, about sixty lines at most, and move detail worth keeping to memory/<topic>.md in your home, which the board's search covers for you alone.",
  '- Extract a skill: a procedure you have followed twice goes to skills/<name>/SKILL.md, frontmatter with `name` and a one-line `description` and then the steps. Propose it with kind "skill" when other citizens would use it.',
  "- Refresh profile.md: one paragraph on what you do well and what to send your way; the roster the front desk routes with is built from it.",
  "- Share: a durable fact about this scope's codebase or process goes through write_knowledge; a norm the whole society should follow goes to the steward as a plain post in general.",
  "- Report memoryUpdated: true in the status object when core.md or a skill changed.",
];

const MAX_BODY_CHARS = 1_500;
const MAX_PROFILE_CHARS = 200;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_BODY_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_BODY_CHARS)}\n[... truncated]`;
}

function assignee(stage: Stage): string {
  return stage.agent ?? stage.role ?? "anyone";
}

/** What a step's post records, for its heading in the digest. */
function stepPhrase(step: MessageStep): string {
  if (!isTaskStep(step)) {
    return `${step.action} the proposal`;
  }
  if (step.action === "advanced") {
    return step.to === null
      ? `finished ${step.stage}, the last stage`
      : `finished ${step.stage}; the task is now at ${step.to}`;
  }
  if (step.action === "returned") {
    return `sent the task back from ${step.stage} to ${step.to ?? "an earlier stage"}`;
  }
  if (step.action === "abandoned") {
    return `abandoned the task at ${step.stage}`;
  }
  return step.action === "landed"
    ? "landed the task"
    : `could not land the task; it waits at ${step.stage} again`;
}

/** One task as a plan line: its current stage, where that stage sits, and what follows it. */
function planLine(task: Task, whose: string): string {
  const index = stageIndex(task, task.stage);
  const stage = task.stages[index];
  const rest = task.stages
    .slice(index + 1)
    .map((next) => `${next.name} (${next.gate ? "gate, " : ""}${assignee(next)})`);
  const then =
    rest.length === 0
      ? `then ${task.onDone === "merge" ? "the board merges it" : "done"}`
      : `next: ${rest.join(", ")}`;
  const gated = stage?.gate === true ? ", gated" : "";
  return `- ${task.id} "${task.title}": ${stage?.name ?? task.stage} (${whose}, ${index + 1} of ${task.stages.length}${gated}); ${then}`;
}

/** One signal as its reader sees it: when, what, and the numbers behind it. */
function signalLine(ts: string, signal: OpsSignal): string {
  const facts = [
    `value ${signal.value}${signal.threshold === undefined ? "" : `, threshold ${signal.threshold}`}`,
    signal.project === undefined ? "" : `project ${signal.project}`,
    signal.taskId === undefined ? "" : `task ${signal.taskId}`,
  ].filter((fact) => fact.length > 0);
  return `- [${ts}] ${signal.kind}: ${signal.summary} (${facts.join("; ")})`;
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
      "Operations signals arrived; they are listed under Operations signals below. Decide whether a proposal is warranted, and stay silent if not.",
    );
  }
  if (dispatch.trigger.kind === "stage") {
    lines.push(
      "A stage is waiting for you: claim it with claim_task unless you hold it already, do the work in your worktree, which is on the task's branch, commit there, then advance_task. If the plan no longer fits, reshape it with plan_task.",
    );
  }
  if (dispatch.trigger.kind === "task_done") {
    lines.push("A task you created is done. Tell whoever asked for it, if anyone did.");
  }
  if (dispatch.trigger.kind === "proposal_decided") {
    lines.push(
      "A proposal you made was decided; the decision is the last post in its thread. Carry on with what an approval enables or a rejection asks, and stay silent if nothing follows.",
    );
  }
  if (dispatch.trigger.kind === "user_post") {
    lines.push(
      "The user posted. Route it: answer where it was posted, in its thread when it came in one, or create what it needs: a task with a plan whose stages name who does them, a thread, or a project, adding citizens to a project first when they are not members. Stay silent when the user already addressed a citizen and nothing else is needed.",
    );
  }

  const conversation = input.conversation ?? null;
  lines.push("", "## This conversation", "");
  if (conversation === null) {
    lines.push(
      `This turn is in your home conversation for ${dispatch.project}: its channels, and work tied to no thread. Each thread you take part in, a task's, a proposal's, or a topic's, is a conversation of its own with turns of its own; read one when you need it, and leave its work to its turn.`,
    );
  } else {
    const { thread, task } = conversation;
    const about =
      thread.subject === undefined ? "a topic" : `${thread.subject.kind} ${thread.subject.id}`;
    lines.push(
      `This turn is in the thread "${thread.title}" on ${thread.channel}, about ${about}. Only this conversation is below: read anything else you need with get_task, search, or the board's files, and leave other tasks and threads to their own turns. Talk here with post_message and thread_id ${thread.id}.`,
    );
    if (task !== null) {
      lines.push("", `Task ${task.id} "${task.title}", ${task.status}:`, planLine(task, "now"));
      if (task.body.trim() !== "") {
        lines.push("", clip(task.body));
      }
    }
  }

  const conflicts = input.conflicts ?? [];
  if (dispatch.trigger.kind === "reflection") {
    lines.push(
      "",
      "## Reflection",
      "",
      REFLECTION_INTRO,
      ...(conflicts.length > 0 ? [RECONCILE] : []),
      ...REFLECTION_STEPS,
    );
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
        }; on done ${project.onDone}`,
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

  const project = input.project;
  if (project !== undefined && project !== null && project.onDone === "merge") {
    lines.push(
      "",
      `## Project ${project.slug}`,
      "",
      `A finished task lands by the board merging its branch task/<id> into ${project.defaultBranch}. Never merge or fast-forward ${project.defaultBranch} yourself.`,
    );
  }

  if (conflicts.length > 0) {
    lines.push(
      "",
      "## Edits to reconcile in your home",
      "",
      "Two of your turns changed these files at once on different runners. The file in place kept the other turn's version; yours is the copy named here, beside it. Merge what still holds into the file, then delete the copy.",
      "",
      ...conflicts.map(
        (conflict) => `- ${conflict.path}, beside ${conflict.file}, since ${conflict.since}`,
      ),
    );
  }

  const signals = input.signals;
  if (signals !== undefined && signals !== null) {
    lines.push("", "## Operations signals", "");
    if (signals.length === 0) {
      lines.push("None since your last turn here.");
    } else {
      lines.push(
        "Counters and timers the board logged since your last turn here, oldest first. A condition that persists is logged again every few hours; one that clears is not logged.",
        "",
      );
      for (const { ts, signal } of signals) {
        lines.push(signalLine(ts, signal));
      }
    }
  }

  // Stages are a task conversation's business; the home conversation and other threads carry none.
  if (conversation?.task !== null && conversation?.task !== undefined) {
    lines.push("", "## Stages you hold", "");
    if (input.heldClaims.length === 0) {
      lines.push("None.");
    } else {
      for (const task of input.heldClaims) {
        lines.push(`${planLine(task, "yours")}; lease until ${task.leaseExpiresAt ?? "unknown"}`);
      }
    }
  }

  const waiting = input.waitingStages ?? [];
  if (waiting.length > 0) {
    lines.push("", "## Stages waiting for you", "");
    for (const task of waiting.slice(0, 20)) {
      const stage = task.stages[stageIndex(task, task.stage)];
      const whose =
        stage?.agent === dispatch.agent
          ? "yours to take"
          : `open to ${stage === undefined ? "anyone" : assignee(stage)}`;
      lines.push(planLine(task, whose));
    }
  }

  lines.push(
    "",
    conversation?.fresh === true
      ? `## The thread so far (${input.messages.length})`
      : `## Unread messages (${input.messages.length})`,
    "",
  );
  if (input.messages.length === 0) {
    lines.push("Nothing new.");
  } else {
    for (const message of input.messages) {
      const thread = message.thread === undefined ? undefined : input.threads?.get(message.thread);
      const where =
        message.thread === undefined
          ? message.channel
          : thread === undefined
            ? `${message.channel} thread ${message.thread}`
            : `${message.channel} thread "${thread.title}" (${message.thread})`;
      const step = message.step === undefined ? "" : `, who ${stepPhrase(message.step)}`;
      lines.push(
        `### [${message.ts}] ${where} from @${message.author}${step} (message ${message.id})`,
        "",
        clip(message.body),
        "",
      );
    }
  }

  lines.push(
    "## What to do",
    "",
    "Act on the unread messages and your stages through the board tools: claim_task to hold a stage, advance_task when your part is done, plan_task to reshape what comes next, post_message to talk, and propose for what the society lacks. Silence is allowed when nothing needs a reply. End with the status object.",
  );
  return `${lines.join("\n")}\n`;
}
