import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  TurnControl,
  type AgentSpec,
  type ResidentStart,
  type TurnRequest,
} from "@stellaris/runner-core";
import type { AgentEvent } from "@stellaris/shared";
import { describe, expect, it, vi } from "vitest";
import type { AppServerProcess, SpawnAppServer } from "./app-server.js";
import { CodexBackend } from "./backend.js";

const spec: AgentSpec = {
  agent: "eng-1",
  project: "demo",
  cli: "codex",
  runner: "server",
  cwd: "/tmp/wt",
  repoDir: "/tmp/repo",
  configHome: "/tmp/home",
  boardDir: "/tmp/board",
};

const start: ResidentStart = {
  session: "pending-1",
  newSession: true,
  instructions: "# eng-1\nYou are an engineer.",
  mcp: { url: "http://127.0.0.1:4700/mcp", token: "stl_turn" },
  limits: { timeoutMs: 5_000, maxTurns: 10 },
  statusSchema: { type: "object" },
  env: { GIT_AUTHOR_NAME: "eng-1" },
};

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return { ...start, spec, prompt: "Do the thing.", ...overrides };
}

const STATUS = (summary: string): string =>
  JSON.stringify({
    summary,
    claimsHeld: [],
    blockedOn: [],
    needsUserDecision: false,
    memoryUpdated: false,
  });

interface Received {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

interface TurnContext {
  readonly turnId: string;
  readonly turns: number;
  item(method: "item/started" | "item/completed", item: Record<string, unknown>): void;
  complete(status: string, error?: string): void;
  error(message: string, willRetry: boolean): void;
  exit(stderr: string): void;
}

/** A turn as a real server runs it: a command, a board call, the status message, usage, the end. */
function ordinaryTurn(turn: TurnContext): void {
  const command = { type: "commandExecution", id: "c1", command: "ls" };
  turn.item("item/started", { ...command, status: "inProgress" });
  turn.item("item/completed", {
    ...command,
    status: "completed",
    exitCode: 0,
    aggregatedOutput: "README.md\nsrc\n",
  });
  turn.item("item/completed", {
    type: "mcpToolCall",
    id: "m1",
    server: "board",
    tool: "post_message",
    status: "completed",
    arguments: { channel: "general" },
    result: { content: [{ type: "text", text: '{"id":"01M"}' }] },
  });
  turn.item("item/completed", {
    type: "agentMessage",
    id: "a1",
    text: STATUS(`answered turn ${turn.turns}`),
  });
  turn.complete("completed");
}

/**
 * A fake `codex app-server`. It answers the handshake, resumes only the threads it knows, and
 * plays each `turn/start` through `turn`; an interrupt ends the running turn as interrupted.
 */
function fakeAppServer(
  script: {
    known?: readonly string[];
    turn?: (turn: TurnContext) => void;
    /** A steer the server accepted for the running turn, as `turn/steer` carried it. */
    steered?: (params: Record<string, unknown>, turn: TurnContext) => void;
    /** Refuses every steer, as the server does for a review or a compaction. */
    refuseSteers?: boolean;
  } = {},
): {
  spawn: SpawnAppServer;
  received: Received[];
  spawned: () => { args: string[]; cwd: string; env: Record<string, string | undefined> };
  killed: () => number;
} {
  const received: Received[] = [];
  let spawned = { args: [] as string[], cwd: "", env: {} as Record<string, string | undefined> };
  let killed = 0;
  const spawn: SpawnAppServer = (args, options) => {
    spawned = { args: [...args], cwd: options.cwd, env: options.env };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const { promise: exited, resolve: exit } = Promise.withResolvers<number | null>();
    const send = (message: unknown): void => {
      stdout.write(`${JSON.stringify(message)}\n`);
    };
    const threadId = "thread-7";
    let turns = 0;
    let running: string | null = null;
    let context: TurnContext | null = null;
    const complete = (turnId: string, status: string, error?: string): void => {
      running = null;
      send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: {
            total: { inputTokens: 900, outputTokens: 90 },
            last: { inputTokens: 400, outputTokens: 40, cachedInputTokens: 100 },
          },
        },
      });
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            items: [],
            status,
            error: error === undefined ? null : { message: error },
          },
        },
      });
    };
    const answer = (message: Received): void => {
      switch (message.method) {
        case "initialize":
          send({ id: message.id, result: { userAgent: "codex-fake" } });
          return;
        case "thread/start":
          send({ id: message.id, result: { thread: { id: threadId }, model: "gpt-5" } });
          return;
        case "thread/resume": {
          const id = String(message.params?.["threadId"]);
          send(
            (script.known ?? []).includes(id)
              ? { id: message.id, result: { thread: { id }, model: "gpt-5" } }
              : { id: message.id, error: { code: -32600, message: `no rollout found for ${id}` } },
          );
          return;
        }
        case "model/list":
          send({
            id: message.id,
            result:
              message.params?.["cursor"] === "page-2"
                ? {
                    data: [{ id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna" }],
                    nextCursor: null,
                  }
                : {
                    data: [
                      {
                        id: "gpt-6-astra",
                        model: "gpt-6-astra",
                        displayName: "GPT-6-Astra",
                        description: "Frontier intelligence.",
                        isDefault: true,
                      },
                      { id: "broken", model: "has space", displayName: "Broken" },
                    ],
                    nextCursor: "page-2",
                  },
          });
          return;
        case "turn/interrupt":
          send({ id: message.id, result: {} });
          if (running !== null) complete(running, "interrupted");
          return;
        case "turn/steer":
          if (running === null || message.params?.["expectedTurnId"] !== running) {
            send({ id: message.id, error: { code: -32600, message: "no active turn to steer" } });
            return;
          }
          if (script.refuseSteers === true) {
            send({
              id: message.id,
              error: { code: -32600, message: "active turn is not steerable" },
            });
            return;
          }
          send({ id: message.id, result: { turnId: running } });
          if (context !== null && message.params !== undefined) {
            script.steered?.(message.params, context);
          }
          return;
        case "turn/start": {
          turns += 1;
          const turnId = `turn-${turns}`;
          running = turnId;
          send({
            id: message.id,
            result: { turn: { id: turnId, items: [], status: "inProgress" } },
          });
          context = {
            turnId,
            turns,
            item: (method, item) => send({ method, params: { threadId, turnId, item } }),
            complete: (status, error) => complete(turnId, status, error),
            error: (said, willRetry) =>
              send({
                method: "error",
                params: { threadId, turnId, willRetry, error: { message: said } },
              }),
            exit: (said) => {
              stderr.write(`${said}\n`);
              setTimeout(() => exit(1), 5);
            },
          };
          (script.turn ?? ordinaryTurn)(context);
          return;
        }
        default:
          return;
      }
    };
    let buffer = "";
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        // The fake trusts its own client's input.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const message = JSON.parse(buffer.slice(0, newline)) as Received;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        received.push(message);
        answer(message);
      }
    });
    const process: AppServerProcess = {
      stdin,
      stdout,
      stderr,
      exited,
      kill: () => {
        killed += 1;
        exit(null);
      },
    };
    return process;
  };
  return { spawn, received, spawned: () => spawned, killed: () => killed };
}

