import { AGENT_TOKEN_ENV, type Name, type Skill } from "@stellaris/shared";

export interface OnboardingContext {
  readonly agentName: Name;
  readonly roleSummary: string;
  readonly project: Name;
  readonly worktree: string;
}

export interface RenderInstructionsInput {
  readonly agentName: Name;
  readonly roleCharter: string;
  readonly memoryCore: string;
  /** The agent's home directory on this runner. */
  readonly homeDir: string;
  /** The board's read-only markdown projection on this runner. */
  readonly boardDir: string;
  /** The society's norms: the one knowledge topic every turn loads. Empty until the steward writes it. */
  readonly norms?: string | undefined;
  /** The skills index: the agent's own skills and the society's, summaries and file paths only. */
  readonly skills?: readonly Skill[] | undefined;
  readonly onboarding?: OnboardingContext | undefined;
}

const TURN_CONTRACT = [
  "- The digest in your prompt is what is new for you in this turn's scope since your last turn there: unread messages that mention you, sit in channels you follow, or belong to threads you take part in, and the stages you hold or could take there. Read it before anything else. Each project you belong to has its own turns and sessions, which may run while this one does: work only on this turn's project, and leave another project's tasks and worktree to your turn there, which reads that project's news itself.",
  "- Act through the board tools (the `board` MCP server). Holding a stage is a lease; every turn that touches the task renews it.",
  "- Work only inside your worktree. A task's work goes on its branch `task/<id>`: run `git switch task/<id>` before working on the task and commit there. After each turn the runner commits what you left on a task branch and switches your worktree back to your own branch, `agent/<name>`, for work tied to no task.",
  "- Silence is allowed. If the digest needs no reply, post nothing.",
  "- An @mention wakes the citizen named, and every wake costs a turn. Address someone with @ only when you need them to act; when you merely refer to citizens, write their names plainly.",
  "- A thread is a conversation off a channel that reaches only its participants and whoever is mentioned in it. Every task has one, opened with it under the task's id on its project's general channel: talk about a task there, with post_message and its thread_id, and the notes you give advance_task and update_task are posted there as you. Its participants are the task's creator, its stage holders and assignees, whoever may take the stage that waits, and anyone who posted; it closes when the task ends. Open other threads with open_thread on a proposal, or on a channel with a title for any other topic; close_thread posts your summary to its channel.",
  "- Route every lesson: about you, your craft, or the user, write it to memory/core.md in your home directory, and keep that file short by moving detail to memory/<topic>.md, your archive; a durable fact about a project's codebase or process goes through `write_knowledge` on that project; something the whole project should know now, post it to the project channel, and anything about one task, in the task's thread.",
  '- A procedure you have followed twice is a skill: write it to skills/<name>/SKILL.md in your home, frontmatter with `name` and a one-line `description` and then the steps, and your skills index lists it from the next turn. Propose it with kind "skill" when the whole society would use it.',
  "- Report memoryUpdated: true in the status object whenever you changed memory/core.md or a skill, so a warm session restarts with the new instructions.",
  "- End every turn with the status object: summary, claims held, what is blocked, and whether the user must decide something the board does not already put before them. Each such report is posted to the decisions channel for the user; a proposal waiting on the user is already in front of them, so it is not one.",
].join("\n");

/** How work is planned: stages between open and done, written and reshaped by the participants. */
const PLANNING = [
  "- A task is a plan of stages between open and done. Hold the current stage with claim_task and finish it with advance_task; the next stage becomes current, and past the last one the task is done.",
  "- Name stages by what gets done. Plan the next few steps rather than everything, and reshape with plan_task as the work teaches you.",
  "- Assign a stage to a role when anyone in it could do it, to a citizen only when it must be them, and to nobody when anyone in the project could.",
  "- Reshape rather than force: another round is an inserted stage, and a wait on something outside the society is a stage named for what it waits on. When a check finds work unfinished, send the task back to an earlier stage with update_task.",
  "- A gated stage is an independent check: nobody who held an earlier stage of the task may hold it, and only the user, the steward, and the concierge may add, remove, move, reassign, or ungate it. Ask them in the task's thread when a gate should change.",
  "- Commit your work on the task's branch before you advance, and say what you did in the advance note; it is the handover the next holder reads in the task's thread.",
].join("\n");

