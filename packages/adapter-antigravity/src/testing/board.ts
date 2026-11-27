import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

/**
 * Test doubles for the board's MCP endpoint and for agy's side of it, for the relay's tests. Not
 * imported by the adapter itself.
 */

/** What reached a stub board, in order. */
export interface BoardRequest {
  readonly method: string;
  readonly path: string;
  /** The JSON-RPC method the body named, or null. */
  readonly rpc: string | null;
  /** Whether the bearer was the board's token. */
  readonly authorized: boolean;
  readonly protocolVersion: string | null;
  readonly body: string;
}

/** How a stub board treats the requests that reach it from now on. */
export interface BoardMode {
  /** Answers every request with this status, as the route does a token it doesn't know. */
  readonly status?: number | undefined;
  /** Closes the connection of every request unanswered. */
  readonly reset?: boolean | undefined;
  /** Never answers. */
  readonly stall?: boolean | undefined;
  /** Never answers these JSON-RPC methods; the rest go on. */
  readonly stallMethods?: readonly string[] | undefined;
  /** Treats only the next request so, then answers again. */
  readonly once?: boolean | undefined;
}

export interface StubBoard {
  readonly url: string;
  readonly token: string;
  readonly requests: BoardRequest[];
  mode: BoardMode;
  close(): Promise<void>;
}

/** The tools a stub board lists; each answers with what it was given. */
export const STUB_TOOLS = ["claim_task", "post_message"];

/** What the stub's tools take, so a call's arguments reach them. */
const STUB_INPUT = { body: z.string().optional(), task_id: z.string().optional() };

/** The board's route answering a bearer it doesn't know, as the server does. */
const UNAUTHORIZED = JSON.stringify({
  error: "UNAUTHORIZED",
  message: "a valid bearer token is required",
});

function rpcOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" &&
      parsed !== null &&
      "method" in parsed &&
      typeof parsed.method === "string"
      ? parsed.method
      : null;
  } catch {
    return null;
  }
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The board's `/mcp` as the server runs it: the route's 401 for any bearer but its token, then a
 * stateless MCP server on the SDK's web-standard transport with JSON answers, as
 * `handleMcpRequest` builds one per request, with the version the board's packages pin.
 */
