import { randomUUID, type UUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getSessionInfo,
  query,
  type EffortLevel,
  type ModelInfo,
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
  type TurnControl,
  type TurnRequest,
  type TurnResult,
} from "@stellaris/runner-core";
import {
  AGENT_TOKEN_ENV,
  capOutput,
  type AgentEvent,
  type ModelOption,
  type TurnExitReason,
  type Usage,
} from "@stellaris/shared";

export { parseTurnStatus };

/** What a query returns: the message stream, plus the controls a resident session uses when the SDK offers them. */
export type QueryStream = AsyncIterable<SDKMessage> & {
  interrupt?: () => Promise<unknown>;
  close?: () => void;
  supportedModels?: () => Promise<ModelInfo[]>;
};

/** Streaming input that never sends a message, for a query opened only to ask the CLI something. */
function silentInput(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined),
    }),
  };
}

/** The SDK's words for each effort level, from its `EffortLevel` documentation. */
const EFFORT_LEVELS: Readonly<Record<EffortLevel, string>> = {
  low: "Minimal thinking, fastest responses",
  medium: "Moderate thinking",
  high: "Deep reasoning",
  xhigh: "Deeper than high",
  max: "Maximum effort",
};

/** An effort Claude Code takes, or undefined for one it does not, which then runs the default. */
export function claudeEffort(effort: string | undefined): EffortLevel | undefined {
  return Object.keys(EFFORT_LEVELS).find((level): level is EffortLevel => level === effort);
}

/**
 * The SDK's model list as choices. Its `default` entry is the CLI's own default rather than a model
 * to pin, so it only marks the first model it resolves to. A model's effort levels are those it
 * lists, and `high` is the one it runs unset, as the SDK documents.
 */
export function modelOptions(models: readonly ModelInfo[]): ModelOption[] {
  const fallback = models.find((model) => model.value === "default");
  const target = fallback === undefined ? undefined : (fallback.resolvedModel ?? fallback.value);
  let marked = false;
  return models
    .filter((model) => model.value !== "default")
    .map((model) => {
      const isDefault = !marked && (model.resolvedModel ?? model.value) === target;
      marked ||= isDefault;
      const levels = model.supportsEffort === false ? [] : (model.supportedEffortLevels ?? []);
      return {
        id: model.value,
        name: model.displayName,
        description: model.description,
        isDefault,
        efforts: levels.map((level) => ({ id: level, description: EFFORT_LEVELS[level] })),
        ...(levels.includes("high") ? { defaultEffort: "high" } : {}),
      };
    });
}

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
  content?: unknown;
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
  /** The model the CLI announced on its first init message. */
  model: string | undefined;
  /** Whether the turn has seen its init message; the SDK can send more than one per query. */
  initialized: boolean;
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
    initialized: false,
  };
}

function isBlock(value: unknown): value is Block {
  return typeof value === "object" && value !== null;
}

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? content.filter(isBlock) : [];
}

