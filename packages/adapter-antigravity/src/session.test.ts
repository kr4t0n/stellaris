import { PassThrough } from "node:stream";
import { ResumeError, TransientError, TurnControl, type TurnRequest } from "@stellaris/runner-core";
import { turnStatusJsonSchema, type AgentEvent } from "@stellaris/shared";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { AntigravityBackend } from "./backend.js";
import type { SpawnAgy } from "./rpc.js";
import { isTransient, quotaRefusalOf, warningOf } from "./session.js";
import {
  callAsAgy,
  closedUrl,
  mcpEntryOf,
  preloadAsAgy,
  startStubBoard,
  type BoardMode,
  type McpEntry,
  type StubBoard,
} from "./testing/board.js";

/** The board every turn's relay does its handshake with. */
let board: StubBoard;

beforeAll(async () => {
  board = await startStubBoard("stl_turn");
});

afterAll(async () => {
  await board.close();
});

const SESSION = "6b98cecf-cf82-4a72-a2bc-28d4b3331028";

const STATUS = (summary: string): string =>
  "```json\n" +
  JSON.stringify({
    summary,
    claimsHeld: [],
    blockedOn: [],
    needsUserDecision: false,
    memoryUpdated: false,
  }) +
  "\n```";

type Params = Record<string, unknown>;

function isParams(value: unknown): value is Params {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A message's object, or an empty one. */
function paramsOf(value: unknown): Params {
  return isParams(value) ? value : {};
}

/** The text of a `session/prompt`'s first block. */
function promptTextOf(params: Params): unknown {
  const prompt = params["prompt"];
  return Array.isArray(prompt) ? paramsOf(prompt[0])["text"] : undefined;
}

/** agy's warning as 1.5.15 sends it, a line between newlines after the warning sign. */
const said = (words: string): string | undefined => warningOf(`\n\u26a0 ${words}\n`);

interface Fake {
  /** Sends a `session/update` for the session. */
  update(update: Params): void;
  /** Writes a raw line, as the agent's own request. */
  write(message: Params): void;
  exit(code: number | null): void;
}

/** What the fake answers a request with: a result, an error, or a promise of either. */
type Answer = { result: unknown } | { error: { code: number; message: string } };
type Script = Record<string, (params: Params, fake: Fake) => Answer | Promise<Answer>>;

const INITIALIZED: Answer = {
  result: {
    protocolVersion: 1,
    agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
  },
};

const OPENED: Answer = {
  result: {
    sessionId: SESSION,
    configOptions: [
      {
        id: "model",
        type: "select",
        currentValue: "gemini-3.1-pro",
        options: [{ value: "gemini-3.1-pro", name: "Gemini 3.1 Pro" }],
      },
    ],
  },
};

const ended = (usage?: Params): Answer => ({
  result: { stopReason: "end_turn", ...(usage === undefined ? {} : { usage }) },
});

const USAGE = { inputTokens: 600, outputTokens: 60, cachedReadTokens: 400, thoughtTokens: 10 };

/**
 * A scripted `agy acp`: each request goes to the script's handler for its method, which answers
 * now or later and may send updates first; every message the client sent is kept. Before it
 * answers `session/new` or `session/resume`, it connects to the session's MCP server as agy 1.5.15
 * does, unless told not to, and keeps the server's entry.
 */
function fakeAgy(
  script: Script,
  { preload = true }: { preload?: boolean } = {},
): { spawn: SpawnAgy; sent: Params[]; spawns: number; entries: McpEntry[] } {
  const sent: Params[] = [];
  const entries: McpEntry[] = [];
  const state = { spawns: 0 };
  const spawn: SpawnAgy = () => {
    state.spawns += 1;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const { promise: exited, resolve: exit } = Promise.withResolvers<number | null>();
    const fake: Fake = {
      update: (update) =>
        stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update } })}\n`,
        ),
      write: (message) => stdout.write(`${JSON.stringify(message)}\n`),
      exit: (code) => exit(code),
    };
    let buffer = "";
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = paramsOf(JSON.parse(line));
        sent.push(message);
        const method = message["method"];
        const id = message["id"];
        if (typeof method !== "string") continue;
        const handler = script[method];
        if (id === undefined) {
          // A notification, such as `session/cancel`, gets no reply.
          void handler?.(paramsOf(message["params"]), fake);
          continue;
        }
        const params = paramsOf(message["params"]);
        const entry =
          method === "session/new" || method === "session/resume" ? mcpEntryOf(params) : undefined;
        if (entry !== undefined) {
          entries.push(entry);
        }
        void (async (): Promise<Answer> => {
          if (entry !== undefined && preload) {
            await preloadAsAgy(entry);
          }
          return handler === undefined
            ? { error: { code: -32601, message: `no ${method}` } }
            : handler(params, fake);
        })().then((answer) =>
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...answer })}\n`),
        );
      }
    });
    return { stdin, stdout, stderr: new PassThrough(), exited, kill: () => exit(null) };
  };
  return {
    spawn,
    sent,
    entries,
    get spawns() {
      return state.spawns;
    },
  };
}

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    spec: {
      agent: "eng-1",
      project: "demo",
      cli: "antigravity",
      runner: "server",
      cwd: "/tmp/wt",
      repoDir: "/tmp/repo",
      configHome: "/tmp/home",
      boardDir: "/tmp/board",
    },
    session: "pending-1",
    newSession: true,
    prompt: "Do the thing.",
    instructions: "# eng-1\nYou are an engineer.",
    mcp: { url: board.url, token: board.token },
    limits: { timeoutMs: 5_000 },
    statusSchema: turnStatusJsonSchema(),
    ...overrides,
  };
}

