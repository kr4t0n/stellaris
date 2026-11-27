import { randomUUID } from "node:crypto";
import type {
  AgentBackend,
  AgentSpec,
  ResidentSession,
  ResidentStart,
  SessionId,
  TurnControl,
  TurnRequest,
  TurnResult,
} from "@stellaris/runner-core";
import type { AgentEvent, CliQuota, ModelOption } from "@stellaris/shared";
import { readPrintQuota, type RunPrint } from "./quota.js";
import type { SpawnAgy } from "./rpc.js";
import {
  AntigravityAcpSession,
  listAcpModels,
  PENDING_SESSION_PREFIX,
  type AcpSessionOptions,
} from "./session.js";

export interface AntigravityOptions {
  readonly agyPath?: string | undefined;
  /** Where agy keeps its settings, sign-in, and conversations, in place of `~/.gemini`. */
  readonly geminiDir?: string | undefined;
  readonly model?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stderr?: ((line: string) => void) | undefined;
  /** Directory to append agy's raw output to, one file per turn, for fixtures. */
  readonly recordDir?: string | undefined;
  /** Spawns `agy acp`; injectable for tests. */
  readonly spawn?: SpawnAgy | undefined;
  /** Runs `agy -p` to its end, for the quota read; injectable for tests. */
  readonly runPrint?: RunPrint | undefined;
  /** The clock quota reports, a read's or a refused turn's, are stamped by; tests inject one. */
  readonly now?: (() => Date) | undefined;
  /** How long each try of the board's handshake, which the relay makes, may take; tests shorten it. */
  readonly handshakeLimitMs?: number | undefined;
}

/**
 * Google's Antigravity CLI through `agy acp`. A cold turn starts the server, opens or resumes the
 * pair's session, runs one turn, and stops the server; a resident session keeps both between
 * turns. agy reaches the board through a relay of the session's own on 127.0.0.1, which has done
 * the board's handshake with the turn's token before the session opens; the relay's address and
 * secret travel in the session's `mcpServers`, the instructions as the system prompt's append,
 * both over stdin.
 */
export class AntigravityBackend implements AgentBackend {
  readonly kind = "antigravity" as const;
  readonly steers = true;
  readonly stops = true;

  constructor(private readonly options: AntigravityOptions = {}) {}

  /** agy picks session ids itself; the placeholder is replaced by the id `session/new` gives. */
  newSession(): Promise<SessionId> {
    return Promise.resolve(`${PENDING_SESSION_PREFIX}${randomUUID()}`);
  }

  startResident(spec: AgentSpec, start: ResidentStart): Promise<ResidentSession> {
    return AntigravityAcpSession.start(this.sessionOptions(), spec, start);
  }

  /** The models agy offers, asked of a server started for the question. */
  listModels(): Promise<ModelOption[]> {
    return listAcpModels(this.sessionOptions());
  }

  /** The plan quota from `agy -p /usage` and `/credits`, which make no model call. */
  readQuota(): Promise<CliQuota> {
    const { options } = this;
    return readPrintQuota({
      ...(options.agyPath === undefined ? {} : { agyPath: options.agyPath }),
      ...(options.geminiDir === undefined ? {} : { geminiDir: options.geminiDir }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.runPrint === undefined ? {} : { runPrint: options.runPrint }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  async runTurn(
    request: TurnRequest,
    onEvent?: (event: AgentEvent) => void,
    control?: TurnControl,
  ): Promise<TurnResult> {
    const session = await AntigravityAcpSession.start(this.sessionOptions(), request.spec, request);
    try {
      return await session.runTurn(request.prompt, onEvent, control);
    } finally {
      await session.close();
    }
  }

  private sessionOptions(): AcpSessionOptions {
    const { options } = this;
    return {
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.agyPath === undefined ? {} : { agyPath: options.agyPath }),
      ...(options.geminiDir === undefined ? {} : { geminiDir: options.geminiDir }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
      ...(options.recordDir === undefined ? {} : { recordDir: options.recordDir }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.handshakeLimitMs === undefined
        ? {}
        : { handshakeLimitMs: options.handshakeLimitMs }),
    };
  }
}
