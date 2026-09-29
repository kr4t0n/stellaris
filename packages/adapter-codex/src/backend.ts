import { randomUUID } from "node:crypto";
import type {
  AgentBackend,
  AgentSpec,
  ResidentSession,
  ResidentStart,
  SessionId,
  TurnRequest,
  TurnResult,
} from "@stellaris/runner-core";
import type { AgentEvent } from "@stellaris/shared";
import { z } from "zod";
import {
  CodexAppServerSession,
  PENDING_THREAD_PREFIX,
  type AppServerSessionOptions,
  type SpawnAppServer,
} from "./app-server.js";

export const CodexSandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export type CodexSandbox = z.infer<typeof CodexSandboxSchema>;

export interface CodexOptions {
  readonly codexPath?: string | undefined;
  readonly model?: string | undefined;
  /** Defaults to `danger-full-access`: no sandbox and no approvals. The other modes keep Codex's sandbox. */
  readonly sandbox?: CodexSandbox | undefined;
  /** Extra `-c key=value` overrides for every app server. */
  readonly extraConfig?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stderr?: ((line: string) => void) | undefined;
  /** Directory to append the server's raw output to, one file per turn, for fixtures. */
  readonly recordDir?: string | undefined;
  /** Spawns `codex app-server`; injectable for tests. */
  readonly spawn?: SpawnAppServer | undefined;
}

/**
 * Codex through `codex app-server`. A cold turn starts a server, opens or resumes the pair's
 * thread, runs one turn, and stops the server; a resident session keeps both between turns. The
 * board's MCP endpoint and token travel as config overrides and environment, the instructions as
 * the thread's developer instructions.
 */
export class CodexBackend implements AgentBackend {
  readonly kind = "codex" as const;

  constructor(private readonly options: CodexOptions = {}) {}

  /** Codex picks thread ids itself; the placeholder is replaced by the id the thread opens with. */
  newSession(): Promise<SessionId> {
    return Promise.resolve(`${PENDING_THREAD_PREFIX}${randomUUID()}`);
  }

  startResident(spec: AgentSpec, start: ResidentStart): Promise<ResidentSession> {
    return CodexAppServerSession.start(this.sessionOptions(), spec, start);
  }

  async runTurn(request: TurnRequest, onEvent?: (event: AgentEvent) => void): Promise<TurnResult> {
    const session = await CodexAppServerSession.start(this.sessionOptions(), request.spec, request);
    try {
      return await session.runTurn(request.prompt, onEvent);
    } finally {
      await session.close();
    }
  }

  private sessionOptions(): AppServerSessionOptions {
    const { options } = this;
    return {
      sandbox: options.sandbox ?? "danger-full-access",
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.codexPath === undefined ? {} : { codexPath: options.codexPath }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.extraConfig === undefined ? {} : { extraConfig: options.extraConfig }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
      ...(options.recordDir === undefined ? {} : { recordDir: options.recordDir }),
    };
  }
}
