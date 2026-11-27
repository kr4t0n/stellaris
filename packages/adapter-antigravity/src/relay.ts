import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describeError, TransientError } from "@stellaris/runner-core";
import { isDict, str, type Dict } from "./rpc.js";

/**
 * The board's MCP endpoint as agy reaches it: an HTTP server on 127.0.0.1, one per session, that
 * does the board's handshake itself before agy opens the session and answers agy's from what the
 * board said. agy 1.5.15 gives a session's MCP servers 5 s in all to connect, and opens the session
 * without one that takes longer, telling the client nothing; over a slow path to the board its
 * handshake took longer about a third of the time. Through the relay, agy's handshake never waits
 * on the network, and a board out of reach fails the turn before the session opens.
 *
 * agy 1.5.15 connects with `server/discover`, `initialize`, `notifications/initialized`, two GETs
 * of OAuth's well-known metadata without its header, and `tools/list`, one after another on one
 * connection, then sends `notifications/roots/list_changed`. The relay answers those itself and
 * passes every other request, `tools/call` above all, on to the board with the turn's token. agy
 * reaches it with a secret of the session's own, so agy's conversation record keeps that secret,
 * which dies with the relay, and never the turn's token.
 */

/**
 * How long one try of the board's handshake may take: above the p90 of agy's whole handshake over
 * the slow path it was measured on, 11.2 s for twice the relay's exchanges, while a try that
 * stalls, as some there did for 30 s and more, is cut and made again.
 */
export const HANDSHAKE_LIMIT_MS = 15_000;

/** How many times the relay tries the board's handshake before the turn fails. */
export const HANDSHAKE_TRIES = 2;

/**
 * The MCP version the relay asks the board for, which agy 1.5.15 asks for in `initialize` and the
 * board's MCP SDK, 1.32.2, answers as its latest. agy is answered with what the board agreed to.
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

/** The path agy is given, the only one the relay serves. */
const RELAY_PATH = "/mcp";

/** The largest request the relay reads, above the board's own 1 MiB, so the board refuses what it would. */
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** What the board's route answers a request without a token it knows, which agy 1.5.15 takes. */
const UNAUTHORIZED = { error: "UNAUTHORIZED", message: "a valid bearer token is required" };

/** agy's request headers the board reads, passed on as they came; the rest stay at the relay. */
const FORWARDED_HEADERS = ["content-type", "accept", "last-event-id"];

/** What the board said to the relay's handshake: the protocol version it agreed to and its two results. */
interface Handshake {
  readonly version: string;
  readonly initialize: Dict;
  readonly tools: Dict;
}

/** An answer the relay gives agy itself. */
interface LocalAnswer {
  readonly status: number;
  readonly body?: Dict | undefined;
}

/** The board answering a handshake request with a status other than success. */
class HandshakeRefused extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
  ) {
    super(`the board answered ${method} with ${status}`);
  }
}

export interface BoardRelayOptions {
  /** The board's MCP endpoint. */
  readonly url: string;
  /** The turn's token, which only the relay sends. */
  readonly token: string;
  /** How long one try of the handshake may take; tests shorten it. */
  readonly limitMs?: number | undefined;
  readonly clientVersion?: string | undefined;
}

export class BoardRelay {
  /** The secret agy sends as its bearer token, the session's own. */
  readonly secret = randomBytes(32).toString("base64url");
  private readonly server: Server;
  private readonly closing = new AbortController();
  private handshake: Handshake | undefined;
  private listedTools = false;

  private constructor(private readonly options: BoardRelayOptions) {
    this.server = createServer((request, response) => {
      this.handle(request, response).catch(() => response.destroy());
    });
  }

  /** A relay listening on a port of its own on 127.0.0.1, before its handshake. */
  static async open(options: BoardRelayOptions): Promise<BoardRelay> {
    const relay = new BoardRelay(options);
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    return relay;
  }

  /** The address agy is given. */
  get url(): string {
    const address = this.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return `http://127.0.0.1:${port}${RELAY_PATH}`;
  }

  /** Whether agy has listed the board's tools from the relay, as it does while opening the session. */
  get listed(): boolean {
    return this.listedTools;
  }

