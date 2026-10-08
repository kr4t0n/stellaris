import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { execa } from "execa";
import {
  parseTurnStatus,
  type AgentSpec,
  type ResidentSession,
  type ResidentStart,
  type SessionId,
  type TurnControl,
  type TurnResult,
} from "@stellaris/runner-core";
import {
  AGENT_TOKEN_ENV,
  capOutput,
  EffortOptionSchema,
  ModelOptionSchema,
  type AgentEvent,
  type EffortOption,
  type ModelOption,
  type TurnExitReason,
  type Usage,
} from "@stellaris/shared";

/**
 * A Codex thread over `codex app-server`: JSON-RPC 2.0 over stdio, one JSON object per line. The
 * process starts once per session, for one cold turn or for a resident session's lifetime;
 * `thread/start` or `thread/resume` opens the thread, and every prompt is a `turn/start` whose
 * items stream back as notifications until `turn/completed`. Approvals never occur: the thread
 * runs with policy `never`.
 */

export interface AppServerProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<number | null>;
  kill(): void;
}

export type SpawnAppServer = (
  args: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => AppServerProcess;

export interface AppServerSessionOptions {
  readonly spawn?: SpawnAppServer | undefined;
  readonly codexPath?: string | undefined;
  readonly model?: string | undefined;
  /** `danger-full-access` runs with no sandbox and no approvals; the other modes keep Codex's sandbox. */
  readonly sandbox: "danger-full-access" | "read-only" | "workspace-write";
  readonly extraConfig?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stderr?: ((line: string) => void) | undefined;
  /** Directory to append the server's raw output to, one file per turn, for fixtures. */
  readonly recordDir?: string | undefined;
  readonly clientVersion?: string | undefined;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * What a web search looked for. The item's `query` can be empty, as when the search opened a page
 * or was run from code; its `action` then says what it did.
 */
function searchInput(item: Dict): Record<string, string> {
  const query = str(item["query"]);
  if (query !== undefined && query !== "") {
    return { query };
  }
  const action = isDict(item["action"]) ? item["action"] : {};
  const queries = Array.isArray(action["queries"])
    ? action["queries"].filter((each): each is string => typeof each === "string")
    : [];
  const found = str(action["query"]) ?? (queries.length > 0 ? queries.join(" · ") : undefined);
  const url = str(action["url"]);
  const pattern = str(action["pattern"]);
  return {
    ...(found === undefined ? {} : { query: found }),
    ...(url === undefined ? {} : { url }),
    ...(pattern === undefined ? {} : { pattern }),
  };
}

/** Sessions Codex has not named yet start with this prefix; a thread id replaces it on start. */
export const PENDING_THREAD_PREFIX = "pending-";

const REQUEST_TIMEOUT_MS = 60_000;
const STDERR_TAIL = 20;

export function defaultSpawnAppServer(codexPath: string): SpawnAppServer {
  return (args, options) => {
    const child = execa(codexPath, [...args], {
      cwd: options.cwd,
      env: options.env,
      extendEnv: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error("codex app-server did not expose stdio pipes");
    }
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.then(
        (result) => result.exitCode ?? null,
        () => null,
      ),
      kill: () => {
        child.kill("SIGTERM");
      },
    };
  };
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ClientHandlers {
  readonly notification: (method: string, params: unknown) => void;
  readonly stderr: (line: string) => void;
  /** Every line the server wrote, before it is parsed. */
  readonly line: (line: string) => void;
  readonly exit: () => void;
}

/** The JSON-RPC side: requests with ids, notifications without, and server requests answered with an error. */
class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly process: AppServerProcess,
    private readonly handlers: ClientHandlers,
  ) {
    const lines = createInterface({ input: process.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      this.handlers.line(line);
      this.receive(line);
    });
    const errors = createInterface({ input: process.stderr, crlfDelay: Infinity });
    errors.on("line", (line) => this.handlers.stderr(line));
    void (async () => {
      await process.exited;
      this.closed = true;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("codex app-server exited"));
        this.pending.delete(id);
      }
      this.handlers.exit();
    })();
  }

  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("codex app-server is closed"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.process.kill();
  }

  private write(message: Dict): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (line.trim().length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isDict(parsed)) {
      return;
    }
    const method = str(parsed["method"]);
    const id = parsed["id"];
    if (method !== undefined && typeof id === "number") {
      // A request from the server, such as an approval; nothing here answers those.
      this.write({ id, error: { code: -32601, message: `unsupported request ${method}` } });
      return;
    }
    if (method !== undefined) {
      this.handlers.notification(method, parsed["params"]);
      return;
    }
    if (typeof id !== "number") {
      return;
    }
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const error = parsed["error"];
    if (isDict(error)) {
      entry.reject(new Error(str(error["message"]) ?? "codex app-server error"));
      return;
    }
    entry.resolve(parsed["result"]);
  }
}

