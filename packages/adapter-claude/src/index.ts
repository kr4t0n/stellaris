import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  getSessionInfo,
  query,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  parseTurnStatus,
  ZERO_USAGE,
  type AgentBackend,
  type AgentSpec,
  type ResidentSession,
  type ResidentStart,
  type SessionId,
  type TurnRequest,
  type TurnResult,
} from "@stellaris/runner-core";
import {
  AGENT_TOKEN_ENV,
  type AgentEvent,
  type TurnExitReason,
  type Usage,
} from "@stellaris/shared";

export { parseTurnStatus };

/** What a query returns: the message stream, plus the controls a resident session uses when the SDK offers them. */
export type QueryStream = AsyncIterable<SDKMessage> & {
  interrupt?: () => Promise<unknown>;
  close?: () => void;
};

/** The SDK entry point, injectable so tests can replay recorded message streams. */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => QueryStream;

export interface ClaudeBackendOptions {
  readonly model?: string | undefined;
  readonly effort?: Options["effort"] | undefined;
  /** Defaults to `bypassPermissions`; another mode with `allowedTools` restricts this runner's agents. */
  readonly permissionMode?: PermissionMode | undefined;
  /** Permission rules auto-allowed without a prompt. Only meaningful with a mode that asks. */
  readonly allowedTools?: readonly string[] | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stderr?: ((line: string) => void) | undefined;
  readonly pathToClaudeCodeExecutable?: string | undefined;
  /** Directory to append raw SDK message streams to, one file per turn, for fixtures. */
  readonly recordDir?: string | undefined;
  readonly queryFn?: QueryFn | undefined;
  readonly sessionExists?: ((session: SessionId, cwd: string) => Promise<boolean>) | undefined;
}

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
  /** Cumulative for the query: per turn on a cold run, running total on a resident session. */
  totalCostUsd: number;
  finalText: string;
  structured: unknown;
  exitReason: TurnExitReason;
  error: string | undefined;
  sawResult: boolean;
  /** The model the CLI announced on its init message. */
  model: string | undefined;
}

interface HandlerContext {
  readonly agent: string;
  readonly runner: string;
  /** Cold turns announce themselves on the SDK's init message; resident turns announce per prompt. */
  readonly announceOnInit: boolean;
}

function freshState(model?: string): TurnState {
  return {
    usage: ZERO_USAGE,
    totalCostUsd: 0,
    finalText: "",
    structured: null,
    exitReason: "error",
    error: undefined,
    sawResult: false,
    model,
  };
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

async function defaultSessionExists(session: SessionId, cwd: string): Promise<boolean> {
  try {
    return (await getSessionInfo(session, { dir: cwd })) !== undefined;
  } catch {
    return false;
  }
}

/** Maps one SDK message onto board events and the turn's state. Shared by cold and resident turns. */
function handleMessage(
  message: SDKMessage,
  context: HandlerContext,
  emit: (event: AgentEvent) => void,
  toolNames: Map<string, string>,
  state: TurnState,
): void {
  switch (message.type) {
    case "system": {
      if ("subtype" in message && message.subtype === "init") {
        state.model = message.model;
        if (context.announceOnInit) {
          emit({
            type: "turn_started",
            agent: context.agent,
            session: message.session_id,
            runner: context.runner,
            model: message.model,
          });
        }
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
      state.totalCostUsd = message.total_cost_usd;
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

/** Turns a finished turn's state into the result every backend returns, emitting the closing events. */
function finishTurn(
  state: TurnState,
  costUsd: number,
  events: AgentEvent[],
  emit: (event: AgentEvent) => void,
): TurnResult {
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
    costUsd,
    status,
    exitReason: state.exitReason,
  });
  return {
    events,
    finalText: state.finalText,
    usage: state.usage,
    costUsd,
    status,
    exitReason: state.exitReason,
    ...(state.error === undefined ? {} : { error: state.error }),
    ...(state.model === undefined ? {} : { model: state.model }),
  };
}

/** An async iterable that a producer pushes into: the SDK reads user messages from it as they arrive. */
class PushSource<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private ended = false;

  push(item: T): void {
    if (this.ended) {
      return;
    }
    if (this.waiting !== null) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
      return;
    }
    this.queue.push(item);
  }

  end(): void {
    this.ended = true;
    if (this.waiting !== null) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          const item = this.queue.shift();
          if (item !== undefined) {
            resolve({ value: item, done: false });
          } else if (this.ended) {
            resolve({ value: undefined, done: true });
          } else {
            this.waiting = resolve;
          }
        }),
    };
  }
}

