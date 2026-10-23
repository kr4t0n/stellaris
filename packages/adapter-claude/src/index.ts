import { randomUUID, type UUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  query,
  type EffortLevel,
  type ModelInfo,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CLI_ENV,
  parseTurnStatus,
  ResumeError,
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
  addUsage,
  AGENT_TOKEN_ENV,
  capOutput,
  mergeQuota,
  type AgentEvent,
  type CliQuota,
  type ModelOption,
  type ResumeFailure,
  type TurnExitReason,
  type Usage,
} from "@stellaris/shared";

import { limitedQuota, quotaFromRateLimit, quotaFromUsage } from "./quota.js";

export { parseTurnStatus };
export { limitedQuota, quotaFromRateLimit, quotaFromUsage };

/**
 * The SDK's usage read behind `/usage`, marked experimental and named to say so. Typed from the
 * SDK's own `Query`, so a release that renames or drops it fails the type check here.
 */
type UsageRead = Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"];

/** What a query returns: the message stream, plus the controls a resident session uses when the SDK offers them. */
export type QueryStream = AsyncIterable<SDKMessage> & {
  interrupt?: () => Promise<unknown>;
  close?: () => void;
  supportedModels?: () => Promise<ModelInfo[]>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: UsageRead;
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
  /** The clock quota reports are stamped by; tests inject one. */
  readonly now?: (() => Date) | undefined;
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
  /** The plan quota the turn's rate-limit events reported, merged in order. */
  quota: CliQuota | undefined;
  /** What the CLI said when the API refused the turn for the plan's limit. */
  limitText: string | undefined;
  /** Whether the latest result ended its run on an API error: a success marked `is_error`. */
  apiError: boolean;
  /** Whether the CLI's own message about an API error said the service was overloaded or failing. */
  serverError: boolean;
  /** Whether that API error was the service's to fix, a 5xx or a 529, so a minute may cure it. */
  transient: boolean;
}

