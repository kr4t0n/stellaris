import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
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
import { execa } from "execa";
import { z } from "zod";
import { CodexAppServerSession, type SpawnAppServer } from "./app-server.js";
import { parseExecLine } from "./events.js";

export const CodexSandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export type CodexSandbox = z.infer<typeof CodexSandboxSchema>;

/** What the backend needs from a spawned process. Injectable so tests can replay recorded streams. */
export interface SpawnedCodex {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{ exitCode: number | null; timedOut: boolean }>;
  kill(): void;
}

export type SpawnCodex = (
  args: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number },
) => SpawnedCodex;

export interface CodexExecOptions {
  readonly codexPath?: string | undefined;
  readonly model?: string | undefined;
  /**
   * Defaults to `danger-full-access`: no sandbox and no approvals, the society's decision in
   * PLAN.md section 5.2. The other modes keep Codex's own sandbox for a runner that wants one.
   */
  readonly sandbox?: CodexSandbox | undefined;
  /** Extra `-c key=value` overrides appended to every invocation. */
  readonly extraConfig?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stderr?: ((line: string) => void) | undefined;
  /** Directory to append raw JSONL streams to, one file per turn, for fixtures. */
  readonly recordDir?: string | undefined;
  readonly runnerName?: string | undefined;
  readonly spawn?: SpawnCodex | undefined;
  /** Spawns `codex app-server` for resident sessions; injectable for tests. */
  readonly spawnAppServer?: SpawnAppServer | undefined;
}

const SESSION_NOT_FOUND =
  /(no|unknown|missing|not find|not found|no such|failed to (load|find|resolve)).{0,80}(session|thread|conversation|rollout)|(session|thread|conversation|rollout).{0,80}(not found|does not exist|no such|missing)/i;

/** Sessions are assigned by Codex on the first turn; until then the runner holds a placeholder. */
export const PENDING_SESSION_PREFIX = "pending-";

export function subprocessEnv(
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string | undefined>>,
  token: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, ...extra };
  env[AGENT_TOKEN_ENV] = token;
  return env;
}

const defaultSpawn =
  (codexPath: string): SpawnCodex =>
  (args, options) => {
    const subprocess = execa(codexPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      reject: false,
      timeout: options.timeoutMs,
      buffer: false,
    });
    if (subprocess.stdout === null || subprocess.stderr === null) {
      throw new Error("codex process has no stdio");
    }
    return {
      stdout: subprocess.stdout,
      stderr: subprocess.stderr,
      exited: subprocess.then((result) => ({
        exitCode: result.exitCode ?? null,
        timedOut: result.timedOut,
      })),
      kill: () => {
        subprocess.kill();
      },
    };
  };

/**
 * Codex through `codex exec --json`: one process per turn, resumed by thread id. The board's MCP
 * endpoint and token travel as config overrides and environment; instructions travel in the prompt
 * because exec mode has no system-prompt append. Same interface as every other backend.
 */
export class CodexExecBackend implements AgentBackend {
  readonly kind = "codex" as const;
  private readonly spawn: SpawnCodex;

  constructor(private readonly options: CodexExecOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn(options.codexPath ?? "codex");
  }

  /** Codex picks thread ids itself; the placeholder is replaced by the id the first turn reports. */
  newSession(): Promise<SessionId> {
    return Promise.resolve(`${PENDING_SESSION_PREFIX}${randomUUID()}`);
  }

  /** A warm thread over `codex app-server`, for roles the runner keeps resident. */
  async startResident(spec: AgentSpec, start: ResidentStart): Promise<ResidentSession> {
    return CodexAppServerSession.start(
      {
        ...(this.options.spawnAppServer === undefined
          ? {}
          : { spawn: this.options.spawnAppServer }),
        ...(this.options.codexPath === undefined ? {} : { codexPath: this.options.codexPath }),
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        sandbox: this.options.sandbox ?? "danger-full-access",
        ...(this.options.extraConfig === undefined
          ? {}
          : { extraConfig: this.options.extraConfig }),
        ...(this.options.env === undefined ? {} : { env: this.options.env }),
        ...(this.options.stderr === undefined ? {} : { stderr: this.options.stderr }),
        ...(this.options.runnerName === undefined ? {} : { runnerName: this.options.runnerName }),
      },
      spec,
      start,
    );
  }

  async runTurn(request: TurnRequest, onEvent?: (event: AgentEvent) => void): Promise<TurnResult> {
    const resumable = !request.newSession && !request.session.startsWith(PENDING_SESSION_PREFIX);
    const first = await this.runOnce(request, resumable, onEvent);
    if (resumable && first.sessionMissing) {
      // The recorded id names no thread on this machine: start a new one under a fresh id.
      return this.runOnce(request, false, onEvent);
    }
    return first;
  }