const methodsOf = (sent: readonly Params[]): unknown[] =>
  sent.flatMap((message) => (typeof message["method"] === "string" ? [message["method"]] : []));

/** A turn that would complete, once its session opened. */
const completing = (): Script => ({
  initialize: () => INITIALIZED,
  "session/new": () => OPENED,
  "session/resume": () => OPENED,
  "session/prompt": (_, agent) => {
    agent.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: STATUS("done") },
    });
    return ended(USAGE);
  },
});

/** The MCP server the fake agy was given first. */
function firstEntry(entries: readonly McpEntry[]): McpEntry {
  const [entry] = entries;
  if (entry === undefined) {
    throw new Error("agy was given no MCP server");
  }
  return entry;
}

/** How many handshakes the board has heard. */
const handshakes = (): number => board.requests.filter((each) => each.rpc === "initialize").length;

const prompts = (sent: readonly Params[]): unknown[] =>
  sent.flatMap((message) =>
    message["method"] === "session/prompt" ? [promptTextOf(paramsOf(message["params"]))] : [],
  );

describe("AntigravityBackend", () => {
  it("starts agy acp with a session per process, no permission prompts, and no telemetry", async () => {
    const args: string[][] = [];
    const envs: Record<string, string | undefined>[] = [];
    const fake = fakeAgy({
      initialize: () => INITIALIZED,
      "session/new": () => OPENED,
      "session/prompt": (_, agent) => {
        agent.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: STATUS("done") },
        });
        return ended(USAGE);
      },
    });
    const spawn: SpawnAgy = (given, options) => {
      args.push([...given]);
      envs.push(options.env);
      return fake.spawn(given, options);
    };
    const result = await new AntigravityBackend({ spawn, geminiDir: "/srv/agy" }).runTurn(
      request(),
    );
    expect(result.exitReason).toBe("completed");
    expect(args).toEqual([
      [
        "acp",
        "--process-per-session",
        "--dangerously-skip-permissions",
        "--disable-telemetry",
        "--gemini-dir",
        "/srv/agy",
      ],
    ]);
    // The token is no argument; it travels in the agent's variable, and the relay sends it to the board.
    expect(args.flat().join(" ")).not.toContain("stl_turn");
    expect(envs[0]).toMatchObject({
      STELLARIS_AGENT_TOKEN: "stl_turn",
      HUSKY: "0",
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    });
    expect(envs[0]).not.toHaveProperty("STELLARIS_RUNNER_TOKEN");
  });

  it("refuses an agy that offers no system prompt append, before opening a session", async () => {
    const fake = fakeAgy({
      initialize: () => ({ result: { protocolVersion: 1, agentCapabilities: {} } }),
    });
    await expect(new AntigravityBackend({ spawn: fake.spawn }).runTurn(request())).rejects.toThrow(
      "agy acp offers no system prompt append for the instructions",
    );
    expect(methodsOf(fake.sent)).toEqual(["initialize"]);
  });

  describe("resume", () => {
    const failing: Answer = {
      error: {
        code: -32603,
        message: `Failed to read session ${SESSION}; retry, or load it with session/load`,
      },
    };

    it("fails as lost when the session list doesn't name the session, and never loads one", async () => {
      const fake = fakeAgy({
        initialize: () => INITIALIZED,
        "session/resume": () => failing,
        "session/list": () => ({
          result: { sessions: [{ sessionId: "another", cwd: "/tmp/wt" }] },
        }),
      });
      const failure = await new AntigravityBackend({ spawn: fake.spawn })
        .runTurn(request({ session: SESSION, newSession: false }))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ResumeError);
      expect(failure).toMatchObject({
        failure: "lost",
        message: expect.stringContaining("Failed to read session"),
      });
      expect(methodsOf(fake.sent)).toEqual(["initialize", "session/resume", "session/list"]);
    });

    it("reads every page of the list before calling a session lost", async () => {
      const fake = fakeAgy({
        initialize: () => INITIALIZED,
        "session/resume": () => failing,
        "session/list": (params) =>
          params["cursor"] === undefined
            ? { result: { sessions: [{ sessionId: "another", cwd: "/tmp/wt" }], nextCursor: "2" } }
            : { result: { sessions: [{ sessionId: SESSION, cwd: "/tmp/wt" }] } },
      });
      const failure = await new AntigravityBackend({ spawn: fake.spawn })
        .runTurn(request({ session: SESSION, newSession: false }))
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ failure: "retry" });
      expect(methodsOf(fake.sent)).toEqual([
        "initialize",
        "session/resume",
        "session/list",
        "session/list",
      ]);
    });

    it("fails as retry when the list names the session, or the list fails", async () => {
      for (const list of [
        (): Answer => ({ result: { sessions: [{ sessionId: SESSION, cwd: "/tmp/wt" }] } }),
        (): Answer => ({ error: { code: -32603, message: "store busy" } }),
      ]) {
        const fake = fakeAgy({
          initialize: () => INITIALIZED,
          "session/resume": () => failing,
          "session/list": list,
        });
        const failure = await new AntigravityBackend({ spawn: fake.spawn })
          .runTurn(request({ session: SESSION, newSession: false }))
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ResumeError);
        expect(failure).toMatchObject({ failure: "retry" });
        expect(methodsOf(fake.sent)).not.toContain("session/load");
        expect(methodsOf(fake.sent)).not.toContain("session/new");
      }
    });

    it("fails as retry when agy ends during the resume", async () => {
      const fake = fakeAgy({
        initialize: () => INITIALIZED,
        "session/resume": (_, agent) => {
          agent.exit(1);
          return new Promise(() => undefined);
        },
      });
      const failure = await new AntigravityBackend({ spawn: fake.spawn })
        .runTurn(request({ session: SESSION, newSession: false }))
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ failure: "retry" });
    });
  });

  it("asks for the status once more, and fails a turn whose answer still lacks it", async () => {
    let asked = 0;
    const fake = fakeAgy({
      initialize: () => INITIALIZED,
      "session/new": () => OPENED,
      "session/prompt": (_, agent) => {
        asked += 1;
        agent.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `no status ${asked}` },
        });
        return ended(USAGE);
      },
    });
    const result = await new AntigravityBackend({ spawn: fake.spawn }).runTurn(request());
    expect(prompts(fake.sent)).toEqual([
      "Do the thing.",
      expect.stringContaining("Reply with only the status object"),
    ]);
    expect(result.exitReason).toBe("completed");
    expect(result.status).toBeNull();
    expect(result.error).toBe("the turn ended without a parsable status object");
    expect(result.usage).toEqual({
      inputTokens: 1_200,
      outputTokens: 120,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
  });

  it("reads a warning the model's later text followed as no failure", async () => {
    const fake = fakeAgy({
      initialize: () => INITIALIZED,
      "session/new": () => OPENED,
      "session/prompt": (_, agent) => {
        agent.update({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "\n⚠ There was a network issue connecting to the server, please try again.\n",
          },
        });
        agent.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: STATUS("recovered") },
        });
        return ended(USAGE);
      },
    });
    const result = await new AntigravityBackend({ spawn: fake.spawn }).runTurn(request());
    expect(result.exitReason).toBe("completed");
    expect(result.status?.summary).toBe("recovered");
    expect(prompts(fake.sent)).toHaveLength(1);
  });

  it("reads agy's words for each failure the matrix measured", () => {
    const transient = [
      "agent executor error: generating and executing: Error 429, Message: x, Status: RESOURCE_EXHAUSTED, Details: []",
      "agent executor error: generating and executing: Error 503, Message: x, Status: UNAVAILABLE, Details: []",
      "agent executor error: generating and executing: Error 500, Message: x, Status: INTERNAL, Details: []",
      'agent executor error: generating and executing: iterateResponseStream: error unmarshalling data data: {"candidates":[{"content":{"role":"model. error: unexpected end of JSON input',
      "There was a network issue connecting to the server, please try again.",
    ];
    const lasting = [
      "agent executor error: generating and executing: Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT, Details: []",
      "agent executor error: generating and executing: Error 401, Message: x, Status: UNAUTHENTICATED, Details: []",
      "agent executor error: generating and executing: Error 403, Message: x, Status: PERMISSION_DENIED, Details: []",
    ];
    expect(transient.map((words) => isTransient(said(words) ?? ""))).toEqual(
      transient.map(() => true),
    );
    expect(lasting.map((words) => isTransient(said(words) ?? ""))).toEqual(
      lasting.map(() => false),
    );
    // The model's own text, a warning sign within it included, is no warning of agy's.
    expect(warningOf("⚠ check the build\n")).toBeUndefined();
    expect(warningOf("Done.\n⚠ one note\n")).toBeUndefined();
  });

  it("fails a prompt agy refuses, as a sign-in it lacks, never as transient", async () => {
    const fake = fakeAgy({
      initialize: () => INITIALIZED,
      "session/new": () => OPENED,
      "session/prompt": () => ({ error: { code: -32000, message: "Authentication required" } }),
    });
    const result = await new AntigravityBackend({ spawn: fake.spawn }).runTurn(request());
    expect(result.exitReason).toBe("error");
    expect(result.error).toBe("Authentication required");
    expect(result.transient).toBeUndefined();
    expect(prompts(fake.sent)).toHaveLength(1);
  });

  /**
   * The service's sentences for a refusal of the plan's quota, as two citizens' turns on one login
   * failed with them on 2026-11-26, one for each of Antigravity's pools.
   */
  describe("a refusal of the plan's quota", () => {
    // When those turns were refused.
    const AT = new Date("2026-11-26T15:50:19.000Z");
    const THIRD_PARTY_AT = new Date("2026-11-26T14:42:52.000Z");
    const INDIVIDUAL =
      "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h42m21s.";
    const THIRD_PARTY =
      "Third-party quota reached. Please switch to Gemini models or upgrade your subscription to increase your limits. Resets in 3h49m54s.";

    /** A turn agy ends with `words` as its warning, on a clock stopped at `at`. */
    async function refusedWith(words: string, at: Date = AT) {
      const fake = fakeAgy({
        initialize: () => INITIALIZED,
        "session/new": () => OPENED,
        "session/prompt": (_, agent) => {
          agent.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `\n\u26a0 ${words}\n` },
          });
          return ended();
        },
      });
      return new AntigravityBackend({ spawn: fake.spawn, now: () => at }).runTurn(request());
    }

    it("limits the pool each sentence names until its countdown ends, as the plan's limit, never transient", async () => {
      for (const [words, pool, at, until] of [
        [INDIVIDUAL, "gemini", AT, "2026-11-26T17:32:40.000Z"],
        [THIRD_PARTY, "3p", THIRD_PARTY_AT, "2026-11-26T18:32:46.000Z"],
      ] as const) {
        const result = await refusedWith(words, at);
        expect(result.exitReason).toBe("error");
        expect(result.error).toBe(`usage limit reached: ${words}`);
        expect(result.transient).toBeUndefined();
        expect(result.quota).toEqual({
          observedAt: at.toISOString(),
          source: "turn",
          status: "warning",
          limitedUntil: null,
          limitedBy: null,
          plan: null,
          windows: [],
          credits: null,
          extraUsage: null,
          pools: [
            {
              key: pool,
              limited: true,
              limitedUntil: until,
              limitedBy: null,
              observedAt: at.toISOString(),
            },
          ],
        });
      }
    });

    it("limits the pool with no reset when its countdown does not read, for the half-hour hold", async () => {
      const result = await refusedWith(
        "Individual quota reached. Please upgrade your subscription to increase your limits. Resets soon.",
      );
      expect(result.error).toMatch(/^usage limit reached: Individual quota reached\./);
      expect(result.quota?.pools).toMatchObject([
        { key: "gemini", limited: true, limitedUntil: null },
      ]);
    });

    it("limits the whole login for a pool it does not know, and reads days in a countdown", async () => {
      const result = await refusedWith("Team quota reached. Resets in 2d3h.");
      expect(result.quota).toMatchObject({
        status: "limited",
        limitedUntil: "2026-11-28T18:50:19.000Z",
      });
      expect(result.quota?.pools).toBeUndefined();
      expect(result.transient).toBeUndefined();
    });

    it("reads the sentence wherever agy puts it: in its executor's 429, or as its answer to the prompt", async () => {
      const wrapped = await refusedWith(
        `agent executor error: generating and executing: Error 429, Message: ${THIRD_PARTY}, Status: RESOURCE_EXHAUSTED, Details: []`,
        THIRD_PARTY_AT,
      );
      expect(wrapped.transient).toBeUndefined();
      expect(wrapped.quota?.pools).toMatchObject([
        { key: "3p", limitedUntil: "2026-11-26T18:32:46.000Z" },
      ]);
      const fake = fakeAgy({
        initialize: () => INITIALIZED,
        "session/new": () => OPENED,
        "session/prompt": () => ({ error: { code: -32000, message: INDIVIDUAL } }),
      });
      const answered = await new AntigravityBackend({ spawn: fake.spawn, now: () => AT }).runTurn(
        request(),
      );
      expect(answered.error).toBe(`usage limit reached: ${INDIVIDUAL}`);
      expect(answered.quota?.pools).toMatchObject([
        { key: "gemini", limitedUntil: "2026-11-26T17:32:40.000Z" },
      ]);
    });

    it("reads no other failure as a refusal of the quota", () => {
      expect(
        quotaRefusalOf("There was a network issue connecting to the server, please try again.", AT),
      ).toBeUndefined();
      expect(
        quotaRefusalOf(
          "agent executor error: generating and executing: Error 429, Message: stub refusal 429, Status: RESOURCE_EXHAUSTED, Details: []",
          AT,
        ),
      ).toBeUndefined();
    });
  });

  it("ends a turn whose agy exits mid-prompt with its last words", async () => {
    const fake = fakeAgy({
      initialize: () => INITIALIZED,
      "session/new": () => OPENED,
      "session/prompt": (_, agent) => {
        agent.exit(2);
        return new Promise(() => undefined);
      },
    });
    const result = await new AntigravityBackend({ spawn: fake.spawn }).runTurn(request());
    expect(result.exitReason).toBe("error");
    expect(result.error).toContain("agy acp exited");
  });

  it("allows a permission agy asks for once, never always", async () => {
    const fake = fakeAgy({
      initialize: () => INITIALIZED,
      "session/new": () => OPENED,
      "session/prompt": async (_, agent) => {
        agent.write({
          jsonrpc: "2.0",
          id: 90,
          method: "session/request_permission",
          params: {
            sessionId: SESSION,
            toolCall: { toolCallId: "t1" },
            options: [
              { optionId: "always", name: "Always", kind: "allow_always" },
              { optionId: "once", name: "Once", kind: "allow_once" },
            ],
          },
        });
        await vi.waitFor(() =>
          expect(fake.sent.some((message) => message["id"] === 90)).toBe(true),
        );
        agent.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: STATUS("ok") },
        });
        return ended(USAGE);
      },
    });
    await new AntigravityBackend({ spawn: fake.spawn }).runTurn(request());
    expect(fake.sent.find((message) => message["id"] === 90)).toEqual({
      jsonrpc: "2.0",
      id: 90,
      result: { outcome: { outcome: "selected", optionId: "once" } },
    });
  });

  it("steers with a second prompt, which agy takes by ending the first", async () => {
    const first = Promise.withResolvers<Answer>();
    const fake = fakeAgy({
      initialize: () => INITIALIZED,
      "session/new": () => OPENED,
      "session/prompt": (params, agent) => {
        const text = promptTextOf(params);
        if (text === "Do the thing.") {
          return first.promise;
        }
        // As 1.5.15 does: the first prompt ends with no usage, and this one carries both requests'.
        first.resolve(ended());
        agent.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: STATUS("steered") },
        });
        return ended({ ...USAGE, inputTokens: 1_200 });
      },
    });
    const control = new TurnControl();
    const events: AgentEvent[] = [];
    const running = new AntigravityBackend({ spawn: fake.spawn }).runTurn(
      request(),
      (event) => events.push(event),
      control,
    );
    await vi.waitFor(() => expect(prompts(fake.sent)).toHaveLength(1));
    expect(await control.steer({ id: "steer-1", text: "end your post with PINEAPPLE" })).toBe(true);
    const result = await running;
    expect(prompts(fake.sent)).toEqual(["Do the thing.", "end your post with PINEAPPLE"]);
    expect(events.filter((event) => event.type === "steered")).toEqual([
      { type: "steered", steer: "steer-1" },
    ]);
    expect(result.exitReason).toBe("completed");
    expect(result.status?.summary).toBe("steered");
    expect(result.usage.inputTokens).toBe(1_200);
    // Once the turn has ended, a steer waits for the next.
    expect(await control.steer({ id: "steer-2", text: "late" })).toBe(false);
  });

  it("stops with session/cancel, which agy answers as cancelled", async () => {
    const prompt = Promise.withResolvers<Answer>();
    const fake = fakeAgy({
      initialize: () => INITIALIZED,
      "session/new": () => OPENED,
      "session/prompt": () => prompt.promise,
      "session/cancel": () => {
        prompt.resolve({ result: { stopReason: "cancelled" } });
        return { result: null };
      },
    });
    const control = new TurnControl();
    const running = new AntigravityBackend({ spawn: fake.spawn }).runTurn(
      request(),
      undefined,
      control,
    );
    await vi.waitFor(() => expect(prompts(fake.sent)).toHaveLength(1));
    control.stop();
    const result = await running;
    expect(methodsOf(fake.sent)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
      "session/cancel",
    ]);
    expect(result.exitReason).toBe("stopped");
    expect(result.error).toBeUndefined();
  });

  it("cancels a turn at its time limit, and ends it as a timeout with no status asked", async () => {
    const prompt = Promise.withResolvers<Answer>();
    const fake = fakeAgy({
      initialize: () => INITIALIZED,
      "session/new": () => OPENED,
      "session/prompt": () => prompt.promise,
      "session/cancel": () => {
        prompt.resolve({ result: { stopReason: "cancelled" } });
        return { result: null };
      },
    });
    const result = await new AntigravityBackend({ spawn: fake.spawn }).runTurn(
      request({ limits: { timeoutMs: 50 } }),
    );
    expect(methodsOf(fake.sent)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
      "session/cancel",
    ]);
    expect(result.exitReason).toBe("timeout");
    expect(result.error).toBe("turn exceeded 50 ms");
    expect(result.status).toBeNull();
  });

  it("keeps a resident session's process and session across turns, each counting its own", async () => {
    const first = Promise.withResolvers<Answer>();
    let asked = 0;
    const fake = fakeAgy({
      initialize: () => INITIALIZED,
      "session/new": () => OPENED,
      "session/prompt": (_, agent) => {
        asked += 1;
        agent.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: STATUS(`turn ${asked}`) },
        });
        return asked === 1 ? first.promise : ended({ ...USAGE, inputTokens: 700 });
      },
    });
    const start = request();
    const session = await new AntigravityBackend({ spawn: fake.spawn }).startResident(
      start.spec,
      start,
    );
    expect(session.session).toBe(SESSION);
    const running = session.runTurn("first");
    await vi.waitFor(() => expect(prompts(fake.sent)).toHaveLength(1));
    // One turn at a time on a warm process.
    await expect(session.runTurn("overlap")).rejects.toThrow(
      "a turn is already running on this resident session",
    );
    first.resolve(ended(USAGE));
    const one = await running;
    const two = await session.runTurn("second");
    expect([one.status?.summary, two.status?.summary]).toEqual(["turn 1", "turn 2"]);
    expect([one.usage.inputTokens, two.usage.inputTokens]).toEqual([600, 700]);
    expect([one.session, two.session]).toEqual([SESSION, SESSION]);
    expect(fake.spawns).toBe(1);
    expect(methodsOf(fake.sent).filter((method) => method === "session/new")).toHaveLength(1);
    expect(prompts(fake.sent)).toEqual(["first", "second"]);
    await session.close();
    await expect(session.runTurn("after")).rejects.toThrow("the resident session has ended");
  });

  describe("the board's relay", () => {
    it("fails the turn as transient, before agy opens a session, when the board is out of reach or refuses the token", async () => {
      onTestFinished(() => {
        board.mode = {};
      });
      // Each case's board, and what the turn asks for.
      const cases: [string, BoardMode, Partial<TurnRequest>][] = [
        ["refused", {}, { mcp: { url: await closedUrl(), token: board.token } }],
        ["401", { status: 401 }, {}],
        ["reset", { reset: true }, {}],
        ["stalled", { stall: true }, {}],
        ["reset, resuming", { reset: true }, { session: SESSION, newSession: false }],
      ];
      const outcomes: unknown[] = [];
      for (const [name, mode, overrides] of cases) {
        const fake = fakeAgy(completing());
        board.mode = mode;
        const failure = await new AntigravityBackend({ spawn: fake.spawn, handshakeLimitMs: 100 })
          .runTurn(request(overrides))
          .then(
            (result) => result,
            (error: unknown) => error,
          );
        board.mode = {};
        // agy started, and opened no session: no model call.
        outcomes.push([
          name,
          failure instanceof TransientError,
          failure instanceof Error ? failure.message : failure,
          methodsOf(fake.sent),
        ]);
      }
      const failed = expect.stringMatching(
        /^the board's MCP handshake failed before agy opened the session, on each of 2 tries: /,
      );
      expect(outcomes).toEqual(cases.map(([name]) => [name, true, failed, ["initialize"]]));
    });

    it("gives agy the relay's address and secret, never the board's address or the turn's token", async () => {
      const fake = fakeAgy(completing());
      const result = await new AntigravityBackend({ spawn: fake.spawn }).runTurn(request());
      expect(result.exitReason).toBe("completed");
      const opened = paramsOf(
        paramsOf(fake.sent.find((message) => message["method"] === "session/new"))["params"],
      );
      expect(opened["mcpServers"]).toEqual([
        {
          type: "http",
          name: "board",
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
          headers: [{ name: "Authorization", value: expect.stringMatching(/^Bearer [\w-]{43}$/) }],
        },
      ]);
      expect(firstEntry(fake.entries).url).not.toBe(board.url);
      const everything = JSON.stringify(fake.sent);
      expect(everything).not.toContain(board.token);
      expect(everything).not.toContain(board.url);
    });

    it("refuses a request to the relay without its secret, which never reaches the board", async () => {
      const answers: unknown[] = [];
      let reached = 0;
      const fake = fakeAgy({
        ...completing(),
        "session/prompt": async (_, agent) => {
          const entry = firstEntry(fake.entries);
          const before = board.requests.length;
          for (const authorization of [undefined, `Bearer ${board.token}`]) {
            answers.push((await callAsAgy({ ...entry, authorization }, "post_message", {})).status);
          }
          reached = board.requests.length - before;
          answers.push((await callAsAgy(entry, "post_message", { body: "hi" })).status);
          agent.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: STATUS("done") },
          });
          return ended(USAGE);
        },
      });
      const result = await new AntigravityBackend({ spawn: fake.spawn }).runTurn(request());
      expect(result.exitReason).toBe("completed");
      expect(answers).toEqual([401, 401, 200]);
      expect(reached).toBe(0);
      expect(board.requests.at(-1)).toMatchObject({ rpc: "tools/call", authorized: true });
    });

    it("keeps one relay for a warm session's turns, and closes it with the session", async () => {
      const calls: number[] = [];
      const fake = fakeAgy({
        ...completing(),
        "session/prompt": async (params, agent) => {
          const entry = firstEntry(fake.entries);
          const body = String(promptTextOf(params));
          calls.push((await callAsAgy(entry, "post_message", { body })).status);
          agent.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: STATUS("done") },
          });
          return ended(USAGE);
        },
      });
      const before = handshakes();
      const start = request();
      const session = await new AntigravityBackend({ spawn: fake.spawn }).startResident(
        start.spec,
        start,
      );
      await session.runTurn("first");
      await session.runTurn("second");
      expect(calls).toEqual([200, 200]);
      expect(fake.entries).toHaveLength(1);
      expect(handshakes() - before).toBe(1);
      const entry = firstEntry(fake.entries);
      await session.close();
      await expect(callAsAgy(entry, "post_message", {})).rejects.toThrow("fetch failed");
    });

    it("fails a turn whose agy opened the session without listing the board's tools", async () => {
      const fake = fakeAgy(completing(), { preload: false });
      const failure = await new AntigravityBackend({ spawn: fake.spawn }).runTurn(request()).then(
        (result) => result,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(TransientError);
      expect(failure).toMatchObject({
        message: "agy opened the session without listing the board's tools from the relay",
      });
      expect(methodsOf(fake.sent)).toEqual(["initialize", "session/new"]);
    });
  });
});
