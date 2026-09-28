import {
  AGENT_TOKEN_ENV,
  type AgentEvent,
  type CliKind,
  type Name,
  type TurnExitReason,
  type TurnStatus,
  type Usage,
} from "@stellaris/shared";

export type SessionId = string;

export interface AgentSpec {
  readonly agent: Name;
  readonly project: Name;
  readonly cli: CliKind;
  /** The agent-project worktree. */
  readonly cwd: string;
  /** The rendered CLI config home for this agent. */
  readonly configHome: string;
  readonly model?: string | undefined;
}

export interface TurnLimits {
  readonly timeoutMs: number;
  readonly maxTurns?: number | undefined;
  readonly maxBudgetUsd?: number | undefined;
}

export interface TurnResult {
  readonly events: readonly AgentEvent[];
  readonly finalText: string;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly status: TurnStatus | null;
  readonly exitReason: TurnExitReason;
}

/** One interface for every CLI. Implemented per CLI inside a runner. */
export interface AgentBackend {
  readonly kind: CliKind;
  newSession(spec: AgentSpec): Promise<SessionId>;
  runTurn(
    spec: AgentSpec,
    session: SessionId,
    prompt: string,
    limits: TurnLimits,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<TurnResult>;
  interrupt?(session: SessionId): Promise<void>;
}

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
  readonly onboarding?: OnboardingContext | undefined;
}

const TURN_CONTRACT = [
  "- The digest in your prompt is your inbox. Read it before anything else.",
  "- Act through the board tools. Claims are leases; every turn that touches a task renews it.",
  "- Silence is allowed. If the digest needs no reply, post nothing.",
  "- Route every lesson: about you, your craft, or the owner, write it to memory/core.md; about this codebase, the project's knowledge directory; something everyone should know, post it.",
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
    "Your memory is empty. Write durable lessons about yourself, your craft, or the owner to memory/core.md.",
    "Read the project's instructions file and its knowledge directory before doing anything else.",
    "Silence is allowed, and every turn ends with the status object.",
  ].join("\n");
}

/** The CLI's global instructions file: role charter plus memory core, rendered before each turn. */
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

/** Claude Code's MCP config. The token is referenced by environment variable, never written into the file. */
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
