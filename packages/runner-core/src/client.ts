import {
  type HeldWorkspace,
  FileContentsSchema,
  FileManifestSchema,
  RunnerMessageSchema,
  RunnerWelcomeSchema,
  TurnAckSchema,
  type RunnerAnswer,
  type RunnerHelloInput,
  type RunnerMessage,
  type RunnerWelcome,
  type TranscriptEntry,
  type TurnAck,
  type TurnOutcome,
} from "@stellaris/shared";
import type { HomeRemote } from "./home.js";
import type { RemoteTree } from "./sync.js";

export class RunnerHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** How long the server asked to wait, from a 429's Retry-After. */
    readonly retryAfterMs?: number | undefined,
  ) {
    super(message);
  }
}

/**
 * The runner's side of the runner protocol over HTTP: register, hold the server's event stream,
 * and post events, outcomes, answers, warm sessions, and files back, all with the runner's token.
 */
export class RunnerClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async hello(hello: RunnerHelloInput): Promise<RunnerWelcome> {
    return RunnerWelcomeSchema.parse(await this.call("POST", "/runner/hello", hello));
  }

  /**
   * Holds the server's event stream open and hands each message to `onMessage`, until the stream
   * ends, fails, or `signal` aborts. `onOpen` runs once the server has attached the stream, and
   * unknown or malformed messages are reported and skipped.
   */
  async stream(
    signal: AbortSignal,
    handlers: {
      readonly onOpen?: (() => void) | undefined;
      readonly onMessage: (message: RunnerMessage) => void;
      readonly onMalformed?: ((problem: string) => void) | undefined;
    },
  ): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/runner/stream`, {
      headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || response.body === null) {
      throw new RunnerHttpError(response.status, `the event stream answered ${response.status}`);
    }
    handlers.onOpen?.();
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffer += value;
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data === "") {
          continue;
        }
        try {
          const parsed = RunnerMessageSchema.safeParse(JSON.parse(data));
          if (parsed.success) {
            handlers.onMessage(parsed.data);
          } else {
            handlers.onMalformed?.(parsed.error.message);
          }
        } catch (error) {
          handlers.onMalformed?.(String(error));
        }
      }
    }
  }

  async events(turnId: string, entries: readonly TranscriptEntry[]): Promise<void> {
    await this.call("POST", `/runner/turns/${turnId}/events`, { entries });
  }

  async outcome(turnId: string, outcome: TurnOutcome): Promise<TurnAck> {
    return TurnAckSchema.parse(await this.call("POST", `/runner/turns/${turnId}/outcome`, outcome));
  }

  async answer(request: string, answer: RunnerAnswer): Promise<void> {
    await this.call("POST", `/runner/requests/${request}`, answer);
  }

  async warm(keys: readonly string[]): Promise<void> {
    await this.call("POST", "/runner/warm", { warm: keys });
  }

  /** The conversations' workspaces this runner holds, so those that ended while it was away go. */
  async workspaces(workspaces: readonly HeldWorkspace[]): Promise<void> {
    await this.call("POST", "/runner/workspaces", { workspaces });
  }

  /** The board's projection, read only. */
  boardTree(): RemoteTree {
    return {
      manifest: async () =>
        FileManifestSchema.parse(await this.call("GET", "/runner/board/manifest")).files,
      read: async (paths) =>
        FileContentsSchema.parse(await this.call("POST", "/runner/board/read", { paths })).files,
    };
  }

  /**
   * Agents' home repositories on the server, which this runner may clone, fetch, and push while it
   * runs a turn of the agent.
   */
  homeRemote(): HomeRemote {
    return {
      url: (agent) => `${this.baseUrl}/runner/homes/${encodeURIComponent(agent)}/git`,
      authorization: `Authorization: Bearer ${this.token}`,
    };
  }

  /** One request; the parsed JSON answer, or null for an empty one. */
  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new RunnerHttpError(
        response.status,
        `${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    return text === "" ? null : JSON.parse(text);
  }
}