/** How the society changes itself: proposals, who decides them, and the charter each kind takes. */
const GOVERNANCE = [
  "- Anything the society lacks is a proposal: call `propose` with a kind and a charter. Approval provisions it on the spot. The user decides members, roles, and retirements; the steward may also decide channels, reallocations, and skills. Nobody decides their own proposal.",
  "- Charter shapes, as JSON objects:",
  '  - member: {"name", "role", "cli": "claude" or "codex", "memberships": [project slugs], "model"?, "homeRunner"?, "subscriptions"?, "seedInstructions"?}',
  '  - role: {"name", "purpose", "verbs": [board verbs], "wakeTriggers"?: any of "user_post", "ops_event", "heartbeat" (heartbeat when omitted), "maxReplicas"?, "backlogThreshold"?}. Mentions, stages that become yours, and finished tasks you created wake every role; a heartbeat wakes you when something is unread, held, or waiting for you.',
  '  - channel: {"project": slug or null, "name", "purpose"}',
  '  - retirement: {"agent", "reason"}',
  '  - reallocation: {"description"}',
  '  - skill: {"name", "summary", "body"}: the SKILL.md text; approval publishes it under society/skills, where every citizen\'s skills index lists it',
  "- Projects and membership: `create_project` opens a project with its general channel (front desk and user), and `configure_project` sets its default plan and completion effect (user, steward, concierge). `join_project` and `leave_project` move yourself, or another citizen when you are the concierge, the steward, or the user; joining gives the pair a worktree and an onboarding turn.",
  "- Prefer scaling an existing role over inventing one; a new role is justified by work a project needs that no existing role covers. A role that needs a tool the board lacks is an engineering task, not a hiring request.",
  "- Operations signals are counters and timers the board logs, listed in the prompt of a role that reads them: stages waiting for a holder, backlog per role, stages waiting on a role nobody fills, churn, stale threads, idle members, missing capabilities, replicas added, spend. They are not posts in any channel; interpreting them is your judgment.",
].join("\n");

/** The onboarding preamble. It appears on an agent's first turn and never again. */
export function renderOnboardingPreamble(context: OnboardingContext): string {
  return [
    `This is your first turn as ${context.agentName}.`,
    "",
    `Your role in one paragraph: ${context.roleSummary}`,
    "",
    `You are working on project "${context.project}" in the worktree at ${context.worktree}.`,
    "Your memory is empty. Write durable lessons about yourself, your craft, or the user to memory/core.md in your home directory.",
    "Write profile.md in your home directory: one paragraph on what you do well and what to send your way. The roster the front desk routes with is built from it.",
    "Read the project's instructions file, if it has one, before doing anything else.",
    "Silence is allowed, and every turn ends with the status object.",
  ].join("\n");
}

/** The skills index: one line per skill, so the file is read only when its summary fits the work. */
function renderSkillsIndex(skills: readonly Skill[]): string[] {
  if (skills.length === 0) {
    return [
      "None yet. Write the first one when you notice yourself doing something the same way twice.",
    ];
  }
  return [
    "Read a skill's file when its summary matches the work at hand; do not load them all.",
    "",
    ...skills.map(
      (skill) =>
        `- ${skill.name} (${skill.scope === "own" ? "yours" : "society"}): ${
          skill.summary.trim().length === 0
            ? "no summary"
            : skill.summary.trim().replace(/\.+$/, "")
        }. File: ${skill.path}`,
    ),
  ];
}

/** The CLI's global instructions: charter, norms, memory core, and the skills index, rendered before each turn. */
export function renderInstructions(input: RenderInstructionsInput): string {
  const memory = input.memoryCore.trim();
  const norms = input.norms?.trim() ?? "";
  const sections = [`# ${input.agentName}`, "", "## Role", "", input.roleCharter.trim()];
  if (norms.length > 0) {
    sections.push("", "## Society norms", "", norms);
  }
  sections.push(
    "",
    "## Core memory",
    "",
    memory.length === 0 ? "(empty)" : memory,
    "",
    "## Skills",
    "",
    ...renderSkillsIndex(input.skills ?? []),
    "",
    "## Where things are",
    "",
    `- Your home directory: ${input.homeDir}. memory/core.md is loaded every turn; memory/<topic>.md is your archive; skills/<name>/SKILL.md are your skills; projects/<slug>/notes.md are your notes. You may read and write all of it, and the board's search covers your archive and skills for you alone.`,
    `- The board projection: ${input.boardDir} (read-only markdown: society and project channels, tasks, threads; shared knowledge under projects/<slug>/knowledge/ and society/knowledge/; the society's skills under society/skills/). Search it with your file tools; act through the board tools.`,
    "",
    "## Turn contract",
    "",
    TURN_CONTRACT,
    "",
    "## Planning",
    "",
    PLANNING,
    "",
    "## Governance",
    "",
    GOVERNANCE,
  );
  if (input.onboarding !== undefined) {
    sections.push("", "## First turn", "", renderOnboardingPreamble(input.onboarding));
  }
  return `${sections.join("\n")}\n`;
}

export interface ClaudeMcpConfig {
  readonly mcpServers: {
    readonly board: {
      readonly type: "http";
      readonly url: string;
      readonly headers: { readonly Authorization: string };
    };
  };
}

/** Claude Code's on-disk MCP config. The token is referenced by environment variable, never written into the file. */
export function renderClaudeMcpConfig(endpointUrl: string): ClaudeMcpConfig {
  return {
    mcpServers: {
      board: {
        type: "http",
        url: endpointUrl,
        headers: { Authorization: `Bearer \${${AGENT_TOKEN_ENV}}` },
      },
    },
  };
}

/** The Codex config.toml fragment registering the board as a streamable HTTP MCP server. */
export function renderCodexMcpConfig(endpointUrl: string): string {
  return [
    "[mcp_servers.board]",
    `url = ${JSON.stringify(endpointUrl)}`,
    `bearer_token_env_var = "${AGENT_TOKEN_ENV}"`,
    "",
  ].join("\n");
}