interface ActiveTurn {
  readonly state: TurnState;
  readonly emit: (event: AgentEvent) => void;
  readonly toolNames: Map<string, string>;
  readonly settle: () => void;
}

const INTERRUPT_GRACE_MS = 15_000;

/**
 * A warm Claude Code session: one SDK query over streaming input that stays open between turns.
 * Each pushed user message is a turn that ends with its own result message; costs are reported
 * cumulatively by the SDK, so the session keeps the running total and hands back the delta.
 */
class ClaudeResident implements ResidentSession {
  session: SessionId;
  private readonly source = new PushSource<SDKUserMessage>();
  private readonly stream: QueryStream;
  private readonly pumping: Promise<void>;
  private active: ActiveTurn | null = null;
  private ended = false;
  private endedWith: string | undefined;
  private lastTotalCostUsd = 0;
  private model: string | undefined;

  constructor(
    private readonly context: HandlerContext,
    private readonly limits: { timeoutMs: number },
    session: SessionId,
    queryFn: QueryFn,
    options: Options,
    private readonly record: ((lines: readonly string[]) => Promise<void>) | null,
  ) {
    this.session = session;
    this.stream = queryFn({ prompt: this.source, options });
    this.pumping = this.pump();
  }

  private async pump(): Promise<void> {
    const recorded: string[] = [];
    try {
      for await (const message of this.stream) {
        if (this.record !== null) {
          recorded.push(JSON.stringify(message));
        }
        if (message.type === "system" && "subtype" in message && message.subtype === "init") {
          this.session = message.session_id;
          this.model = message.model;
        }
        const turn = this.active;
        if (turn === null) {
          continue;
        }
        handleMessage(message, this.context, turn.emit, turn.toolNames, turn.state);
        if (message.type === "result") {
          turn.settle();
        }
      }
    } catch (caught) {
      this.endedWith = caught instanceof Error ? caught.message : String(caught);
    } finally {
      this.ended = true;
      if (this.record !== null && recorded.length > 0) {
        await this.record(recorded).catch(() => undefined);
      }
      const turn = this.active;
      if (turn !== null) {
        turn.state.exitReason = "error";
        turn.state.error = this.endedWith ?? "the resident session ended during the turn";
        turn.settle();
      }
    }
  }

  async runTurn(prompt: string, onEvent?: (event: AgentEvent) => void): Promise<TurnResult> {
    if (this.ended) {
      throw new Error(this.endedWith ?? "the resident session has ended");
    }
    if (this.active !== null) {
      throw new Error("a turn is already running on this resident session");
    }
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    const state = freshState(this.model);
    const { promise: done, resolve } = Promise.withResolvers<void>();
    const settle = (): void => {
      this.active = null;
      resolve();
    };
    this.active = { state, emit, toolNames: new Map(), settle };
    emit({
      type: "turn_started",
      agent: this.context.agent,
      session: this.session,
      runner: this.context.runner,
      ...(this.model === undefined ? {} : { model: this.model }),
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.stream.interrupt?.().catch(() => undefined);
      // An interrupt normally yields a result; if none comes, do not wait forever.
      setTimeout(() => {
        if (this.active !== null) {
          this.active.settle();
        }
      }, INTERRUPT_GRACE_MS).unref?.();
    }, this.limits.timeoutMs);
    this.source.push({
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    });
    await done;
    clearTimeout(timer);

    if (timedOut) {
      state.exitReason = "timeout";
      state.error = `turn exceeded ${this.limits.timeoutMs} ms`;
    } else if (!state.sawResult && state.error === undefined) {
      state.error = "the turn ended without a result message";
    }
    const costUsd = Math.max(0, state.totalCostUsd - this.lastTotalCostUsd);
    if (state.sawResult) {
      this.lastTotalCostUsd = state.totalCostUsd;
    }
    return finishTurn(state, costUsd, events, emit);
  }