function paramsOf(received: Received[], method: string): Record<string, unknown> | undefined {
  return received.find((m) => m.method === method)?.params;
}

describe("CodexBackend cold turns", () => {
  it("starts a server, opens a thread, runs one turn, and stops the server", async () => {
    const fake = fakeAppServer();
    const result = await new CodexBackend({ spawn: fake.spawn }).runTurn(request());

    expect(fake.received.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(fake.killed()).toBe(1);
    expect(result.exitReason).toBe("completed");
    expect(result.session).toBe("thread-7");
    expect(result.model).toBe("gpt-5");
    expect(result.status?.summary).toBe("answered turn 1");
    expect(result.usage).toEqual({
      inputTokens: 400,
      outputTokens: 40,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    });
    expect(result.events.map((e) => e.type)).toEqual([
      "turn_started",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "text",
      "turn_completed",
    ]);
    expect(result.events[0]).toMatchObject({ session: "thread-7", model: "gpt-5" });
    expect(result.events.filter((e) => e.type === "tool_call").map((e) => e.name)).toEqual([
      "Bash",
      "mcp__board__post_message",
    ]);
    expect(result.events.flatMap((e) => (e.type === "tool_result" ? [e.output] : []))).toEqual([
      "README.md\nsrc\n",
      '{"id":"01M"}',
    ]);

    expect(paramsOf(fake.received, "thread/start")).toEqual({
      cwd: "/tmp/wt",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: start.instructions,
    });
    const turnStart = paramsOf(fake.received, "turn/start");
    expect(turnStart).toMatchObject({
      threadId: "thread-7",
      cwd: "/tmp/wt",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      outputSchema: { type: "object" },
    });
    // The instructions live on the thread, so the prompt travels alone.
    expect(turnStart?.["input"]).toEqual([
      { type: "text", text: "Do the thing.", text_elements: [] },
    ]);
  });

  it("hands the server the board endpoint, the token, and the git identity", async () => {
    const fake = fakeAppServer();
    await new CodexBackend({ spawn: fake.spawn, model: "gpt-5.3-codex" }).runTurn(request());
    const { args, cwd, env } = fake.spawned();
    expect(args[0]).toBe("app-server");
    expect(args).toContain(`mcp_servers.board.url="http://127.0.0.1:4700/mcp"`);
    expect(args).toContain(`mcp_servers.board.bearer_token_env_var="STELLARIS_AGENT_TOKEN"`);
    expect(args).toContain('mcp_servers.board.default_tools_approval_mode="approve"');
    expect(args).toContain('approval_policy="never"');
    expect(cwd).toBe("/tmp/wt");
    expect(env["STELLARIS_AGENT_TOKEN"]).toBe("stl_turn");
    expect(env["GIT_AUTHOR_NAME"]).toBe("eng-1");
    expect(paramsOf(fake.received, "thread/start")).toMatchObject({ model: "gpt-5.3-codex" });
  });

  it("resumes a known thread and starts a fresh one when the id names none", async () => {
    const fake = fakeAppServer({ known: ["thread-3"] });
    const backend = new CodexBackend({ spawn: fake.spawn });
    const resumed = await backend.runTurn(request({ session: "thread-3", newSession: false }));
    expect(resumed.session).toBe("thread-3");
    expect(paramsOf(fake.received, "thread/resume")).toMatchObject({
      threadId: "thread-3",
      excludeTurns: true,
      developerInstructions: start.instructions,
    });
    expect(fake.received.some((m) => m.method === "thread/start")).toBe(false);

    const lost = fakeAppServer();
    const fresh = await new CodexBackend({ spawn: lost.spawn }).runTurn(
      request({ session: "thread-0", newSession: false }),
    );
    expect(lost.received.map((m) => m.method).slice(2, 4)).toEqual([
      "thread/resume",
      "thread/start",
    ]);
    expect(fresh.exitReason).toBe("completed");
    expect(fresh.session).toBe("thread-7");
  });

  it("reports a web search when it completes, with what it looked for", async () => {
    const fake = fakeAppServer({
      turn: (turn) => {
        turn.item("item/started", { type: "webSearch", id: "w1", query: "" });
        turn.item("item/completed", {
          type: "webSearch",
          id: "w1",
          query: "",
          action: { type: "openPage", url: "https://arxiv.org/abs/1" },
        });
        turn.item("item/completed", {
          type: "webSearch",
          id: "w2",
          query: "",
          action: { type: "search", queries: ["sssp", "apsp"] },
        });
        turn.item("item/completed", { type: "agentMessage", id: "a1", text: STATUS("read") });
        turn.complete("completed");
      },
    });
    const result = await new CodexBackend({ spawn: fake.spawn }).runTurn(request());
    expect(result.events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", name: "WebSearch", input: { url: "https://arxiv.org/abs/1" } },
      { type: "tool_call", name: "WebSearch", input: { query: "sssp · apsp" } },
    ]);
  });

  it("marks failed commands and board calls as failed results", async () => {
    const fake = fakeAppServer({
      turn: (turn) => {
        turn.item("item/completed", {
          type: "commandExecution",
          id: "c1",
          command: "pnpm test",
          status: "failed",
          exitCode: 1,
          aggregatedOutput: `${"x".repeat(5_000)}\n1 test failed`,
        });
        turn.item("item/completed", {
          type: "mcpToolCall",
          id: "m1",
          server: "board",
          tool: "claim_task",
          status: "failed",
          arguments: {},
          error: { message: "held by eng-2" },
        });
        turn.item("item/completed", { type: "fileChange", id: "f1", changes: [] });
        turn.item("item/completed", { type: "agentMessage", id: "a1", text: STATUS("tried") });
        turn.complete("completed");
      },
    });
    const result = await new CodexBackend({ spawn: fake.spawn }).runTurn(request());
    expect(
      result.events.flatMap((e) => (e.type === "tool_result" ? [[e.name, e.ok]] : [])),
    ).toEqual([
      ["Bash", false],
      ["mcp__board__claim_task", false],
      ["Edit", true],
    ]);
    // Long output keeps its end, where the failure is, and the board's refusal is the output.
    const outputs = result.events.flatMap((e) => (e.type === "tool_result" ? [e.output] : []));
    expect(outputs[0]).toMatch(/characters cut …\n[x]*\n1 test failed\n\(exit 1\)$/);
    expect(outputs[0]?.length).toBeLessThan(4_100);
    expect(outputs[1]).toBe("held by eng-2");
    expect(outputs[2]).toBeUndefined();
  });

  it("keeps Codex's sandbox when a runner asks for one, with the clone and the board writable", async () => {
    const fake = fakeAppServer();
    await new CodexBackend({ spawn: fake.spawn, sandbox: "workspace-write" }).runTurn(
      request({ spec: { ...spec, repoDir: "/tmp/home" } }),
    );
    expect(fake.spawned().args).toContain('sandbox_mode="workspace-write"');
    expect(paramsOf(fake.received, "thread/start")).toMatchObject({ sandbox: "workspace-write" });
    expect(paramsOf(fake.received, "turn/start")?.["sandboxPolicy"]).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/tmp/home", "/tmp/board"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("interrupts a turn that runs past its limit", async () => {
    const fake = fakeAppServer({ turn: () => undefined });
    const result = await new CodexBackend({ spawn: fake.spawn }).runTurn(
      request({ limits: { timeoutMs: 20 } }),
    );
    expect(fake.received.map((m) => m.method)).toContain("turn/interrupt");
    expect(result.exitReason).toBe("timeout");
    expect(result.error).toBe("turn exceeded 20 ms");
    expect(fake.killed()).toBe(1);
  });

  it("reports a failed turn with the server's reason", async () => {
    const fake = fakeAppServer({ turn: (turn) => turn.complete("failed", "model refused") });
    const result = await new CodexBackend({ spawn: fake.spawn }).runTurn(request());
    expect(result.exitReason).toBe("error");
    expect(result.error).toBe("model refused");
    expect(result.events.at(-1)).toMatchObject({ type: "turn_completed", exitReason: "error" });
  });

  it("lets a turn complete after an error Codex retries, and fails it on one it does not", async () => {
    const retried = fakeAppServer({
      turn: (turn) => {
        turn.error("stream disconnected before completion", true);
        turn.item("item/completed", { type: "agentMessage", id: "a1", text: STATUS("recovered") });
        turn.complete("completed");
      },
    });
    const recovered = await new CodexBackend({ spawn: retried.spawn }).runTurn(request());
    expect(recovered.exitReason).toBe("completed");
    expect(recovered.events.find((e) => e.type === "error")).toEqual({
      type: "error",
      message: "stream disconnected before completion (retrying)",
    });

    const fatal = fakeAppServer({
      turn: (turn) => {
        turn.error("usage limit reached", false);
        turn.complete("failed");
      },
    });
    const failed = await new CodexBackend({ spawn: fatal.spawn }).runTurn(request());
    expect(failed.exitReason).toBe("error");
    expect(failed.error).toBe("usage limit reached");
    expect(failed.events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("ends the turn when the server dies mid-turn instead of waiting forever", async () => {
    const fake = fakeAppServer({ turn: (turn) => turn.exit("thread 'main' panicked") });
    const result = await new CodexBackend({ spawn: fake.spawn }).runTurn(
      request({ limits: { timeoutMs: null } }),
    );
    expect(result.exitReason).toBe("error");
    expect(result.error).toBe("codex app-server exited: thread 'main' panicked");
  });

  it("records what the server wrote, one file per turn", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-codex-rec-"));
    try {
      const fake = fakeAppServer();
      await new CodexBackend({ spawn: fake.spawn, recordDir: dir }).runTurn(request());
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^codex-eng-1-.*\.jsonl$/);
      const lines = (await readFile(path.join(dir, files[0] ?? ""), "utf8")).trim().split("\n");
      expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ method: "turn/completed" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CodexBackend models", () => {
  it("lists the app server's models across pages, skipping names a CLI would not take", async () => {
    const fake = fakeAppServer();
    const models = await new CodexBackend({ spawn: fake.spawn }).listModels();
    expect(models).toEqual([
      {
        id: "gpt-6-astra",
        name: "GPT-6-Astra",
        description: "Frontier intelligence.",
        isDefault: true,
      },
      { id: "gpt-6-luna", name: "GPT-6-Luna", description: "", isDefault: false },
    ]);
    expect(fake.received.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "model/list",
    ]);
    expect(fake.killed()).toBe(1);
  });
});

describe("CodexBackend resident sessions", () => {
  it("keeps one server and thread across turns until closed", async () => {
    const fake = fakeAppServer();
    const session = await new CodexBackend({ spawn: fake.spawn }).startResident(spec, start);
    expect(session.session).toBe("thread-7");

    const first = await session.runTurn("hello");
    const second = await session.runTurn("again");
    expect(first.status?.summary).toBe("answered turn 1");
    expect(second.status?.summary).toBe("answered turn 2");
    expect(fake.received.filter((m) => m.method === "thread/start")).toHaveLength(1);
    expect(fake.killed()).toBe(0);

    await session.close();
    expect(fake.killed()).toBe(1);
    await expect(session.runTurn("late")).rejects.toThrow(/ended/);
  });
});

/** A turn that starts a long command and waits: whatever ends it comes from the test. */
function longCommand(turn: TurnContext): void {
  turn.item("item/started", {
    type: "commandExecution",
    id: "c1",
    command: "make",
    status: "inProgress",
  });
}

describe("steering and stopping a Codex turn", () => {
  const steer = { id: "0f8b2c55-6b1e-4d6a-9f3e-2a7c1d9e4b10", text: "Also add a test." };

  it("sends a steer to the running turn and reports it when it arrives as a user message", async () => {
    const fake = fakeAppServer({
      turn: longCommand,
      steered: (params, turn) => {
        turn.item("item/completed", {
          type: "commandExecution",
          id: "c1",
          command: "make",
          status: "completed",
          exitCode: 0,
        });
        const message = {
          type: "userMessage",
          id: "u2",
          clientId: params["clientUserMessageId"],
          content: [],
        };
        turn.item("item/started", message);
        turn.item("item/completed", message);
        turn.item("item/completed", {
          type: "agentMessage",
          id: "a1",
          text: STATUS("built, with a test"),
        });
        turn.complete("completed");
      },
    });
    const control = new TurnControl();
    const events: AgentEvent[] = [];
    const running = new CodexBackend({ spawn: fake.spawn }).runTurn(
      request(),
      (event) => events.push(event),
      control,
    );
    await vi.waitFor(() => expect(fake.received.some((m) => m.method === "turn/start")).toBe(true));
    await vi.waitFor(async () => expect(await control.steer(steer)).toBe(true));
    const result = await running;

    expect(paramsOf(fake.received, "turn/steer")).toEqual({
      threadId: "thread-7",
      input: [{ type: "text", text: steer.text, text_elements: [] }],
      expectedTurnId: "turn-1",
      clientUserMessageId: steer.id,
    });
    expect(result.exitReason).toBe("completed");
    expect(result.status?.summary).toBe("built, with a test");
    expect(events.filter((event) => event.type === "steered")).toEqual([
      { type: "steered", steer: steer.id },
    ]);
    expect(await control.steer({ ...steer, id: "1f8b2c55-6b1e-4d6a-9f3e-2a7c1d9e4b10" })).toBe(
      false,
    );
  });

  it("reports a steer the app server refuses as not taken", async () => {
    const finishing = Promise.withResolvers<void>();
    const fake = fakeAppServer({
      refuseSteers: true,
      turn: (turn) => {
        longCommand(turn);
        void finishing.promise.then(() => {
          turn.item("item/completed", { type: "agentMessage", id: "a1", text: STATUS("built") });
          turn.complete("completed");
          return undefined;
        });
      },
    });
    const control = new TurnControl();
    const events: AgentEvent[] = [];
    const running = new CodexBackend({ spawn: fake.spawn }).runTurn(
      request(),
      (event) => events.push(event),
      control,
    );
    await vi.waitFor(() => expect(fake.received.some((m) => m.method === "turn/start")).toBe(true));
    // Once the turn is attached, the steer reaches the server, which refuses it.
    await vi.waitFor(async () => {
      expect(await control.steer(steer)).toBe(false);
      expect(fake.received.some((m) => m.method === "turn/steer")).toBe(true);
    });
    finishing.resolve();
    const result = await running;
    expect(result.exitReason).toBe("completed");
    expect(events.some((event) => event.type === "steered")).toBe(false);
  });

  it("stops a running turn with turn/interrupt and reports it stopped", async () => {
    const fake = fakeAppServer({ turn: longCommand });
    const control = new TurnControl();
    const running = new CodexBackend({ spawn: fake.spawn }).runTurn(request(), undefined, control);
    await vi.waitFor(() => expect(fake.received.some((m) => m.method === "turn/start")).toBe(true));
    // Asked before the turn's id is known, the stop waits for it and interrupts then.
    control.stop();
    await vi.waitFor(() =>
      expect(fake.received.some((m) => m.method === "turn/interrupt")).toBe(true),
    );
    const result = await running;
    expect(result.exitReason).toBe("stopped");
    expect(result.error).toBeUndefined();
    expect(result.events.at(-1)).toMatchObject({ type: "turn_completed", exitReason: "stopped" });
  });
});
