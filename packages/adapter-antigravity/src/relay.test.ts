import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TransientError } from "@stellaris/runner-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { BoardRelay, HANDSHAKE_TRIES } from "./relay.js";
import {
  callAsAgy,
  closedUrl,
  preloadAsAgy,
  startStubBoard,
  STUB_TOOLS,
  type McpEntry,
  type StubBoard,
} from "./testing/board.js";

const TOKEN = "stl_turn_relay";

let board: StubBoard;

beforeEach(async () => {
  board = await startStubBoard(TOKEN);
});

afterEach(async () => {
  await board.close();
});

async function openRelay(url = board.url, limitMs?: number): Promise<BoardRelay> {
  const relay = await BoardRelay.open({ url, token: TOKEN, limitMs });
  onTestFinished(() => relay.close());
  return relay;
}

const entryOf = (relay: BoardRelay): McpEntry => ({
  url: relay.url,
  authorization: `Bearer ${relay.secret}`,
});

/** What a relay's handshake ends with: "passed", or what it threw. */
const failing = async (limitMs?: number, url?: string): Promise<unknown> => {
  const relay = await openRelay(url, limitMs);
  return relay.prefetch().then(
    () => "passed",
    (error: unknown) => error,
  );
};

const rpcs = (): (string | null)[] => board.requests.map((each) => each.rpc);