  /**
   * Does the board's handshake, `initialize`, `notifications/initialized`, and `tools/list`, with
   * the turn's token, trying again once on any failure. A board out of reach, as when it refused
   * the connection, cut it, or answered nothing within the limit, or one that answered 401, 429, or
   * 5xx, fails with a `TransientError`, since the same wake, with a new token, may pass in a minute;
   * any other answer fails for good.
   */
  async prefetch(): Promise<void> {
    let failure: unknown;
    for (let tried = 0; tried < HANDSHAKE_TRIES && !this.closing.signal.aborted; tried += 1) {
      try {
        this.handshake = await this.shake();
        return;
      } catch (error) {
        failure = error;
      }
    }
    const words = `the board's MCP handshake failed before agy opened the session, on each of ${HANDSHAKE_TRIES} tries: ${this.describe(failure)}`;
    throw passesLater(failure) ? new TransientError(words) : new Error(words);
  }

  /** Stops listening, ends agy's connections, and cuts off what is on its way to the board. */
  async close(): Promise<void> {
    this.closing.abort();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async shake(): Promise<Handshake> {
    const limit = this.options.limitMs ?? HANDSHAKE_LIMIT_MS;
    const signal = AbortSignal.any([AbortSignal.timeout(limit), this.closing.signal]);
    const initialize = await this.call(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "stellaris-runner", version: this.options.clientVersion ?? "0.0.0" },
      },
      signal,
    );
    const version = str(initialize["protocolVersion"]);
    if (version === undefined) {
      throw new Error("the board's initialize answer names no protocol version");
    }
    const initialized = await this.post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      signal,
      version,
    );
    await initialized.body?.cancel();
    if (!initialized.ok) {
      throw new HandshakeRefused("notifications/initialized", initialized.status);
    }
    const tools = await this.call("tools/list", {}, signal, version);
    if (!Array.isArray(tools["tools"])) {
      throw new Error("the board's tools/list answer lists no tools");
    }
    return { version, initialize, tools };
  }

  private post(message: Dict, signal: AbortSignal, version?: string): Promise<Response> {
    return fetch(this.options.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(version === undefined ? {} : { "mcp-protocol-version": version }),
      },
      body: JSON.stringify(message),
      signal,
    });
  }

  /** One request of the handshake and its result, from a JSON answer or an event stream. */
  private async call(
    method: string,
    params: Dict,
    signal: AbortSignal,
    version?: string,
  ): Promise<Dict> {
    const id = method;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal, version);
    if (!response.ok) {
      await response.body?.cancel();
      throw new HandshakeRefused(method, response.status);
    }
    const answer = answerOf(await response.text(), response.headers.get("content-type"), id);
    if (answer === undefined || !isDict(answer["result"])) {
      throw new Error(`the board answered ${method} with no result`);
    }
    return answer["result"];
  }

  private describe(failure: unknown): string {
    if (isTimeout(failure)) {
      return `no answer within ${this.options.limitMs ?? HANDSHAKE_LIMIT_MS} ms`;
    }
    return failure instanceof HandshakeRefused ? failure.message : describeError(failure);
  }

  private admits(authorization: string | undefined): boolean {
    if (authorization === undefined) {
      return false;
    }
    const given = Buffer.from(authorization);
    const expected = Buffer.from(`Bearer ${this.secret}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Before anything else, as the board's route does, so agy's well-known GETs, which carry no
    // header, get the board's 401.
    if (!this.admits(request.headers.authorization)) {
      send(response, 401, UNAUTHORIZED);
      return;
    }
    if (new URL(request.url ?? "/", "http://relay").pathname !== RELAY_PATH) {
      send(response, 404, { error: "NOT_FOUND", message: "the relay serves only the board's MCP" });
      return;
    }
    const body = request.method === "POST" ? await readBody(request) : undefined;
    if (body === null) {
      send(response, 413, { error: "PAYLOAD_TOO_LARGE", message: "the request is too large" });
      return;
    }
    const message = body === undefined ? undefined : parse(body);
    const local = isDict(message) ? this.answerOf(message, request) : undefined;
    if (local !== undefined) {
      send(response, local.status, local.body);
      return;
    }
    await this.forward(request, response, body, isDict(message) ? message["id"] : undefined);
  }

  /**
   * What the relay answers agy itself once the handshake is done: the board's own answers to
   * `initialize` and `tools/list`, under agy's ids; a 202 for any notification, which the board,
   * keeping no session, takes and drops; and for `server/discover`, which the board's SDK refuses,
   * the SDK's refusal, so agy goes on to `initialize`. Anything else goes to the board.
   */
  private answerOf(message: Dict, request: IncomingMessage): LocalAnswer | undefined {
    const handshake = this.handshake;
    const method = message["method"];
    if (handshake === undefined || typeof method !== "string") {
      return undefined;
    }
    if (!("id" in message)) {
      return { status: 202 };
    }
    const result = (body: Dict): LocalAnswer => ({
      status: 200,
      body: { jsonrpc: "2.0", id: message["id"], result: body },
    });
    if (method === "initialize") {
      return result(handshake.initialize);
    }
    if (method === "tools/list" && str(paramsOf(message)["cursor"]) === undefined) {
      this.listedTools = true;
      return result(handshake.tools);
    }
    if (method === "server/discover") {
      const asked = request.headers["mcp-protocol-version"] ?? "none";
      return {
        status: 400,
        body: {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `Bad Request: Unsupported protocol version: ${String(asked)} (supported versions: ${handshake.version})`,
          },
          id: null,
        },
      };
    }
    return undefined;
  }

  /** Passes agy's request on to the board with the turn's token, and the board's answer back as it comes. */
  private async forward(
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer | undefined,
    id: unknown,
  ): Promise<void> {
    // agy giving up on a call, by closing its connection, gives the board's request up too.
    const gone = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) {
        gone.abort();
      }
    });
    const headers = new Headers({ authorization: `Bearer ${this.options.token}` });
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        typeof value === "string" &&
        (FORWARDED_HEADERS.includes(name) || name.startsWith("mcp-"))
      ) {
        headers.set(name, value);
      }
    }
    let answer: Response;
    try {
      answer = await fetch(this.options.url, {
        method: request.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
        signal: AbortSignal.any([gone.signal, this.closing.signal]),
      });
    } catch (error) {
      send(response, 502, {
        jsonrpc: "2.0",
        error: { code: -32603, message: `the board could not be reached: ${describeError(error)}` },
        id: typeof id === "string" || typeof id === "number" ? id : null,
      });
      return;
    }
    const passed: Record<string, string> = {};
    for (const [name, value] of answer.headers) {
      if (name === "content-type" || name.startsWith("mcp-")) {
        passed[name] = value;
      }
    }
    response.writeHead(answer.status, passed);
    if (answer.body === null) {
      response.end();
      return;
    }
    try {
      for await (const chunk of answer.body) {
        if (!response.write(chunk)) {
          await once(response, "drain");
        }
      }
      response.end();
    } catch {
      response.destroy();
    }
  }
}

function paramsOf(message: Dict): Dict {
  return isDict(message["params"]) ? message["params"] : {};
}

function send(response: ServerResponse, status: number, body?: Dict): void {
  if (response.headersSent || response.destroyed) {
    return;
  }
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** A request's body, or null past the limit. */
async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += piece.length;
    if (size > BODY_LIMIT_BYTES) {
      return null;
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

function parse(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The JSON-RPC answer with this id in a JSON body, or in an event stream's `data` lines. */
function answerOf(text: string, type: string | null, id: string): Dict | undefined {
  const messages =
    type?.includes("text/event-stream") === true
      ? text
          .split(/\r?\n/)
          .flatMap((line) => (line.startsWith("data:") ? [parse(Buffer.from(line.slice(5)))] : []))
      : [parse(Buffer.from(text))];
  return messages.find((each): each is Dict => isDict(each) && each["id"] === id);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Whether a failed handshake may pass in a minute: the board out of reach, which fetch reports as
 * a `TypeError`, "fetch failed" before an answer and "terminated" while reading one; no answer
 * within the limit; or a 401, 429, or 5xx. A 401 is the board not knowing the turn's token, as
 * after its restart, and the wake that goes again carries a new one.
 */
function passesLater(error: unknown): boolean {
  if (error instanceof HandshakeRefused) {
    return error.status === 401 || error.status === 429 || error.status >= 500;
  }
  return (
    isTimeout(error) ||
    (error instanceof TypeError &&
      (error.message === "fetch failed" || error.message === "terminated"))
  );
}
