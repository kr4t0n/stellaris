import { AGENT_TOKEN_ENV, type Name } from "@stellaris/shared";

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
  readonly onboarding?: OnboardingContext | undefined;
}

const TURN_CONTRACT = [
  "- The digest in your prompt is your inbox. Read it before anything else.",
  "- Act through the board tools (the `board` MCP server). Claims are leases; every turn that touches a task renews it.",
  "- Work only inside your worktree and commit on your own branch. Never merge, rebase onto, or fast-forward main yourself: when a reviewer moves a task to done, the board lands the claimer's branch on main and posts the result.",
  "- Silence is allowed. If the digest needs no reply, post nothing.",
  "- Route every lesson: about you, your craft, or the owner, write it to memory/core.md in your home directory; something everyone should know, post it to the project channel.",
  "- End every turn with the status object: summary, claims held, what is blocked, whether the owner must decide.",
].join("\n");

/** The onboarding preamble. It appears on an agent's first turn and never again. */
export function renderOnboardingPreamble(context: OnboardingContext): string {
  return [
    `This is your first turn as ${context.agentName}.`,
    "",
    `Your role in one paragraph: ${context.roleSummary}`,
    "",
    `You are working on project "${context.project}" in the worktree at ${context.worktree}.`,
    "Your memory is empty. Write durable lessons about yourself, your craft, or the owner to memory/core.md in your home directory.",
    "Read the project's instructions file, if it has one, before doing anything else.",
    "Silence is allowed, and every turn ends with the status object.",
  ].join("\n");
}

/** The CLI's global instructions: role charter plus memory core, rendered before each turn. */
export function renderInstructions(input: RenderInstructionsInput): string {
  const memory = input.memoryCore.trim();
  const sections = [
    `# ${input.agentName}`,
    "",
    "## Role",
    "",
    input.roleCharter.trim(),
    "",
    "## Core memory",
    "",
    memory.length === 0 ? "(empty)" : memory,
    "",
    "## Where things are",
    "",
    `- Your home directory: ${input.homeDir} (memory/core.md, skills/, projects/<slug>/notes.md). You may read and write it.`,
    `- The board projection: ${input.boardDir} (read-only markdown: society and project channels, tasks, threads). Search it with your file tools; act through the board tools.`,
    "",
    "## Turn contract",
    "",
    TURN_CONTRACT,
  ];
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