/** A tool result's content as text: a string, or its text blocks, with other blocks named. */
function resultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return blocksOf(content)
    .map((block) =>
      block.type === "text" && typeof block.text === "string"
        ? block.text
        : `[${typeof block.type === "string" ? block.type : "content"}]`,
    )
    .join("\n");
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
      if ("subtype" in message && message.subtype === "init" && !state.initialized) {
        state.initialized = true;
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
      // The CLI echoes the user messages it takes; the prompt and the steers are not steps.
      if ("isReplay" in message && message.isReplay) {
        return;
      }
      for (const block of blocksOf(message.message.content)) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const output = resultText(block.content);
          emit({
            type: "tool_result",
            name: toolNames.get(block.tool_use_id) ?? "unknown",
            ok: block.is_error !== true,
            ...(output === "" ? {} : { output: capOutput(output) }),
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
    ...(state.sawResult ? { sessionCostUsd: state.totalCostUsd } : {}),
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(id: string): id is UUID {
  return UUID_PATTERN.test(id);
}

/**
 * A user message for the CLI's streaming input, with an id the CLI echoes when it takes it. A
 * steer goes in with priority `next`, which the CLI folds into the running turn between steps;
 * left unset, the priority may be `later`, which waits for the turn to end, and `now` would
 * interrupt the step in flight.
 */
function userMessage(text: string, uuid: UUID, steer = false): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid,
    ...(steer ? { priority: "next" as const } : {}),
  };
}

/** The id of the user message a message echoes, as the CLI does for each one it takes. */
function echoed(message: SDKMessage): string | null {
  return message.type === "user" && "isReplay" in message && message.isReplay ? message.uuid : null;
}

interface ActiveTurn {
  readonly state: TurnState;
  readonly emit: (event: AgentEvent) => void;
  readonly toolNames: Map<string, string>;
  readonly settle: () => void;
  /**
   * The prompt's id, and whether the CLI has taken it. A resumed session can run a turn of its own
   * first, for a background task left from before, whose result does not end this turn.
   */
  readonly prompt: string;
  promptTaken: boolean;
  /** Steers pushed into the turn and not yet echoed: the turn waits for them before it ends. */
  readonly outstanding: Set<string>;
  stopped: boolean;
}

const INTERRUPT_GRACE_MS = 15_000;

/**
 * A warm Claude Code session: one SDK query over streaming input that stays open between turns.
 * Each pushed user message is a turn that ends with its own result message; costs are reported
 * cumulatively by the SDK, from the total a resumed transcript saved, so the session keeps the
 * running total and hands back the delta.
 */
class ClaudeResident implements ResidentSession {
  session: SessionId;
  private readonly source = new PushSource<SDKUserMessage>();
  private readonly stream: QueryStream;
  private readonly pumping: Promise<void>;
  private active: ActiveTurn | null = null;
  private ended = false;
  private endedWith: string | undefined;
  private lastTotalCostUsd: number;
  private model: string | undefined;

  constructor(
    private readonly context: HandlerContext,
    private readonly limits: { timeoutMs: number | null },
    session: SessionId,
    costSoFarUsd: number,
    queryFn: QueryFn,
    options: Options,
    private readonly record: ((lines: readonly string[]) => Promise<void>) | null,
  ) {
    this.session = session;
    this.lastTotalCostUsd = costSoFarUsd;
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
        const echo = echoed(message);
        if (echo === turn.prompt) {
          turn.promptTaken = true;
          continue;
        }
        if (echo !== null && turn.outstanding.delete(echo)) {
          turn.emit({ type: "steered", steer: echo });
          continue;
        }
        handleMessage(message, this.context, turn.emit, turn.toolNames, turn.state);
        // A steer pushed as the CLI ended its turn runs at once as a continuation; the turn waits for it.
        if (
          message.type === "result" &&
          (turn.stopped || (turn.promptTaken && turn.outstanding.size === 0))
        ) {
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

  async runTurn(
    prompt: string,
    onEvent?: (event: AgentEvent) => void,
    control?: TurnControl,
  ): Promise<TurnResult> {
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
    const promptId = randomUUID();
    const turn: ActiveTurn = {
      state,
      emit,
      toolNames: new Map(),
      settle,
      prompt: promptId,
      promptTaken: false,
      outstanding: new Set(),
      stopped: false,
    };
    this.active = turn;
    emit({
      type: "turn_started",
      agent: this.context.agent,
      session: this.session,
      runner: this.context.runner,
      ...(this.model === undefined ? {} : { model: this.model }),
    });

    let timedOut = false;
    const limit = this.limits.timeoutMs;
    const timer =
      limit === null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            void this.stream.interrupt?.().catch(() => undefined);
            // An interrupt normally yields a result; if none comes, do not wait forever.
            setTimeout(() => {
              if (this.active !== null) {
                this.active.settle();
              }
            }, INTERRUPT_GRACE_MS).unref?.();
          }, limit);
    this.source.push(userMessage(prompt, promptId));
    const detach = control?.attach({
      steer: (steer) => {
        if (this.active !== turn || turn.stopped || !isUuid(steer.id)) {
          return Promise.resolve(false);
        }
        turn.outstanding.add(steer.id);
        this.source.push(userMessage(steer.text, steer.id, true));
        return Promise.resolve(true);
      },
      stop: () => {
        if (this.active !== turn || turn.stopped) {
          return;
        }
        turn.stopped = true;
        void this.stream.interrupt?.().catch(() => undefined);
        setTimeout(() => {
          if (this.active === turn) {
            turn.settle();
          }
        }, INTERRUPT_GRACE_MS).unref?.();
      },
    });
    await done;
    detach?.();
    clearTimeout(timer);

    if (turn.stopped) {
      state.exitReason = "stopped";
      state.error = undefined;
    } else if (timedOut) {
      state.exitReason = "timeout";
      state.error = `turn exceeded ${limit} ms`;
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
  readonly steers = true;
  readonly stops = true;
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

  /** The models the CLI offers, asked of a query that is closed before it takes a turn. */
  async listModels(): Promise<ModelOption[]> {
    const listing = this.queryFn({
      prompt: silentInput(),
      options: {
        cwd: os.tmpdir(),
        settingSources: [],
        env: subprocessEnv(process.env, this.options.env ?? {}, ""),
        ...(this.options.stderr === undefined ? {} : { stderr: this.options.stderr }),
        ...(this.options.pathToClaudeCodeExecutable === undefined
          ? {}
          : { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable }),
      },
    });
    try {
      return listing.supportedModels === undefined
        ? []
        : modelOptions(await listing.supportedModels());
    } finally {
      listing.close?.();
    }
  }

  /**
   * One turn over streaming input, so the turn can be steered: its prompt is the first message, and
   * each steer is pushed while it runs. The turn ends at a result with no steer outstanding, after
   * which no steer is taken and the input closes; a steer pushed as the CLI ended its turn runs at
   * once in the same process, and the turn ends with that run's result.
   */
  async runTurn(
    request: TurnRequest,
    onEvent?: (event: AgentEvent) => void,
    control?: TurnControl,
  ): Promise<TurnResult> {
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    const abort = new AbortController();
    const limit = request.limits.timeoutMs;
    let timedOut = false;
    const timer =
      limit === null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            abort.abort();
          }, limit);
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
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

    const source = new PushSource<SDKUserMessage>();
    const promptId = randomUUID();
    source.push(userMessage(request.prompt, promptId));
    // A resumed session can run a turn of its own before the prompt, for a background task left
    // from before; only a result after the CLI took the prompt can end this turn.
    let promptTaken = false;
    const outstanding = new Set<string>();
    let open = true;
    let stopped = false;
    const stream = this.queryFn({
      prompt: source,
      options: this.buildOptions(request, abort, resumable),
    });
    const detach = control?.attach({
      steer: (steer) => {
        if (!open || !isUuid(steer.id)) {
          return Promise.resolve(false);
        }
        outstanding.add(steer.id);
        source.push(userMessage(steer.text, steer.id, true));
        return Promise.resolve(true);
      },
      stop: () => {
        if (stopped) {
          return;
        }
        stopped = true;
        open = false;
        void stream.interrupt?.().catch(() => undefined);
        // An interrupt normally yields a result; if none comes, the process goes.
        stopTimer = setTimeout(() => abort.abort(), INTERRUPT_GRACE_MS);
        stopTimer.unref?.();
      },
    });

    try {
      for await (const message of stream) {
        if (this.options.recordDir !== undefined) {
          recorded.push(JSON.stringify(message));
        }
        const echo = echoed(message);
        if (echo === promptId) {
          promptTaken = true;
          continue;
        }
        if (echo !== null && outstanding.delete(echo)) {
          emit({ type: "steered", steer: echo });
          continue;
        }
        handleMessage(message, context, emit, toolNames, state);
        if (message.type !== "result") {
          continue;
        }
        if (stopped) {
          // Steers still queued in the CLI would run after the interrupt; the process goes instead.
          open = false;
          source.end();
          stream.close?.();
        } else if (promptTaken && outstanding.size === 0) {
          open = false;
          source.end();
        }
      }
    } catch (caught) {
      if (!abort.signal.aborted && !stopped) {
        state.exitReason = "error";
        state.error = caught instanceof Error ? caught.message : String(caught);
      }
    } finally {
      open = false;
      detach?.();
      source.end();
      clearTimeout(timer);
      clearTimeout(stopTimer);
    }

    if (this.options.recordDir !== undefined && recorded.length > 0) {
      await this.record(request.spec.agent, recorded);
    }
    if (stopped) {
      state.exitReason = "stopped";
      state.error = undefined;
    } else if (timedOut) {
      state.exitReason = "timeout";
      state.error = `turn exceeded ${limit} ms`;
    } else if (!state.sawResult && state.error === undefined) {
      state.error = "the session ended without a result message";
    }
    // A resumed session's total starts from what its transcript saved: the earlier turns' cost.
    const costSoFarUsd = resumable ? (request.costSoFarUsd ?? 0) : 0;
    const costUsd = state.sawResult ? Math.max(0, state.totalCostUsd - costSoFarUsd) : 0;
    return finishTurn(state, costUsd, events, emit);
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
      resumable ? (start.costSoFarUsd ?? 0) : 0,
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
    const effort = claudeEffort(request.spec.effort) ?? this.options.effort;
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
      // The SDK stops a query after maxTurns rounds; leaving it out sets no limit.
      ...(request.limits.maxTurns === null ? {} : { maxTurns: request.limits.maxTurns ?? 60 }),
      ...(request.limits.maxBudgetUsd === undefined
        ? {}
        : { maxBudgetUsd: request.limits.maxBudgetUsd }),
      outputFormat: { type: "json_schema", schema: request.statusSchema },
      // The CLI echoes each user message as it takes it, which is how a steer is known delivered.
      extraArgs: { "replay-user-messages": null },
      abortController: abort,
      env: subprocessEnv(process.env, { ...this.options.env, ...request.env }, request.mcp.token),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(this.options.stderr === undefined ? {} : { stderr: this.options.stderr }),
      ...(this.options.pathToClaudeCodeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable }),
    };
  }
}