/** App-server items use camelCase types; the vocabulary maps onto the same tool names as everywhere else. */
function toolNameOf(item: Dict): string | null {
  switch (item["type"]) {
    case "commandExecution":
      return "Bash";
    case "fileChange":
      return "Edit";
    case "webSearch":
      return "WebSearch";
    case "mcpToolCall": {
      const server = str(item["server"]) ?? "mcp";
      const tool = str(item["tool"]) ?? "tool";
      return `mcp__${server}__${tool}`;
    }
    default:
      return null;
  }
}

function toolInputOf(item: Dict): unknown {
  switch (item["type"]) {
    case "commandExecution":
      return { command: item["command"] };
    case "fileChange":
      return { changes: item["changes"] };
    case "webSearch":
      return searchInput(item);
    case "mcpToolCall":
      return item["arguments"];
    default:
      return undefined;
  }
}

function toolOk(item: Dict): boolean {
  const status = item["status"];
  if (status === "failed" || status === "declined") {
    return false;
  }
  if (item["type"] === "commandExecution") {
    const code = item["exitCode"];
    return typeof code !== "number" || code === 0;
  }
  if (item["type"] === "mcpToolCall") {
    return item["error"] === undefined || item["error"] === null;
  }
  return true;
}

/** What a finished tool item returned, as text; file changes carry their diff in the call instead. */
function toolOutputOf(item: Dict): string {
  switch (item["type"]) {
    case "commandExecution": {
      const output = str(item["aggregatedOutput"]) ?? "";
      const code = item["exitCode"];
      return typeof code === "number" && code !== 0 ? `${output}\n(exit ${code})`.trim() : output;
    }
    case "mcpToolCall": {
      const error = item["error"];
      if (isDict(error)) {
        return str(error["message"]) ?? "";
      }
      const result = item["result"];
      const content = isDict(result) && Array.isArray(result["content"]) ? result["content"] : [];
      return content
        .map((block) =>
          isDict(block) && block["type"] === "text"
            ? (str(block["text"]) ?? "")
            : `[${isDict(block) ? (str(block["type"]) ?? "content") : "content"}]`,
        )
        .join("\n");
    }
    default:
      return "";
  }
}

/** A model's reasoning efforts from `supportedReasoningEfforts`, skipping any the board cannot name. */
function effortsOf(raw: unknown): EffortOption[] {
  return (Array.isArray(raw) ? raw : []).flatMap((option) => {
    const parsed = EffortOptionSchema.safeParse({
      id: isDict(option) ? str(option["reasoningEffort"]) : undefined,
      description: (isDict(option) ? str(option["description"]) : undefined) ?? "",
    });
    return parsed.success ? [parsed.data] : [];
  });
}