  async close(): Promise<void> {
    this.source.end();
    this.stream.close?.();
    await Promise.race([
      this.pumping,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 2_000).unref?.();
      }),
    ]);
  }
}

/**
 * Claude Code through the Claude Agent SDK: one query per turn resuming the pair's session, or a
 * resident session that stays open between turns. Instructions, permissions, and the board's MCP
 * endpoint travel as options, so no token is written to disk.
 */
export class ClaudeAgentBackend implements AgentBackend {
  readonly kind = "claude" as const;
  private readonly queryFn: QueryFn;
  private readonly sessionExists: (session: SessionId, cwd: string) => Promise<boolean>;

  constructor(private readonly options: ClaudeBackendOptions = {}) {
    this.queryFn = options.queryFn ?? ((params) => query(params));
    this.sessionExists = options.sessionExists ?? defaultSessionExists;
  }

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
    const recorded: string[] = [];
    const state = freshState();
    const context: HandlerContext = {
      agent: request.spec.agent,
      runner: request.spec.runner,
      announceOnInit: true,
    };

    // The runner records the session id before the first turn so a crash cannot lose it. If that
    // first turn died before the CLI wrote anything, the id names no session yet: create it now.
    const resumable = request.newSession
      ? false
      : await this.sessionExists(request.session, request.spec.cwd);

    try {
      for await (const message of this.queryFn({
        prompt: request.prompt,
        options: this.buildOptions(request, abort, resumable),
      })) {
        if (this.options.recordDir !== undefined) {
          recorded.push(JSON.stringify(message));
        }
        handleMessage(message, context, emit, toolNames, state);
      }
    } catch (caught) {
      if (!abort.signal.aborted) {
        state.exitReason = "error";
        state.error = caught instanceof Error ? caught.message : String(caught);
      }
    } finally {
      clearTimeout(timer);
    }

    if (this.options.recordDir !== undefined && recorded.length > 0) {
      await this.record(request.spec.agent, recorded);
    }
    if (abort.signal.aborted) {
      state.exitReason = "timeout";
      state.error = `turn exceeded ${request.limits.timeoutMs} ms`;
    } else if (!state.sawResult && state.error === undefined) {
      state.error = "the session ended without a result message";
    }
    return finishTurn(state, state.totalCostUsd, events, emit);
  }

  /** A warm session over the SDK's streaming input; every later prompt is one turn on it. */
  async startResident(spec: AgentSpec, start: ResidentStart): Promise<ResidentSession> {
    const resumable = start.newSession ? false : await this.sessionExists(start.session, spec.cwd);
    const request: TurnRequest = {
      spec,
      session: start.session,
      newSession: start.newSession,
      prompt: "",
      instructions: start.instructions,
      mcp: start.mcp,
      limits: start.limits,
      statusSchema: start.statusSchema,
      env: start.env,
    };
    const context: HandlerContext = {
      agent: spec.agent,
      runner: spec.runner,
      announceOnInit: false,
    };
    const record =
      this.options.recordDir === undefined
        ? null
        : (lines: readonly string[]) => this.record(spec.agent, lines);
    return new ClaudeResident(
      context,
      { timeoutMs: start.limits.timeoutMs },
      start.session,
      this.queryFn,
      this.buildOptions(request, new AbortController(), resumable),
      record,
    );
  }

  private async record(agent: string, lines: readonly string[]): Promise<void> {
    const dir = this.options.recordDir ?? ".";
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await appendFile(
      path.join(dir, `claude-${agent}-${stamp}.jsonl`),
      `${lines.join("\n")}\n`,
      "utf8",
    );
  }

  private buildOptions(request: TurnRequest, abort: AbortController, resumable: boolean): Options {
    const model = request.spec.model ?? this.options.model;
    const permissionMode = this.options.permissionMode ?? "bypassPermissions";
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
      // Every permission is granted; the SDK accepts bypass mode only with the explicit flag.
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      permissionPrompts: "none",
      ...(this.options.allowedTools === undefined
        ? {}
        : { allowedTools: [...this.options.allowedTools] }),
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
}