interface HandlerContext {
  readonly agent: string;
  readonly runner: string;
  /** Cold turns announce themselves on the SDK's init message; resident turns announce per prompt. */
  readonly announceOnInit: boolean;
  readonly now: () => Date;
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
    quota: undefined,
    limitText: undefined,
    apiError: false,
    serverError: false,
    transient: false,
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

/**
 * The subprocess environment: inherit, add the runner's settings for every CLI and the board
 * token, and drop nested-session markers.
 */
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
  Object.assign(env, CLI_ENV);
  env[AGENT_TOKEN_ENV] = token;
  return env;
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
      // The API refused the turn for the plan's limit: the CLI says so in a synthetic message.
      if (message.error === "rate_limit") {
        const said = blocksOf(message.message.content)
          .map((block) =>
            block.type === "text" && typeof block.text === "string" ? block.text : "",
          )
          .join(" ")
          .trim();
        state.limitText = said.length > 0 ? said : "the plan's usage limit";
        state.quota = limitedQuota(state.quota, context.now());
      }
      // After its own retries, Claude Code says `server_error` for a 5xx or a 529.
      if (message.error === "server_error" || message.error === "overloaded") {
        state.serverError = true;
      }
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
    case "rate_limit_event": {
      // A report the adapter cannot read is dropped: it never changes how the turn ends.
      try {
        const quota = quotaFromRateLimit(message.rate_limit_info, context.now());
        if (quota !== null) {
          state.quota = mergeQuota(state.quota, quota);
        }
      } catch {
        // The turn's last readable report stands.
      }
      return;
    }
    case "result": {
      state.sawResult = true;
      // Each result counts only its own run, and a turn can run more than once in one process.
      state.usage = addUsage(state.usage, usageOf(message.usage));
      state.totalCostUsd = message.total_cost_usd;
      state.apiError = message.subtype === "success" && message.is_error;
      // Like the error, the latest run decides whether the turn is worth sending again.
      const serverError = state.serverError;
      state.serverError = false;
      state.transient = false;
      if (message.subtype === "success") {
        state.finalText = message.result;
        state.structured = message.structured_output ?? null;
        // A run that ended on an API error is a success marked `is_error`, its text the API's words.
        if (state.apiError) {
          state.exitReason = "error";
          state.error = message.result || "the turn ended on an API error";
          const status = message.api_error_status;
          state.transient = typeof status === "number" ? status >= 500 : serverError;
        } else {
          // The latest run decides how the turn ended, so an earlier run's error goes with it.
          state.exitReason = "completed";
          state.error = undefined;
        }
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
  // A turn the plan's limit refused did no work, so it fails rather than completing without a
  // report, which keeps its digest for the next turn.
  if (
    state.limitText !== undefined &&
    status === null &&
    state.exitReason !== "stopped" &&
    state.exitReason !== "timeout"
  ) {
    state.exitReason = "error";
    state.error = `usage limit reached: ${state.limitText}`;
  }
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
    ...(state.quota === undefined ? {} : { quota: state.quota }),
    ...(state.transient && state.limitText === undefined && state.exitReason === "error"
      ? { transient: true }
      : {}),
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
 * What Claude Code says when it cannot resume a session, before it announces the session and before
 * any model call, as 2.1.283 says it for an id with no transcript, or one it cannot read: `No
 * conversation found with session ID: <id>`. Its other refusals of an id cannot come up here: the
 * adapter hands it no id that is not a UUID, and creates a session only under a fresh one.
 */
const LOST_SESSION = /No conversation found with session ID/;

/** Why the CLI could not resume a session, from its words: nothing there to resume, or try again. */
function resumeFailureOf(error: string | undefined): ResumeFailure {
  return error !== undefined && LOST_SESSION.test(error) ? "lost" : "retry";
}

/**
 * A turn on a saved session that ended before the CLI opened it could not resume it: one that
 * failed, and one held up to the turn's limit, as on a transcript the CLI never finishes reading. A
 * stop is the user's decision, not the session's.
 */
function withResumeFailure(result: TurnResult): TurnResult {
  return result.exitReason === "error" || result.exitReason === "timeout"
    ? { ...result, resumeFailed: resumeFailureOf(result.error) }
    : result;
}

/**
 * Claude Code takes a session id only as a UUID, and resumes any other value as a session's title,
 * so an id saved as anything else, such as the `unstarted` runners once saved for a conversation
 * whose first turn never reached its CLI, is never handed to it.
 */
function notUuid(session: SessionId): string {
  return `the saved session id ${JSON.stringify(session)} is not a UUID, so Claude Code cannot resume it`;
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
  /** Whether the CLI has announced the session, which it does once it has opened it. */
  private opened = false;

  constructor(
    private readonly context: HandlerContext,
    private readonly limits: { timeoutMs: number | null },
    session: SessionId,
    /** Whether the session is a saved one to resume, which the CLI may fail to do. */
    private readonly resuming: boolean,
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
          this.opened = true;
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
      const said = this.endedWith ?? "the resident session has ended";
      // A CLI that ended before it opened a saved session could not resume it.
      throw this.resuming && !this.opened
        ? new ResumeError(resumeFailureOf(this.endedWith), said)
        : new Error(said);
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
    const result = finishTurn(state, costUsd, events, emit);
    return this.resuming && !this.opened ? withResumeFailure(result) : result;
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
  private readonly now: () => Date;

  constructor(private readonly options: ClaudeBackendOptions = {}) {
    this.queryFn = options.queryFn ?? ((params) => query(params));
    this.now = options.now ?? (() => new Date());
  }

  /** The session id is chosen before the CLI starts, so the turn reports it however it ends. */
  newSession(): Promise<SessionId> {
    return Promise.resolve(randomUUID());
  }

  /** The models the CLI offers, asked of a query that is closed before it takes a turn. */
  async listModels(): Promise<ModelOption[]> {
    const listing = this.ask();
    try {
      return listing.supportedModels === undefined
        ? []
        : modelOptions(await listing.supportedModels());
    } finally {
      listing.close?.();
    }
  }

  /**
   * The plan quota from the usage read behind `/usage`, asked of a query that is closed before it
   * takes a turn. The read fetches the claude.ai usage endpoint and makes no model call, so it
   * spends none of the quota; it skips the scan of local transcripts that fills the dialog's
   * breakdown. Rejects when this Claude Code cannot read its usage.
   */
  async readQuota(): Promise<CliQuota> {
    const asking = this.ask();
    try {
      const read = asking.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (read === undefined) {
        throw new Error("this Claude Code cannot read its usage");
      }
      return quotaFromUsage(await read.call(asking, { skipBehaviors: true }), this.now());
    } finally {
      asking.close?.();
    }
  }

  /** A query opened only to ask the CLI something: it never sends a prompt, so it makes no turn. */
  private ask(): QueryStream {
    return this.queryFn({
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
    // A saved session is resumed or the turn fails: the server built the prompt for that session,
    // and only it decides that a conversation starts afresh.
    const resuming = !request.newSession;
    if (resuming && !isUuid(request.session)) {
      const refused = freshState();
      refused.error = notUuid(request.session);
      return { ...finishTurn(refused, 0, events, emit), resumeFailed: "lost" };
    }
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
      now: this.now,
    };

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
      options: this.buildOptions(request, abort, resuming),
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
      // The API's words say why the turn failed; the CLI's exit after them, with code 1, says less.
      if (!abort.signal.aborted && !stopped && !state.apiError) {
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
    const costSoFarUsd = resuming ? (request.costSoFarUsd ?? 0) : 0;
    const costUsd = state.sawResult ? Math.max(0, state.totalCostUsd - costSoFarUsd) : 0;
    const result = finishTurn(state, costUsd, events, emit);
    // The CLI announces a session once it has opened it, and says first why it could not.
    return resuming && !state.initialized ? withResumeFailure(result) : result;
  }

  /** A warm session over the SDK's streaming input; every later prompt is one turn on it. */
  startResident(spec: AgentSpec, start: ResidentStart): Promise<ResidentSession> {
    const resuming = !start.newSession;
    if (resuming && !isUuid(start.session)) {
      return Promise.reject(new ResumeError("lost", notUuid(start.session)));
    }
    const request: TurnRequest = {
      spec,
      session: start.session,
      newSession: start.newSession,
      prompt: "",
      instructions: start.instructions,
      mcp: start.mcp,
      limits: start.limits,
      statusSchema: start.statusSchema,
    };
    const context: HandlerContext = {
      agent: spec.agent,
      runner: spec.runner,
      announceOnInit: false,
      now: this.now,
    };
    const record =
      this.options.recordDir === undefined
        ? null
        : (lines: readonly string[]) => this.record(spec.agent, lines);
    return Promise.resolve(
      new ClaudeResident(
        context,
        { timeoutMs: start.limits.timeoutMs },
        start.session,
        resuming,
        resuming ? (start.costSoFarUsd ?? 0) : 0,
        this.queryFn,
        this.buildOptions(request, new AbortController(), resuming),
        record,
      ),
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

  private buildOptions(request: TurnRequest, abort: AbortController, resuming: boolean): Options {
    const model = request.spec.model ?? this.options.model;
    const effort = claudeEffort(request.spec.effort) ?? this.options.effort;
    const permissionMode = this.options.permissionMode ?? "bypassPermissions";
    return {
      cwd: request.spec.cwd,
      // The home holds memory and skills the agent authors; the board projection is what it searches.
      additionalDirectories: [request.spec.configHome, request.spec.boardDir],
      ...(resuming ? { resume: request.session } : { sessionId: request.session }),
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
      env: subprocessEnv(process.env, this.options.env ?? {}, request.mcp.token),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(this.options.stderr === undefined ? {} : { stderr: this.options.stderr }),
      ...(this.options.pathToClaudeCodeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable }),
    };
  }
}