function modelOf(raw: unknown): ModelOption | null {
  if (!isDict(raw)) {
    return null;
  }
  const efforts = effortsOf(raw["supportedReasoningEfforts"]);
  const fallback = str(raw["defaultReasoningEffort"]);
  const parsed = ModelOptionSchema.safeParse({
    id: str(raw["model"]) ?? str(raw["id"]),
    name: str(raw["displayName"]) ?? str(raw["model"]) ?? "",
    description: str(raw["description"]) ?? "",
    isDefault: raw["isDefault"] === true,
    efforts,
    ...(efforts.some((effort) => effort.id === fallback) ? { defaultEffort: fallback } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** The models the app server offers, from `model/list` on a server started only to ask. */
export async function listAppServerModels(
  options: Omit<AppServerSessionOptions, "sandbox">,
): Promise<ModelOption[]> {
  const args = ["app-server", "--stdio"];
  for (const override of options.extraConfig ?? []) {
    args.push("-c", override);
  }
  const spawn = options.spawn ?? defaultSpawnAppServer(options.codexPath ?? "codex");
  const child = spawn(args, { cwd: os.tmpdir(), env: { ...process.env, ...options.env } });
  const client = new JsonRpcClient(child, {
    notification: () => undefined,
    stderr: (line) => options.stderr?.(line),
    line: () => undefined,
    exit: () => undefined,
  });
  try {
    await client.request("initialize", {
      clientInfo: {
        name: "stellaris",
        title: "Stellaris runner",
        version: options.clientVersion ?? "0.0.0",
      },
      capabilities: null,
    });
    client.notify("initialized", {});
    const models: ModelOption[] = [];
    let cursor: string | null = null;
    do {
      const page = await client.request("model/list", {
        includeHidden: false,
        ...(cursor === null ? {} : { cursor }),
      });
      const data = isDict(page) && Array.isArray(page["data"]) ? page["data"] : [];
      for (const raw of data) {
        const model = modelOf(raw);
        if (model !== null) models.push(model);
      }
      cursor = isDict(page) ? (str(page["nextCursor"]) ?? null) : null;
    } while (cursor !== null);
    return models;
  } finally {
    client.close();
  }
}

/** A thread's token totals as the app server counts them, where the input includes the cached input. */
interface ThreadTokens {
  readonly input: number;
  readonly cached: number;
  readonly cacheWrite: number;
  readonly output: number;
}

const NO_TOKENS: ThreadTokens = { input: 0, cached: 0, cacheWrite: 0, output: 0 };

function threadTokensOf(raw: unknown): ThreadTokens {
  const u = isDict(raw) ? raw : {};
  return {
    input: num(u["inputTokens"]),
    cached: num(u["cachedInputTokens"]),
    cacheWrite: num(u["cacheWriteInputTokens"]),
    output: num(u["outputTokens"]),
  };
}

/**
 * What a turn used, from the thread's totals before and after it. The board counts input outside
 * the cache apart from the input read from or written to it, as Claude Code does.
 */
export function turnUsage(before: ThreadTokens, after: ThreadTokens): Usage {
  const grew = (key: keyof ThreadTokens): number => Math.max(0, after[key] - before[key]);
  const cached = grew("cached");
  const cacheWrite = grew("cacheWrite");
  return {
    inputTokens: Math.max(0, grew("input") - cached - cacheWrite),
    outputTokens: grew("output"),
    cacheReadTokens: cached,
    cacheWriteTokens: cacheWrite,
  };
}

interface TurnCollector {
  turnId: string | null;
  finalText: string;
  /** The thread's totals before the turn's first request. */
  baseline: ThreadTokens;
  status: string | null;
  error: string | undefined;
  readonly started: Set<string>;
  readonly emit: (event: AgentEvent) => void;
  readonly settle: () => void;
  /** Steers the app server accepted and has not yet delivered as a user message. */
  readonly outstanding: Set<string>;
  stopped: boolean;
}

/** How long a turn asked to stop may take to say so before it is ended without its report. */
const STOP_GRACE_MS = 15_000;

export class CodexAppServerSession implements ResidentSession {
  session: SessionId;
  /** The model the app server reported when the thread opened. */
  model: string | undefined;
  private readonly client: JsonRpcClient;
  private active: TurnCollector | null = null;
  /** The thread's totals as last reported, which a resumed thread reports before its first turn. */
  private threadTotal: ThreadTokens = NO_TOKENS;
  private closed = false;
  private readonly stderrTail: string[] = [];
  private readonly recorded: string[] = [];

  private constructor(
    private readonly options: AppServerSessionOptions,
    private readonly spec: AgentSpec,
    private readonly start: ResidentStart,
    process: AppServerProcess,
  ) {
    this.session = start.session;
    this.client = new JsonRpcClient(process, {
      notification: (method, params) => this.onNotification(method, params),
      stderr: (line) => {
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
        options.stderr?.(line);
      },
      line: (line) => {
        if (options.recordDir !== undefined) this.recorded.push(line);
      },
      exit: () => this.onExit(),
    });
  }

  /** Spawns the app server, initializes it, and opens or resumes the thread. */
  static async start(
    options: AppServerSessionOptions,
    spec: AgentSpec,
    start: ResidentStart,
  ): Promise<CodexAppServerSession> {
    const args = [
      "app-server",
      "--stdio",
      "-c",
      `mcp_servers.board.url=${JSON.stringify(start.mcp.url)}`,
      "-c",
      `mcp_servers.board.bearer_token_env_var=${JSON.stringify(AGENT_TOKEN_ENV)}`,
      "-c",
      'mcp_servers.board.default_tools_approval_mode="approve"',
      "-c",
      `sandbox_mode=${JSON.stringify(options.sandbox)}`,
      "-c",
      'approval_policy="never"',
    ];
    for (const override of options.extraConfig ?? []) {
      args.push("-c", override);
    }
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
      ...start.env,
      [AGENT_TOKEN_ENV]: start.mcp.token,
    };
    const spawn = options.spawn ?? defaultSpawnAppServer(options.codexPath ?? "codex");
    const child = spawn(args, { cwd: spec.cwd, env });
    const session = new CodexAppServerSession(options, spec, start, child);
    try {
      await session.client.request("initialize", {
        clientInfo: {
          name: "stellaris",
          title: "Stellaris runner",
          version: options.clientVersion ?? "0.0.0",
        },
        capabilities: null,
      });
      session.client.notify("initialized", {});
      session.session = await session.openThread();
    } catch (error) {
      session.client.close();
      throw error;
    }
    return session;
  }

  private threadParams(): Dict {
    const model = this.spec.model ?? this.options.model;
    return {
      cwd: this.spec.cwd,
      approvalPolicy: "never",
      sandbox: this.options.sandbox,
      developerInstructions: this.start.instructions,
      ...(model === undefined ? {} : { model }),
    };
  }

  private async openThread(): Promise<string> {
    const known = !this.start.newSession && !this.start.session.startsWith(PENDING_THREAD_PREFIX);
    if (known) {
      try {
        const resumed = await this.client.request("thread/resume", {
          threadId: this.start.session,
          // Without it the response carries the thread's whole history, which nothing here reads.
          excludeTurns: true,
          ...this.threadParams(),
        });
        return this.threadIdOf(resumed);
      } catch (error) {
        this.options.stderr?.(
          `thread ${this.start.session} could not be resumed, starting a new one: ${String(error)}`,
        );
      }
    }
    const started = await this.client.request("thread/start", this.threadParams());
    return this.threadIdOf(started);
  }

  private threadIdOf(response: unknown): string {
    const thread = isDict(response) ? response["thread"] : undefined;
    const id = isDict(thread) ? str(thread["id"]) : undefined;
    if (id === undefined) {
      throw new Error("codex app-server returned no thread id");
    }
    this.model = isDict(response) ? str(response["model"]) : undefined;
    return id;
  }

  private sandboxPolicy(): Dict {
    if (this.options.sandbox === "danger-full-access") {
      return { type: "dangerFullAccess" };
    }
    if (this.options.sandbox === "read-only") {
      return { type: "readOnly", networkAccess: false };
    }
    return {
      type: "workspaceWrite",
      // A worktree keeps its index and objects in the canonical clone; commits need it writable.
      writableRoots: [...new Set([this.spec.configHome, this.spec.boardDir, this.spec.repoDir])],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  /** A server that dies mid-turn never sends `turn/completed`; the turn ends with what it said last. */
  private onExit(): void {
    const turn = this.active;
    if (turn === null) {
      return;
    }
    const said = this.stderrTail.join("\n").trim();
    turn.error ??= said.length > 0 ? `codex app-server exited: ${said}` : "codex app-server exited";
    turn.settle();
  }

  private async flushRecording(): Promise<void> {
    if (this.options.recordDir === undefined || this.recorded.length === 0) {
      return;
    }
    const lines = this.recorded.splice(0);
    await mkdir(this.options.recordDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await appendFile(
      path.join(this.options.recordDir, `codex-${this.spec.agent}-${stamp}.jsonl`),
      `${lines.join("\n")}\n`,
      "utf8",
    );
  }

  private onNotification(method: string, params: unknown): void {
    const turn = this.active;
    if (!isDict(params)) {
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = params["tokenUsage"];
      if (!isDict(usage)) {
        return;
      }
      this.threadTotal = threadTokensOf(usage["total"]);
      // `last` is only the latest request. An update about another turn, such as the one a resumed
      // thread sends about its previous turn, says where the thread stood before this one.
      const owner = str(params["turnId"]);
      if (
        turn !== null &&
        (turn.turnId === null || (owner !== undefined && owner !== turn.turnId))
      ) {
        turn.baseline = this.threadTotal;
      }
      return;
    }
    if (turn === null) {
      return;
    }
    switch (method) {
      case "turn/started": {
        const started = params["turn"];
        turn.turnId ??= isDict(started) ? (str(started["id"]) ?? null) : null;
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = params["item"];
        if (!isDict(item)) {
          return;
        }
        const id = str(item["id"]) ?? "";
        // A steer arrives as a user message carrying the id it was sent with.
        if (item["type"] === "userMessage") {
          const steer = str(item["clientId"]);
          if (steer !== undefined && turn.outstanding.delete(steer)) {
            turn.emit({ type: "steered", steer });
          }
          return;
        }
        if (item["type"] === "agentMessage") {
          const text = str(item["text"]) ?? "";
          if (method === "item/completed" && text.length > 0) {
            turn.emit({ type: "text", delta: text });
            turn.finalText = text;
          }
          return;
        }
        const name = toolNameOf(item);
        if (name === null) {
          return;
        }
        // A web search learns what it looked for as it runs, so its call is reported on completion.
        const early = item["type"] === "webSearch" && method !== "item/completed";
        if (!turn.started.has(id) && !early) {
          turn.started.add(id);
          turn.emit({ type: "tool_call", name, input: toolInputOf(item) });
        }
        if (method === "item/completed") {
          const output = toolOutputOf(item);
          turn.emit({
            type: "tool_result",
            name,
            ok: toolOk(item),
            ...(output === "" ? {} : { output: capOutput(output) }),
          });
        }
        return;
      }
      case "turn/completed": {
        const completed = params["turn"];
        if (!isDict(completed)) {
          return;
        }
        if (turn.turnId !== null && str(completed["id"]) !== turn.turnId) {
          return;
        }
        turn.status = str(completed["status"]) ?? "completed";
        const error = completed["error"];
        if (isDict(error)) {
          turn.error = str(error["message"]) ?? "turn failed";
        }
        turn.settle();
        return;
      }
      case "error": {
        const error = params["error"];
        const message =
          (isDict(error) ? str(error["message"]) : undefined) ?? "codex app-server error";
        if (params["willRetry"] === true) {
          // Codex retries this itself, such as a dropped stream, and the turn may still complete.
          turn.emit({ type: "error", message: `${message} (retrying)` });
          return;
        }
        turn.error = message;
        return;
      }
      default:
        return;
    }
  }

  async runTurn(
    prompt: string,
    onEvent?: (event: AgentEvent) => void,
    control?: TurnControl,
  ): Promise<TurnResult> {
    if (this.closed) {
      throw new Error("the resident session has ended");
    }
    if (this.active !== null) {
      throw new Error("a turn is already running on this resident session");
    }
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    const { promise: done, resolve } = Promise.withResolvers<void>();
    const settle = (): void => {
      this.active = null;
      resolve();
    };
    const turn: TurnCollector = {
      turnId: null,
      finalText: "",
      baseline: this.threadTotal,
      status: null,
      error: undefined,
      started: new Set(),
      emit,
      settle,
      outstanding: new Set(),
      stopped: false,
    };
    this.active = turn;
    emit({
      type: "turn_started",
      agent: this.spec.agent,
      session: this.session,
      runner: this.spec.runner,
      ...(this.model === undefined ? {} : { model: this.model }),
    });

    let timedOut = false;
    const limit = this.start.limits.timeoutMs;
    const timer =
      limit === null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            void this.client
              .request("turn/interrupt", { threadId: this.session, turnId: turn.turnId })
              .catch(() => undefined);
            setTimeout(() => turn.settle(), 15_000).unref?.();
          }, limit);

    let detach: (() => void) | undefined;
    try {
      const started = await this.client.request("turn/start", {
        threadId: this.session,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd: this.spec.cwd,
        approvalPolicy: "never",
        sandboxPolicy: this.sandboxPolicy(),
        outputSchema: this.start.statusSchema,
        ...(this.spec.effort === undefined ? {} : { effort: this.spec.effort }),
      });
      const startedTurn = isDict(started) ? started["turn"] : undefined;
      turn.turnId = isDict(startedTurn) ? (str(startedTurn["id"]) ?? null) : null;
      detach = control?.attach({
        steer: (steer) => this.steer(turn, steer.id, steer.text),
        stop: () => this.stop(turn),
      });
      await done;
    } catch (error) {
      turn.error ??= error instanceof Error ? error.message : String(error);
      turn.settle();
    } finally {
      detach?.();
      clearTimeout(timer);
    }
    await this.flushRecording();

    let exitReason: TurnExitReason;
    if (turn.stopped) {
      exitReason = "stopped";
      turn.error = undefined;
    } else if (timedOut) {
      exitReason = "timeout";
      turn.error = `turn exceeded ${limit} ms`;
    } else if (turn.status === "completed" && turn.error === undefined) {
      exitReason = "completed";
    } else if (turn.status === "interrupted") {
      exitReason = "interrupted";
      turn.error ??= "turn interrupted";
    } else {
      exitReason = "error";
      turn.error ??= "turn failed";
    }
    const status = parseTurnStatus(null, turn.finalText);
    if (exitReason === "completed" && status === null) {
      turn.error = "the turn ended without a parsable status object";
    }
    if (turn.error !== undefined) {
      emit({ type: "error", message: turn.error });
    }
    const usage = turnUsage(turn.baseline, this.threadTotal);
    emit({ type: "turn_completed", usage, costUsd: 0, status, exitReason });
    return {
      events,
      finalText: turn.finalText,
      usage,
      costUsd: 0,
      status,
      exitReason,
      ...(turn.error === undefined ? {} : { error: turn.error }),
      session: this.session,
      ...(this.model === undefined ? {} : { model: this.model }),
    };
  }

  /**
   * Input into the running turn. The app server refuses it once that turn is over, or while it is
   * a review or a compaction; one it accepts arrives in the turn as a user message with the id.
   */
  private async steer(turn: TurnCollector, id: string, text: string): Promise<boolean> {
    if (this.active !== turn || turn.stopped || turn.turnId === null) {
      return false;
    }
    turn.outstanding.add(id);
    try {
      await this.client.request("turn/steer", {
        threadId: this.session,
        input: [{ type: "text", text, text_elements: [] }],
        expectedTurnId: turn.turnId,
        clientUserMessageId: id,
      });
      return true;
    } catch {
      turn.outstanding.delete(id);
      return false;
    }
  }

  /** Interrupts the running turn, which the app server ends as interrupted; the turn is `stopped`. */
  private stop(turn: TurnCollector): void {
    if (this.active !== turn || turn.stopped) {
      return;
    }
    turn.stopped = true;
    void this.client
      .request("turn/interrupt", { threadId: this.session, turnId: turn.turnId })
      .catch(() => undefined);
    setTimeout(() => turn.settle(), STOP_GRACE_MS).unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.client.close();
  }
}
