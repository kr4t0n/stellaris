import { randomUUID } from "node:crypto";
import {
  getSessionInfo,
  query,
  type Options,
  type PermissionMode,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ZERO_USAGE,
  type AgentBackend,
  type SessionId,
  type TurnRequest,
  type TurnResult,
} from "@stellaris/runner-core";
import {
  AGENT_TOKEN_ENV,
  TurnStatusSchema,
  type AgentEvent,
  type TurnExitReason,
  type TurnStatus,
  type Usage,
} from "@stellaris/shared";

export interface ClaudeBackendOptions {
  readonly model?: string | undefined;
  readonly effort?: Options["effort"] | undefined;
  readonly permissionMode?: PermissionMode | undefined;
  /** Permission rules auto-allowed without a prompt. Board tools and git are the minimum. */
  readonly allowedTools?: readonly string[] | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stderr?: ((line: string) => void) | undefined;
  readonly pathToClaudeCodeExecutable?: string | undefined;
  readonly runnerName?: string | undefined;
}

export const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  "mcp__board",
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "Glob",
  "Grep",
  "Bash(git:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(pnpm:*)",
  "Bash(npm:*)",
  "Bash(node:*)",
];

interface Block {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
}

interface TurnState {
  usage: Usage;
  costUsd: number;
  finalText: string;
  structured: unknown;
  exitReason: TurnExitReason;
  error: string | undefined;
  sawResult: boolean;
}

function isBlock(value: unknown): value is Block {
  return typeof value === "object" && value !== null;
}

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? content.filter(isBlock) : [];
}

function numberField(raw: unknown, key: string): number {
  if (typeof raw !== "object" || raw === null) {
    return 0;
  }
  const value: unknown = Reflect.get(raw, key);
  return typeof value === "number" ? value : 0;
}

function usageOf(raw: unknown): Usage {
  return {
    inputTokens: numberField(raw, "input_tokens"),
    outputTokens: numberField(raw, "output_tokens"),
    cacheReadTokens: numberField(raw, "cache_read_input_tokens"),
    cacheWriteTokens: numberField(raw, "cache_creation_input_tokens"),
  };
}

/** The status object from the SDK's structured output, or from a JSON block in the final text as a fallback. */
export function parseTurnStatus(structured: unknown, finalText: string): TurnStatus | null {
  const direct = TurnStatusSchema.safeParse(structured);
  if (direct.success) {
    return direct.data;
  }
  const fenced = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: unknown = null;
  while ((match = fenced.exec(finalText)) !== null) {
    try {
      last = JSON.parse(match[1] ?? "");
    } catch {
      // keep looking
    }
  }
  if (last === null) {
    const brace = finalText.lastIndexOf("{");
    if (brace !== -1) {
      try {
        last = JSON.parse(finalText.slice(brace));
      } catch {
        return null;
      }
    }
  }
  const parsed = TurnStatusSchema.safeParse(last);
  return parsed.success ? parsed.data : null;
}

/** The subprocess environment: inherit, add the board token, and drop nested-session markers. */
export function subprocessEnv(
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string | undefined>>,
  token: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({ ...base, ...extra })) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) {
      continue;
    }
    env[key] = value;
  }
  env[AGENT_TOKEN_ENV] = token;
  return env;
}

/**
 * Claude Code through the Claude Agent SDK: one SDK call per wakeup, resuming the pair's session.
 * Instructions, permissions, and the board's MCP endpoint travel as options, so no user-level
 * configuration leaks into the agent and no token is written to disk.
 */
export class ClaudeAgentBackend implements AgentBackend {
  readonly kind = "claude" as const;

  constructor(private readonly options: ClaudeBackendOptions = {}) {}

  /** The session id is chosen up front so the runner can record it before the turn starts. */
  newSession(): Promise<SessionId> {
    return Promise.resolve(randomUUID());
  }

