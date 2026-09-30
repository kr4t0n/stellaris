import type {
  AgentEvent,
  CliKind,
  ModelOption,
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
  /** The runner executing the turn; adapters stamp it on `turn_started`. */
  readonly runner: Name;
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
  /** How long a turn may run before it is stopped, or null for no limit. */
  readonly timeoutMs: number | null;
  /** Rounds of tool calls a turn may take, null for no limit, or the backend's default when unset. */
  readonly maxTurns?: number | null | undefined;
  readonly maxBudgetUsd?: number | undefined;
}

/** Everything a CLI needs for one turn, in CLI-agnostic terms. */
export interface TurnRequest {
  readonly spec: AgentSpec;
  readonly session: SessionId;
  /** True when the session id was just chosen and nothing exists to resume. */
  readonly newSession: boolean;
  readonly prompt: string;
  /** The rendered instructions: charter, society norms, memory core, and skills index. */
  readonly instructions: string;
  readonly mcp: { readonly url: string; readonly token: string };
  readonly limits: TurnLimits;
  /** JSON Schema for the structured status the turn must end with. */
  readonly statusSchema: Record<string, unknown>;
  /** Extra environment for the CLI process, for example git identity. */
  readonly env: Readonly<Record<string, string>>;
  /** The running total the session reported after its last turn, which a resumed session starts from. */
  readonly costSoFarUsd?: number | undefined;
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
  /** The model the CLI reported running for this turn, when it reports one. */
  readonly model?: string | undefined;
  /** The session's running total after this turn, for CLIs that report one; `costUsd` is this turn's share. */
  readonly sessionCostUsd?: number | undefined;
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
  /** The running total the session reported after its last turn, which a resumed session starts from. */
  readonly costSoFarUsd?: number | undefined;
}

/** A warm session: the CLI process stays alive between turns and each prompt becomes one turn. */
export interface ResidentSession {
  /** The session in use, which may differ from the requested one for CLIs that assign their own ids. */
  readonly session: SessionId;
  runTurn(prompt: string, onEvent?: (event: AgentEvent) => void): Promise<TurnResult>;
  close(): Promise<void>;
}

/** One interface for every CLI. */
export interface AgentBackend {
  readonly kind: CliKind;
  newSession(spec: AgentSpec): Promise<SessionId>;
  runTurn(request: TurnRequest, onEvent?: (event: AgentEvent) => void): Promise<TurnResult>;
  interrupt?(session: SessionId): Promise<void>;
  /** Backends that can keep a session warm implement this; the runner uses it for resident roles. */
  startResident?(spec: AgentSpec, start: ResidentStart): Promise<ResidentSession>;
  /** The models the CLI offers, from its own listing, for choosing a citizen's model. */
  listModels?(): Promise<ModelOption[]>;
}

export const ZERO_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