export async function startStubBoard(token: string): Promise<StubBoard> {
  const requests: BoardRequest[] = [];
  const state: { mode: BoardMode } = { mode: {} };
  const server = createServer((request, response) => {
    void (async () => {
      const body = await bodyOf(request);
      const rpc = rpcOf(body);
      const authorized = request.headers.authorization === `Bearer ${token}`;
      const version = request.headers["mcp-protocol-version"];
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        rpc,
        authorized,
        protocolVersion: typeof version === "string" ? version : null,
        body,
      });
      const { mode } = state;
      if (mode.once === true) {
        state.mode = {};
      }
      if (mode.reset === true) {
        request.socket.destroy();
        return;
      }
      if (mode.stall === true || (rpc !== null && mode.stallMethods?.includes(rpc) === true)) {
        return;
      }
      if (mode.status !== undefined || !authorized) {
        response
          .writeHead(mode.status ?? 401, { "content-type": "application/json" })
          .end(UNAUTHORIZED);
        return;
      }
      const mcp = new McpServer({ name: "stellaris-board", version: "0.0.0-test" });
      for (const name of STUB_TOOLS) {
        mcp.registerTool(
          name,
          { description: `Stub ${name}.`, inputSchema: STUB_INPUT },
          (args) => ({
            content: [{ type: "text", text: `stub ${name} ran with ${JSON.stringify(args)}` }],
          }),
        );
      }
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(transport);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const answer = await transport.handleRequest(
        new Request(`http://127.0.0.1${request.url ?? "/"}`, {
          method: request.method ?? "GET",
          headers,
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body }),
        }),
      );
      const text = Buffer.from(await answer.arrayBuffer());
      response.writeHead(answer.status, Object.fromEntries(answer.headers)).end(text);
      await mcp.close();
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    requests,
    get mode(): BoardMode {
      return state.mode;
    },
    set mode(mode: BoardMode) {
      state.mode = mode;
    },
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** An MCP address on 127.0.0.1 where nothing listens, so a connection is refused. */
export async function closedUrl(): Promise<string> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp`;
}

/** The `http` MCP server a session was opened with, as agy reads it from `mcpServers`. */
export interface McpEntry {
  readonly url: string;
  readonly authorization: string | undefined;
}

export function mcpEntryOf(params: Record<string, unknown>): McpEntry | undefined {
  const servers = params["mcpServers"];
  const entry: unknown = Array.isArray(servers) ? servers[0] : undefined;
  if (typeof entry !== "object" || entry === null || !("url" in entry)) {
    return undefined;
  }
  const headers = "headers" in entry && Array.isArray(entry.headers) ? entry.headers : [];
  const authorization: unknown = headers.find(
    (each: unknown) =>
      typeof each === "object" && each !== null && "name" in each && each.name === "Authorization",
  );
  return {
    url: String(entry.url),
    authorization:
      typeof authorization === "object" && authorization !== null && "value" in authorization
        ? String(authorization.value)
        : undefined,
  };
}

/** One exchange of agy's handshake and what it was answered. */
export interface PreloadStep {
  readonly what: string;
  readonly status: number;
  readonly body: unknown;
}

const AGY_CLIENT = { name: "antigravity-client", version: "v1.0.0" };
const AGY_CAPABILITIES = { elicitation: { form: {}, url: {} }, roots: { listChanged: true } };

/**
 * agy 1.5.15's handshake with a session's MCP server, as a stub captured it on 2026-11-27, one
 * exchange after another: what each was answered. Its two GETs carry no header, as agy's don't.
 */
export async function preloadAsAgy(entry: McpEntry): Promise<PreloadStep[]> {
  const steps: PreloadStep[] = [];
  const root = new URL(entry.url);
  const exchange = async (
    what: string,
    init: { method: string; path?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<void> => {
    const authorized = init.method === "POST" && entry.authorization !== undefined;
    const response = await fetch(new URL(init.path ?? root.pathname, root), {
      method: init.method,
      headers: {
        ...(init.method === "POST"
          ? { accept: "application/json, text/event-stream", "content-type": "application/json" }
          : {}),
        ...(authorized ? { authorization: entry.authorization ?? "" } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // The answer's text, as it came.
    }
    steps.push({ what, status: response.status, body });
  };
  await exchange("server/discover", {
    method: "POST",
    headers: { "mcp-method": "server/discover", "mcp-protocol-version": "2026-07-28" },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": AGY_CAPABILITIES,
          "io.modelcontextprotocol/clientInfo": AGY_CLIENT,
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
      },
    },
  });
  await exchange("initialize", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        clientInfo: AGY_CLIENT,
        protocolVersion: "2025-11-25",
        capabilities: AGY_CAPABILITIES,
      },
    },
  });
  const version = { "mcp-protocol-version": "2025-11-25" };
  await exchange("notifications/initialized", {
    method: "POST",
    headers: version,
    body: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });
  await exchange("GET resource metadata", {
    method: "GET",
    path: `/.well-known/oauth-protected-resource${root.pathname}`,
  });
  await exchange("GET root resource metadata", {
    method: "GET",
    path: "/.well-known/oauth-protected-resource",
  });
  await exchange("tools/list", {
    method: "POST",
    headers: version,
    body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
  });
  await exchange("notifications/roots/list_changed", {
    method: "POST",
    headers: version,
    body: { jsonrpc: "2.0", method: "notifications/roots/list_changed", params: {} },
  });
  return steps;
}

/** How long agy 1.5.15 gives a session's MCP servers to connect, in all. */
export const AGY_PRELOAD_MS = 5_000;

/**
 * agy 1.5.15 opening a session: its handshake with the session's MCP server, given 5 s in all,
 * after which, or after any failure, it opens the session anyway and says nothing. The steps, or
 * what became of them.
 */
export async function openAsAgy(entry: McpEntry): Promise<PreloadStep[] | "failed" | "timed out"> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<"timed out">((resolve) => {
    timer = setTimeout(() => resolve("timed out"), AGY_PRELOAD_MS);
  });
  try {
    return await Promise.race([preloadAsAgy(entry).catch(() => "failed" as const), budget]);
  } finally {
    clearTimeout(timer);
  }
}

/** A `tools/call` as agy sends one, and what it was answered. */
export async function callAsAgy(
  entry: McpEntry,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PreloadStep> {
  const response = await fetch(entry.url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      ...(entry.authorization === undefined ? {} : { authorization: entry.authorization }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // The answer's text, as it came.
  }
  return { what: "tools/call", status: response.status, body };
}
