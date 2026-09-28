import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { execa } from "execa";
import {
  parseTurnStatus,
  ZERO_USAGE,
  type AgentSpec,
  type ResidentSession,
  type ResidentStart,
  type SessionId,
  type TurnResult,
} from "@stellaris/runner-core";
import {
  AGENT_TOKEN_ENV,
  type AgentEvent,
  type TurnExitReason,
  type Usage,
} from "@stellaris/shared";

/**
 * A warm Codex thread over `codex app-server`: JSON-RPC 2.0 over stdio, one JSON object per line.
 * The process starts once per resident session; `thread/start` or `thread/resume` opens the
 * thread, and every prompt is a `turn/start` whose items stream back as notifications until
 * `turn/completed`. Approvals never occur: the thread runs with policy `never` and full access.
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
  /** `true` runs with full access and no approvals; a Codex sandbox mode name keeps its sandbox. */
  readonly sandbox: "danger-full-access" | "read-only" | "workspace-write";
  readonly extraConfig?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stderr?: ((line: string) => void) | undefined;
  readonly runnerName?: string | undefined;
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

/** Sessions Codex has not named yet start with this prefix; a thread id replaces it on start. */
export const PENDING_THREAD_PREFIX = "pending-";

const REQUEST_TIMEOUT_MS = 60_000;

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

/** The JSON-RPC side: requests with ids, notifications without, and server requests answered with an error. */
class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly process: AppServerProcess,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onStderr: ((line: string) => void) | undefined,
  ) {
    const lines = createInterface({ input: process.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.receive(line));
    const errors = createInterface({ input: process.stderr, crlfDelay: Infinity });
    errors.on("line", (line) => this.onStderr?.(line));
    void (async () => {
      await process.exited;
      this.closed = true;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("codex app-server exited"));
        this.pending.delete(id);
      }
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
      this.onNotification(method, parsed["params"]);
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
      return { query: item["query"] };
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

function usageOfBreakdown(raw: unknown): Usage {
  const u = isDict(raw) ? raw : {};
  return {
    inputTokens: num(u["inputTokens"]),
    outputTokens: num(u["outputTokens"]),
    cacheReadTokens: num(u["cachedInputTokens"]),
    cacheWriteTokens: num(u["cacheWriteInputTokens"]),
  };
}

interface TurnCollector {
  turnId: string | null;
  finalText: string;
  usage: Usage;
  status: string | null;
  error: string | undefined;
  readonly started: Set<string>;
  readonly emit: (event: AgentEvent) => void;
  readonly settle: () => void;
}

export class CodexAppServerSession implements ResidentSession {
  session: SessionId;
  private readonly client: JsonRpcClient;
  private active: TurnCollector | null = null;
  private closed = false;

  private constructor(
    private readonly options: AppServerSessionOptions,
    private readonly spec: AgentSpec,
    private readonly start: ResidentStart,
    process: AppServerProcess,
  ) {
    this.session = start.session;
    this.client = new JsonRpcClient(
      process,
      (method, params) => this.onNotification(method, params),
      options.stderr,
    );
  }

  /** Spawns the app server, initializes it, and opens or resumes the pair's thread. */
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
    return id;
  }

  private onNotification(method: string, params: unknown): void {
    const turn = this.active;
    if (turn === null || !isDict(params)) {
      return;
    }
    switch (method) {
      case "item/started":
      case "item/completed": {
        const item = params["item"];
        if (!isDict(item)) {
          return;
        }
        const id = str(item["id"]) ?? "";
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
        if (!turn.started.has(id)) {
          turn.started.add(id);
          turn.emit({ type: "tool_call", name, input: toolInputOf(item) });
        }
        if (method === "item/completed") {
          turn.emit({ type: "tool_result", name, ok: toolOk(item) });
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = params["tokenUsage"];
        if (isDict(usage)) {
          turn.usage = usageOfBreakdown(usage["last"]);
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
        const message = str(params["message"]) ?? "codex app-server error";
        turn.emit({ type: "error", message });
        turn.error = message;
        return;
      }
      default:
        return;
    }
  }

  async runTurn(prompt: string, onEvent?: (event: AgentEvent) => void): Promise<TurnResult> {
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
      usage: ZERO_USAGE,
      status: null,
      error: undefined,
      started: new Set(),
      emit,
      settle,
    };
    this.active = turn;
    emit({
      type: "turn_started",
      agent: this.spec.agent,
      session: this.session,
      runner: this.options.runnerName ?? "local",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.client
        .request("turn/interrupt", { threadId: this.session, turnId: turn.turnId })
        .catch(() => undefined);
      setTimeout(() => turn.settle(), 15_000).unref?.();
    }, this.start.limits.timeoutMs);

    try {
      const started = await this.client.request("turn/start", {
        threadId: this.session,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd: this.spec.cwd,
        approvalPolicy: "never",
        ...(this.options.sandbox === "danger-full-access"
          ? { sandboxPolicy: { type: "dangerFullAccess" } }
          : {}),
        outputSchema: this.start.statusSchema,
      });
      const startedTurn = isDict(started) ? started["turn"] : undefined;
      turn.turnId = isDict(startedTurn) ? (str(startedTurn["id"]) ?? null) : null;
      await done;
    } catch (error) {
      turn.error = error instanceof Error ? error.message : String(error);
      turn.settle();
    } finally {
      clearTimeout(timer);
    }

    let exitReason: TurnExitReason;
    if (timedOut) {
      exitReason = "timeout";
      turn.error = `turn exceeded ${this.start.limits.timeoutMs} ms`;
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
    emit({ type: "turn_completed", usage: turn.usage, costUsd: 0, status, exitReason });
    return {
      events,
      finalText: turn.finalText,
      usage: turn.usage,
      costUsd: 0,
      status,
      exitReason,
      ...(turn.error === undefined ? {} : { error: turn.error }),
      session: this.session,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.client.close();
  }
}
