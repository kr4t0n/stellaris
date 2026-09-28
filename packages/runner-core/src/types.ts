import type {
  AgentEvent,
  CliKind,
  Name,
  TurnExitReason,
  TurnStatus,
  Usage,
} from "@stellaris/shared";

export type SessionId = string;

export interface AgentSpec {
  readonly agent: Name;
  readonly project: Name;
  readonly cli: CliKind;
  /** The agent-project worktree. */
  readonly cwd: string;
  /** The project's canonical clone the worktree hangs off; git writes its metadata there. */
  readonly repoDir: string;
  /** The agent's home directory: memory, skills, notes, and the rendered CLI config directories. */
  readonly configHome: string;
  /** The board's read-only markdown projection on this runner. */
  readonly boardDir: string;
  readonly model?: string | undefined;
}

export interface TurnLimits {
  readonly timeoutMs: number;
  readonly maxTurns?: number | undefined;
  readonly maxBudgetUsd?: number | undefined;
}

/** Everything a CLI needs for one turn, in CLI-agnostic terms. */
export interface TurnRequest {
  readonly spec: AgentSpec;
  readonly session: SessionId;
  /** True when the session id was just chosen and nothing exists to resume. */
  readonly newSession: boolean;
  readonly prompt: string;
  /** The rendered role charter plus memory core, appended to the CLI's own system prompt. */
  readonly instructions: string;
  readonly mcp: { readonly url: string; readonly token: string };
  readonly limits: TurnLimits;
  /** JSON Schema for the structured status the turn must end with. */
  readonly statusSchema: Record<string, unknown>;
  /** Extra environment for the CLI process, for example git identity. */
  readonly env: Readonly<Record<string, string>>;
}

export interface TurnResult {
  readonly events: readonly AgentEvent[];
  readonly finalText: string;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly status: TurnStatus | null;
  readonly exitReason: TurnExitReason;
  readonly error?: string | undefined;
  /**
   * The session the CLI actually used. Set when it differs from the requested one, for CLIs
   * that assign their own ids on the first turn; the runner records it for the next turn.
   */
  readonly session?: SessionId | undefined;
}

/** What a resident session needs at start: everything a turn needs except the prompt. */
export interface ResidentStart {
  readonly session: SessionId;
  readonly newSession: boolean;
  readonly instructions: string;
  readonly mcp: { readonly url: string; readonly token: string };
  readonly limits: TurnLimits;
  readonly statusSchema: Record<string, unknown>;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * A warm session: the CLI process stays alive between turns and each prompt becomes one turn,
 * which is what brings a front-desk reply down from tens of seconds to a few.
 */
export interface ResidentSession {
  /** The session in use, which may differ from the requested one for CLIs that assign their own ids. */
  readonly session: SessionId;
  runTurn(prompt: string, onEvent?: (event: AgentEvent) => void): Promise<TurnResult>;
  close(): Promise<void>;
}

/** One interface for every CLI. Implemented per CLI inside a runner. */
export interface AgentBackend {
  readonly kind: CliKind;
  newSession(spec: AgentSpec): Promise<SessionId>;
  runTurn(request: TurnRequest, onEvent?: (event: AgentEvent) => void): Promise<TurnResult>;
  interrupt?(session: SessionId): Promise<void>;
  /** Backends that can keep a session warm implement this; the runner uses it for resident roles. */
  startResident?(spec: AgentSpec, start: ResidentStart): Promise<ResidentSession>;
}

export const ZERO_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