  private async runOnce(
    request: TurnRequest,
    resume: boolean,
    onEvent: ((event: AgentEvent) => void) | undefined,
  ): Promise<TurnResult & { sessionMissing?: boolean }> {
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    const configDir = path.join(request.spec.configHome, ".codex");
    await mkdir(configDir, { recursive: true });
    const schemaFile = path.join(configDir, "status.schema.json");
    await writeFile(schemaFile, `${JSON.stringify(request.statusSchema, null, 2)}\n`, "utf8");

    const args = this.buildArgs(request, resume, schemaFile);
    const env = subprocessEnv(
      process.env,
      { ...this.options.env, ...request.env },
      request.mcp.token,
    );
    const recorded: string[] = [];

    const started = new Set<string>();
    const stderrLines: string[] = [];
    let threadId: string | undefined;
    let usage: Usage = ZERO_USAGE;
    let lastMessage = "";
    let error: string | undefined;
    let turnCompleted = false;
    let turnFailed = false;

    const child = this.spawn(args, {
      cwd: request.spec.cwd,
      env,
      timeoutMs: request.limits.timeoutMs,
    });
    const stderrDone = new Promise<void>((resolve) => {
      const lines = createInterface({ input: child.stderr });
      lines.on("line", (line) => {
        stderrLines.push(line);
        this.options.stderr?.(line);
      });
      lines.on("close", resolve);
    });
    const stdoutDone = new Promise<void>((resolve) => {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (this.options.recordDir !== undefined) {
          recorded.push(line);
        }
        const parsed = parseExecLine(line, started);
        if (parsed.threadId !== undefined) {
          threadId = parsed.threadId;
          emit({
            type: "turn_started",
            agent: request.spec.agent,
            session: parsed.threadId,
            runner: this.options.runnerName ?? "local",
          });
        }
        if (parsed.usage !== undefined) usage = parsed.usage;
        if (parsed.agentMessage !== undefined) lastMessage = parsed.agentMessage;
        if (parsed.error !== undefined) error = parsed.error;
        if (parsed.turnCompleted === true) turnCompleted = true;
        if (parsed.turnFailed === true) turnFailed = true;
        for (const event of parsed.events) {
          emit(event);
        }
      });
      lines.on("close", resolve);
    });

    const exit = await child.exited;
    await Promise.all([stdoutDone, stderrDone]);
    if (this.options.recordDir !== undefined && recorded.length > 0) {
      await mkdir(this.options.recordDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await appendFile(
        path.join(this.options.recordDir, `codex-${request.spec.agent}-${stamp}.jsonl`),
        `${recorded.join("\n")}\n`,
        "utf8",
      );
    }

    const stderr = stderrLines.join("\n").trim();
    if (resume && threadId === undefined && exit.exitCode !== 0 && SESSION_NOT_FOUND.test(stderr)) {
      return {
        events,
        finalText: "",
        usage,
        costUsd: 0,
        status: null,
        exitReason: "error",
        error: stderr,
        sessionMissing: true,
      };
    }

    let exitReason: TurnExitReason;
    if (exit.timedOut) {
      exitReason = "timeout";
      error = `turn exceeded ${request.limits.timeoutMs} ms`;
    } else if (turnCompleted && !turnFailed) {
      exitReason = "completed";
    } else {
      exitReason = "error";
      error =
        error ??
        (stderr.length > 0
          ? stderr.slice(-2_000)
          : `codex exited with code ${exit.exitCode ?? "unknown"}`);
    }

    const status = parseTurnStatus(null, lastMessage);
    if (exitReason === "completed" && status === null) {
      error = error ?? "the turn ended without a parsable status object";
    }
    if (error !== undefined) {
      emit({ type: "error", message: error });
    }
    // Codex reports tokens, not dollars; cost is metered as zero until a price table exists.
    emit({ type: "turn_completed", usage, costUsd: 0, status, exitReason });
    return {
      events,
      finalText: lastMessage,
      usage,
      costUsd: 0,
      status,
      exitReason,
      ...(error === undefined ? {} : { error }),
      ...(threadId === undefined ? {} : { session: threadId }),
      // The exec stream never names the model, so the configured one is the best report available.
      model: request.spec.model ?? this.options.model,
    };
  }

  private buildArgs(request: TurnRequest, resume: boolean, schemaFile: string): string[] {
    const model = request.spec.model ?? this.options.model;
    const sandbox = this.options.sandbox ?? "danger-full-access";
    const args = [
      "exec",
      "--json",
      // Full access skips every confirmation and runs commands unsandboxed. The other modes
      // keep Codex's sandbox, which on Linux needs user namespaces.
      ...(sandbox === "danger-full-access"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["--sandbox", sandbox]),
      "-C",
      request.spec.cwd,
      "--add-dir",
      request.spec.configHome,
      "--add-dir",
      request.spec.boardDir,
      // A worktree keeps its index and objects in the canonical clone; commits need it writable.
      "--add-dir",
      request.spec.repoDir,
      "--output-schema",
      schemaFile,
      "-c",
      `mcp_servers.board.url=${JSON.stringify(request.mcp.url)}`,
      "-c",
      `mcp_servers.board.bearer_token_env_var=${JSON.stringify(AGENT_TOKEN_ENV)}`,
      // Non-interactive runs use approval policy "never", which rejects MCP calls unless the
      // server is marked approved. The board is our own server; its tools are the point.
      "-c",
      'mcp_servers.board.default_tools_approval_mode="approve"',
    ];
    if (model !== undefined) {
      args.push("-m", model);
    }
    for (const override of this.options.extraConfig ?? []) {
      args.push("-c", override);
    }
    const prompt = `${request.instructions.trim()}\n\n---\n\n${request.prompt}`;
    if (resume) {
      args.push("resume", request.session, prompt);
    } else {
      args.push(prompt);
    }
    return args;
  }
}