describe("BoardRelay", () => {
  it("answers agy's handshake as the board does, which hears only the relay's own handshake", async () => {
    const relay = await openRelay();
    await relay.prefetch();
    expect(board.requests.map((each) => [each.rpc, each.authorized, each.protocolVersion])).toEqual(
      [
        ["initialize", true, null],
        ["notifications/initialized", true, "2025-11-25"],
        ["tools/list", true, "2025-11-25"],
      ],
    );
    const before = board.requests.length;
    expect(relay.listed).toBe(false);

    const relayed = await preloadAsAgy(entryOf(relay));
    expect(board.requests).toHaveLength(before);
    expect(relay.listed).toBe(true);

    // The board's own answers to the same exchanges, with its token, as agy got them before.
    const direct = await preloadAsAgy({ url: board.url, authorization: `Bearer ${TOKEN}` });
    expect(relayed.map((step) => [step.what, step.status])).toEqual(
      direct.map((step) => [step.what, step.status]),
    );
    expect(relayed.map((step) => step.status)).toEqual([400, 200, 202, 401, 401, 200, 202]);
    const [discover, initialize, , metadata, rootMetadata, tools] = relayed;
    const [boardDiscover, boardInitialize, , boardMetadata, boardRootMetadata, boardTools] = direct;
    expect(initialize?.body).toEqual(boardInitialize?.body);
    expect(tools?.body).toEqual(boardTools?.body);
    expect([metadata?.body, rootMetadata?.body]).toEqual([
      boardMetadata?.body,
      boardRootMetadata?.body,
    ]);
    // The SDK's refusal, naming only the version the relay agreed to.
    expect(discover?.body).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Bad Request: Unsupported protocol version: 2026-07-28 (supported versions: 2025-11-25)",
      },
      id: null,
    });
    expect(boardDiscover?.body).toMatchObject({
      error: {
        code: -32000,
        message: expect.stringContaining("Unsupported protocol version: 2026-07-28"),
      },
      id: null,
    });
    expect(initialize?.body).toMatchObject({
      id: 2,
      result: { protocolVersion: "2025-11-25", serverInfo: { name: "stellaris-board" } },
    });
  });

  it("serves the MCP SDK's own client, which lists and calls the board's tools", async () => {
    const relay = await openRelay();
    await relay.prefetch();
    const client = new Client({ name: "sdk-client", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(relay.url), {
        requestInit: { headers: { authorization: `Bearer ${relay.secret}` } },
      }),
    );
    onTestFinished(() => client.close());
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(STUB_TOOLS);
    const called = await client.callTool({ name: "post_message", arguments: { body: "hi" } });
    expect(called.content).toEqual([
      { type: "text", text: 'stub post_message ran with {"body":"hi"}' },
    ]);
    // The client's own handshake came from the relay; its GET for a stream, which agy never
    // sends with its header, went on to the board, as anything else does.
    expect(board.requests.map((each) => [each.method, each.rpc])).toEqual([
      ["POST", "initialize"],
      ["POST", "notifications/initialized"],
      ["POST", "tools/list"],
      ["GET", null],
      ["POST", "tools/call"],
    ]);
  });

  it("passes tools/call on to the board with the turn's token, and the board's answer back", async () => {
    const relay = await openRelay();
    await relay.prefetch();
    const called = await callAsAgy(entryOf(relay), "claim_task", {
      task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(called).toMatchObject({
      status: 200,
      body: {
        id: 4,
        result: {
          content: [
            {
              type: "text",
              text: 'stub claim_task ran with {"task_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
            },
          ],
        },
      },
    });
    const call = board.requests.at(-1);
    expect(call).toMatchObject({
      rpc: "tools/call",
      authorized: true,
      protocolVersion: "2025-11-25",
    });
    expect(call?.body).not.toContain(relay.secret);
  });

  it("answers a call the board can't be reached for with a 502 and a JSON-RPC error", async () => {
    const relay = await openRelay();
    await relay.prefetch();
    await board.close();
    const called = await callAsAgy(entryOf(relay), "post_message", {});
    expect(called).toMatchObject({
      status: 502,
      body: {
        jsonrpc: "2.0",
        id: 4,
        error: {
          code: -32603,
          message: expect.stringMatching(
            /^the board could not be reached: TypeError: fetch failed/,
          ),
        },
      },
    });
  });

  it("refuses a request without its secret, which never reaches the board", async () => {
    const relay = await openRelay();
    await relay.prefetch();
    const before = board.requests.length;
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${TOKEN}`, relay.secret]) {
      const answer = await callAsAgy({ url: relay.url, authorization }, "post_message", {});
      expect(answer).toEqual({
        what: "tools/call",
        status: 401,
        body: { error: "UNAUTHORIZED", message: "a valid bearer token is required" },
      });
    }
    // With the secret, only the board's MCP is served.
    const elsewhere = await fetch(new URL("/api/tasks", relay.url), {
      headers: { authorization: `Bearer ${relay.secret}` },
    });
    expect(elsewhere.status).toBe(404);
    expect(board.requests).toHaveLength(before);
  });

  describe("a handshake that fails", () => {
    it("fails as transient for a board out of reach or one that answers 401, 429, or 5xx, after trying again", async () => {
      const refused = await failing(undefined, await closedUrl());
      expect(refused).toBeInstanceOf(TransientError);
      expect(refused).toMatchObject({
        message: expect.stringMatching(
          /^the board's MCP handshake failed before agy opened the session, on each of 2 tries: TypeError: fetch failed, caused by .*ECONNREFUSED/,
        ),
      });

      board.mode = { reset: true };
      const reset = await failing();
      expect(reset).toBeInstanceOf(TransientError);
      expect(reset).toMatchObject({ message: expect.stringContaining("fetch failed") });
      expect(rpcs()).toEqual(["initialize", "initialize"]);

      board.mode = { stall: true };
      const stalled = await failing(150);
      expect(stalled).toBeInstanceOf(TransientError);
      expect(stalled).toMatchObject({
        message: expect.stringContaining(": no answer within 150 ms"),
      });

      for (const status of [401, 429, 503]) {
        board.mode = { status };
        const refusal = await failing();
        expect(refusal).toBeInstanceOf(TransientError);
        expect(refusal).toMatchObject({
          message: expect.stringContaining(`: the board answered initialize with ${status}`),
        });
      }
      // A stall later in the handshake is cut by the same limit.
      board.requests.length = 0;
      board.mode = { stallMethods: ["tools/list"] };
      expect(await failing(150)).toBeInstanceOf(TransientError);
      expect(rpcs().filter((rpc) => rpc === "tools/list")).toHaveLength(HANDSHAKE_TRIES);
    });

    it("fails for good for any other refusal, after trying again", async () => {
      for (const status of [403, 404]) {
        board.requests.length = 0;
        board.mode = { status };
        const refusal = await failing();
        expect(refusal).toBeInstanceOf(Error);
        expect(refusal).not.toBeInstanceOf(TransientError);
        expect(rpcs()).toEqual(["initialize", "initialize"]);
      }
    });

    it("passes a try that comes after a failed one", async () => {
      board.mode = { reset: true, once: true };
      const relay = await openRelay();
      await relay.prefetch();
      expect(rpcs()).toEqual([
        "initialize",
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
    });
  });

  it("closes with its connections, cutting off a call on its way to the board", async () => {
    const relay = await openRelay();
    await relay.prefetch();
    board.mode = { stallMethods: ["tools/call"] };
    const call = callAsAgy(entryOf(relay), "post_message", {}).then(
      () => "answered",
      () => "cut",
    );
    await vi.waitFor(() => expect(rpcs().at(-1)).toBe("tools/call"));
    await relay.close();
    expect(await call).toBe("cut");
    await expect(callAsAgy(entryOf(relay), "post_message", {})).rejects.toThrow("fetch failed");
  });
});