  async runTurn(request: TurnRequest, onEvent?: (event: AgentEvent) => void): Promise<TurnResult> {
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), request.limits.timeoutMs);
    const toolNames = new Map<string, string>();
    const state: TurnState = {
      usage: ZERO_USAGE,
      costUsd: 0,
      finalText: "",
      structured: null,
      exitReason: "error",
      error: undefined,
      sawResult: false,
    };

    // The runner records the session id before the first turn so a crash cannot lose it. If that
    // first turn died before the CLI wrote anything, the id names no session yet: create it now.
    const resumable = request.newSession
      ? false
      : await this.sessionExists(request.session, request.spec.cwd);

    try {
      for await (const message of query({
        prompt: request.prompt,
        options: this.buildOptions(request, abort, resumable),
      })) {
        this.handle(message, request, emit, toolNames, state);
      }
    } catch (caught) {
      if (!abort.signal.aborted) {
        state.exitReason = "error";
        state.error = caught instanceof Error ? caught.message : String(caught);
      }
    } finally {
      clearTimeout(timer);
    }

    if (abort.signal.aborted) {
      state.exitReason = "timeout";
      state.error = `turn exceeded ${request.limits.timeoutMs} ms`;
    } else if (!state.sawResult && state.error === undefined) {
      state.error = "the session ended without a result message";
    }
    const status = parseTurnStatus(state.structured, state.finalText);
    if (state.exitReason === "completed" && status === null && state.error === undefined) {
      state.error = "the turn ended without a parsable status object";
    }
    if (state.error !== undefined) {
      emit({ type: "error", message: state.error });
    }
    emit({
      type: "turn_completed",
      usage: state.usage,
      costUsd: state.costUsd,
      status,
      exitReason: state.exitReason,
    });
    return {
      events,
      finalText: state.finalText,
      usage: state.usage,
      costUsd: state.costUsd,
      status,
      exitReason: state.exitReason,
      ...(state.error === undefined ? {} : { error: state.error }),
    };
  }

  private async sessionExists(session: SessionId, cwd: string): Promise<boolean> {
    try {
      return (await getSessionInfo(session, { dir: cwd })) !== undefined;
    } catch {
      return false;
    }
  }

  private buildOptions(request: TurnRequest, abort: AbortController, resumable: boolean): Options {
    const model = request.spec.model ?? this.options.model;
    return {
      cwd: request.spec.cwd,
      // The home holds memory and skills the agent authors; the board projection is what it searches.
      additionalDirectories: [request.spec.configHome, request.spec.boardDir],
      ...(resumable ? { resume: request.session } : { sessionId: request.session }),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: request.instructions,
        snapshot: true,
      },
      settingSources: ["project"],
      mcpServers: {
        board: {
          type: "http",
          url: request.mcp.url,
          headers: { Authorization: `Bearer ${request.mcp.token}` },
          alwaysLoad: true,
        },
      },
      strictMcpConfig: true,
      permissionMode: this.options.permissionMode ?? "acceptEdits",
      permissionPrompts: "none",
      allowedTools: [...(this.options.allowedTools ?? DEFAULT_ALLOWED_TOOLS)],
      ...(this.options.disallowedTools === undefined
        ? {}
        : { disallowedTools: [...this.options.disallowedTools] }),
      maxTurns: request.limits.maxTurns ?? 60,
      ...(request.limits.maxBudgetUsd === undefined
        ? {}
        : { maxBudgetUsd: request.limits.maxBudgetUsd }),
      outputFormat: { type: "json_schema", schema: request.statusSchema },
      abortController: abort,
      env: subprocessEnv(process.env, { ...this.options.env, ...request.env }, request.mcp.token),
      ...(model === undefined ? {} : { model }),
      ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
      ...(this.options.stderr === undefined ? {} : { stderr: this.options.stderr }),
      ...(this.options.pathToClaudeCodeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable }),
    };
  }

  private handle(
    message: SDKMessage,
    request: TurnRequest,
    emit: (event: AgentEvent) => void,
    toolNames: Map<string, string>,
    state: TurnState,
  ): void {
    switch (message.type) {
      case "system": {
        if ("subtype" in message && message.subtype === "init") {
          emit({
            type: "turn_started",
            agent: request.spec.agent,
            session: message.session_id,
            runner: this.options.runnerName ?? "local",
          });
        }
        return;
      }
      case "assistant": {
        for (const block of blocksOf(message.message.content)) {
          if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            emit({ type: "text", delta: block.text });
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            if (typeof block.id === "string") {
              toolNames.set(block.id, block.name);
            }
            emit({ type: "tool_call", name: block.name, input: block.input });
          }
        }
        return;
      }
      case "user": {
        for (const block of blocksOf(message.message.content)) {
          if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
            emit({
              type: "tool_result",
              name: toolNames.get(block.tool_use_id) ?? "unknown",
              ok: block.is_error !== true,
            });
          }
        }
        return;
      }
      case "result": {
        state.sawResult = true;
        state.usage = usageOf(message.usage);
        state.costUsd = message.total_cost_usd;
        if (message.subtype === "success") {
          state.finalText = message.result;
          state.structured = message.structured_output ?? null;
          state.exitReason = "completed";
          return;
        }
        const detail = message.errors.join("; ");
        switch (message.subtype) {
          case "error_max_structured_output_retries":
            state.exitReason = "completed";
            state.error = `no valid status object: ${detail}`;
            return;
          case "error_max_turns":
            state.exitReason = "error";
            state.error = `turn limit reached: ${detail}`;
            return;
          case "error_max_budget_usd":
            state.exitReason = "error";
            state.error = `budget exhausted: ${detail}`;
            return;
          default:
            state.exitReason = "error";
            state.error = detail || "error during execution";
            return;
        }
      }
      default:
        return;
    }
  }
}
