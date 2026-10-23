import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  ResumeError,
  TurnControl,
  type AgentSpec,
  type ResidentStart,
  type TurnRequest,
} from "@stellaris/runner-core";
import type { AgentEvent } from "@stellaris/shared";
import { describe, expect, it, vi } from "vitest";
import { isTransient, type AppServerProcess, type SpawnAppServer } from "./app-server.js";
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
};

const GIT_IDENTITY = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

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
  /** One model request finished, which the server reports with the thread's new totals. */
  request(): void;
  complete(status: string, error?: string): void;
  error(message: string, willRetry: boolean): void;
  /**
   * The thread's totals as they stand, for this turn with no request finished, as Codex sends them
   * when a refusal carries rate limits or a compaction starts.
   */
  report(): void;
  /** The turn fails with no further request finished: the totals, then the error and the end. */
  refuse(error: Record<string, unknown>): void;
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
  turn.request();
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
    /**
     * What the server says to resuming a thread it does not know, `no rollout found` unless told,
     * or `exit` to end the process instead, as a server dying at start does.
     */
    refuseResume?: string;
    /** Ends the process at the handshake, before anything is resumed. */
    dieAtStart?: boolean;
    /**
     * Sends no totals on resuming, as codex-cli 0.162.1 does for a `legacy` thread resumed without
     * its turns, and as a live 0.158.0 did once for a `paginated` one.
     */
    noReplay?: boolean;
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
    // The thread's totals, where the input includes the cached input as the server counts it.
    let total = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    const usage = (turnId: string, last: typeof total): void => {
      send({
        method: "thread/tokenUsage/updated",
        params: { threadId, turnId, tokenUsage: { total, last } },
      });
    };
    const modelRequest = (turnId: string): void => {
      const last = { inputTokens: 400, cachedInputTokens: 100, outputTokens: 40 };
      total = {
        inputTokens: total.inputTokens + last.inputTokens,
        cachedInputTokens: total.cachedInputTokens + last.cachedInputTokens,
        outputTokens: total.outputTokens + last.outputTokens,
      };
      usage(turnId, last);
    };
    const complete = (turnId: string, status: string, error?: string): void => {
      running = null;
      modelRequest(turnId);
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
          if (script.dieAtStart === true) {
            exit(1);
            return;
          }
          send({ id: message.id, result: { userAgent: "codex-fake" } });
          return;
        case "thread/start":
          send({ id: message.id, result: { thread: { id: threadId }, model: "gpt-5" } });
          return;
        case "thread/resume": {
          const id = String(message.params?.["threadId"]);
          if (!(script.known ?? []).includes(id)) {
            if (script.refuseResume === "exit") {
              exit(1);
              return;
            }
            send({
              id: message.id,
              error: {
                code: -32600,
                message: script.refuseResume ?? `no rollout found for thread id ${id}`,
              },
            });
            return;
          }
          send({ id: message.id, result: { thread: { id }, model: "gpt-5" } });
          total = { inputTokens: 5_000, cachedInputTokens: 4_000, outputTokens: 500 };
          if (script.noReplay === true) {
            return;
          }
          // A resumed thread reports where it stood, about the turn it last ran.
          usage("turn-0", { inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50 });
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
                        supportedReasoningEfforts: [
                          { reasoningEffort: "low", description: "Fast." },
                          { reasoningEffort: "xhigh", description: "Thorough." },
                          { reasoningEffort: "Not One", description: "Skipped." },
                        ],
                        defaultReasoningEffort: "xhigh",
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
          send({
            method: "turn/started",
            params: { threadId, turn: { id: turnId, items: [], status: "inProgress" } },
          });
          context = {
            turnId,
            turns,
            item: (method, item) => send({ method, params: { threadId, turnId, item } }),
            request: () => modelRequest(turnId),
            complete: (status, error) => complete(turnId, status, error),
            error: (said, willRetry) =>
              send({
                method: "error",
                params: { threadId, turnId, willRetry, error: { message: said } },
              }),
            report: () =>
              usage(turnId, { inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50 }),
            refuse: (error) => {
              running = null;
              usage(turnId, { inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50 });
              send({ method: "error", params: { threadId, turnId, willRetry: false, error } });
              send({
                method: "turn/completed",
                params: { threadId, turn: { id: turnId, items: [], status: "failed", error } },
              });
            },
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
    // Two requests, each 400 input tokens of which 100 cached, counted apart as Claude Code does.
    expect(result.usage).toEqual({
      inputTokens: 600,
      outputTokens: 80,
      cacheReadTokens: 200,
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

  it("runs each turn at the citizen's effort, and at the model's own without one", async () => {
    const set = fakeAppServer();
    await new CodexBackend({ spawn: set.spawn }).runTurn(
      request({ spec: { ...spec, effort: "xhigh" } }),
    );
    expect(paramsOf(set.received, "turn/start")?.["effort"]).toBe("xhigh");
    const unset = fakeAppServer();
    await new CodexBackend({ spawn: unset.spawn }).runTurn(request());
    expect(paramsOf(unset.received, "turn/start")).not.toHaveProperty("effort");
  });

  it("hands the server the board endpoint and the token", async () => {
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
    expect(paramsOf(fake.received, "thread/start")).toMatchObject({ model: "gpt-5.3-codex" });
  });

  it("gives the server the runner's environment with husky off and no git identity, cold or warm", async () => {
    // Whatever identity the test process inherited is the runner's own, which would pass through.
    for (const name of GIT_IDENTITY) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv("STELLARIS_TEST_RUNNER_ENV", "kept");
    // husky's install would point the clone's hooks away from the runner's guard.
    vi.stubEnv("HUSKY", "1");
    try {
      const cold = fakeAppServer();
      await new CodexBackend({ spawn: cold.spawn, env: { EXTRA: "set", HUSKY: "1" } }).runTurn(
        request(),
      );
      const warm = fakeAppServer();
      const session = await new CodexBackend({
        spawn: warm.spawn,
        env: { EXTRA: "set", HUSKY: "1" },
      }).startResident(spec, start);
      await session.runTurn("hello");
      await session.close();
      for (const { env } of [cold.spawned(), warm.spawned()]) {
        expect(env).toMatchObject({
          STELLARIS_TEST_RUNNER_ENV: "kept",
          EXTRA: "set",
          HUSKY: "0",
          STELLARIS_AGENT_TOKEN: "stl_turn",
        });
        for (const name of GIT_IDENTITY) {
          expect(env).not.toHaveProperty(name);
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resumes a known thread with its instructions, counting none of its earlier turns", async () => {
    const fake = fakeAppServer({ known: ["thread-3"] });
    const backend = new CodexBackend({ spawn: fake.spawn });
    const resumed = await backend.runTurn(request({ session: "thread-3", newSession: false }));
    expect(resumed.session).toBe("thread-3");
    // The thread's earlier turns, which it reports on resuming, are not this turn's.
    expect(resumed.usage).toEqual({
      inputTokens: 600,
      outputTokens: 80,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
    });
    expect(paramsOf(fake.received, "thread/resume")).toMatchObject({
      threadId: "thread-3",
      excludeTurns: true,
      developerInstructions: start.instructions,
    });
    expect(fake.received.some((m) => m.method === "thread/start")).toBe(false);
  });

  it("counts only a resumed turn's own requests when the thread's totals never came", async () => {
    const fake = fakeAppServer({ known: ["thread-3"], noReplay: true });
    const backend = new CodexBackend({ spawn: fake.spawn });
    const resumed = await backend.runTurn(request({ session: "thread-3", newSession: false }));
    expect(resumed.exitReason).toBe("completed");
    // As when the thread reports its totals on resuming: two requests, none of the earlier turns.
    expect(resumed.usage).toEqual({
      inputTokens: 600,
      outputTokens: 80,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
    });
    expect(fake.received.filter((m) => m.method === "thread/resume")).toHaveLength(1);
  });

  it("counts a request whose only item is a command still running when a refusal follows", async () => {
    // A command that outlives its yield starts before its request's update and completes later, or
    // never within the turn, as codex-cli 0.158.0 and 0.162.1 ran one against a stub.
    const command = {
      type: "commandExecution",
      id: "c1",
      command: "sleep 20",
      status: "inProgress",
    };
    const overloaded = {
      message: "Selected model is at capacity.",
      codexErrorInfo: "serverOverloaded",
    };
    const refusedAfter = fakeAppServer({
      turn: (turn) => {
        turn.item("item/started", command);
        turn.request();
        turn.refuse(overloaded);
      },
    });
    const refused = await new CodexBackend({ spawn: refusedAfter.spawn }).runTurn(request());
    expect(refused).toMatchObject({ exitReason: "error", transient: true });
    expect(refused.usage).toEqual({
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    });
  });

  it("counts a resumed turn's first request when its only item is a command still running and no totals came", async () => {
    const command = {
      type: "commandExecution",
      id: "c1",
      command: "sleep 6",
      status: "inProgress",
    };
    const noTotals = fakeAppServer({
      known: ["thread-3"],
      noReplay: true,
      turn: (turn) => {
        turn.item("item/started", command);
        turn.request();
        turn.item("item/completed", { type: "agentMessage", id: "a1", text: STATUS("done") });
        turn.complete("completed");
      },
    });
    const resumed = await new CodexBackend({ spawn: noTotals.spawn }).runTurn(
      request({ session: "thread-3", newSession: false }),
    );
    expect(resumed.usage).toEqual({
      inputTokens: 600,
      outputTokens: 80,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
    });
  });

  it("counts no compaction as an answer, since Codex starts it before its own request", async () => {
    // As codex-cli 0.158.0 and 0.162.1 compact before a turn's first request: the compaction starts,
    // the totals come as they stand, it completes, and then the turn's one request.
    const fake = fakeAppServer({
      known: ["thread-3"],
      noReplay: true,
      turn: (turn) => {
        turn.item("item/started", { type: "contextCompaction", id: "cc1" });
        turn.report();
        turn.item("item/completed", { type: "contextCompaction", id: "cc1" });
        turn.item("item/completed", { type: "agentMessage", id: "a1", text: STATUS("done") });
        turn.complete("completed");
      },
    });
    const compacted = await new CodexBackend({ spawn: fake.spawn }).runTurn(
      request({ session: "thread-3", newSession: false }),
    );
    expect(compacted.usage).toEqual({
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    });
  });

  it("counts nothing for a turn the model never answered, whatever the thread's totals say", async () => {
    // Codex moves the totals without an answer when a turn runs out of context, which it fills.
    const fake = fakeAppServer({
      known: ["thread-3"],
      turn: (turn) => {
        turn.request();
        turn.refuse({ message: "Codex ran out of room.", codexErrorInfo: "contextWindowExceeded" });
      },
    });
    const full = await new CodexBackend({ spawn: fake.spawn }).runTurn(
      request({ session: "thread-3", newSession: false }),
    );
    expect(full.exitReason).toBe("error");
    expect(full.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(full.transient).toBeUndefined();
  });

  it("counts nothing for a resumed thread's turn the model service turned away, and says it may pass", async () => {
    const overloaded = {
      message: "Selected model is at capacity. Please try a different model.",
      codexErrorInfo: "serverOverloaded",
    };
    // Without the thread's totals reported on resuming, as on the live 0.158.0, and with them.
    for (const noReplay of [true, false]) {
      const fake = fakeAppServer({
        known: ["thread-3"],
        noReplay,
        turn: (turn) => turn.refuse(overloaded),
      });
      const refused = await new CodexBackend({ spawn: fake.spawn }).runTurn(
        request({ session: "thread-3", newSession: false }),
      );
      expect(refused.exitReason).toBe("error");
      expect(refused.error).toBe(overloaded.message);
      expect(refused.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      expect(refused.transient).toBe(true);
    }

    // Refused at the compaction before the turn's first request, as 0.158.0 and 0.162.1 word it.
    const compacting = {
      message: `Error running remote compact task: ${overloaded.message}`,
      codexErrorInfo: "serverOverloaded",
    };
    const compaction = fakeAppServer({
      known: ["thread-3"],
      turn: (turn) => turn.refuse(compacting),
    });
    const notCompacted = await new CodexBackend({ spawn: compaction.spawn }).runTurn(
      request({ session: "thread-3", newSession: false }),
    );
    expect(notCompacted).toMatchObject({ error: compacting.message, transient: true });
    expect(notCompacted.usage.inputTokens + notCompacted.usage.cacheReadTokens).toBe(0);

    // The plan's usage limit is held off until it resets instead, and other failures are final.
    const limited = fakeAppServer({
      turn: (turn) =>
        turn.refuse({
          message: "You've hit your usage limit.",
          codexErrorInfo: "usageLimitExceeded",
        }),
    });
    const stopped = await new CodexBackend({ spawn: limited.spawn }).runTurn(request());
    expect(stopped.error).toMatch(/^usage limit reached/);
    expect(stopped.transient).toBeUndefined();
    const full = fakeAppServer({
      turn: (turn) =>
        turn.refuse({ message: "Codex ran out of room.", codexErrorInfo: "contextWindowExceeded" }),
    });
    expect(
      (await new CodexBackend({ spawn: full.spawn }).runTurn(request())).transient,
    ).toBeUndefined();
  });

  it("fails a thread it cannot resume before any turn, lost or retry, and starts no other", async () => {
    // What codex-cli 0.162.0 answers: an id with no rollout, which a thread that never ran a turn
    // has too; ids saved before, which are no thread's; and a rollout it cannot read.
    const refusals: Array<[string, string]> = [
      ["thread-0", "no rollout found for thread id thread-0"],
      [
        "unstarted",
        "invalid session id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `u` at 1",
      ],
      [
        "pending-1",
        "invalid session id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `p` at 1",
      ],
      [
        "thread-3",
        "failed to read thread: thread-store internal error: failed to read session metadata /tmp/rollout.jsonl: Permission denied (os error 13)",
      ],
    ];
    for (const [session, said] of refusals) {
      const fake = fakeAppServer({ refuseResume: said });
      await expect(
        new CodexBackend({ spawn: fake.spawn }).runTurn(request({ session, newSession: false })),
      ).rejects.toMatchObject({ name: "ResumeError", failure: "lost", message: said });
      expect(fake.received.map((m) => m.method)).toEqual([
        "initialize",
        "initialized",
        "thread/resume",
      ]);
      expect(fake.killed()).toBe(1);
    }

    // A server that ends during the resume may resume the thread next time; so may a warm one.
    const exiting = fakeAppServer({ refuseResume: "exit" });
    await expect(
      new CodexBackend({ spawn: exiting.spawn }).runTurn(
        request({ session: "thread-3", newSession: false }),
      ),
    ).rejects.toMatchObject({ name: "ResumeError", failure: "retry" });
    expect(exiting.received.some((m) => m.method === "thread/start")).toBe(false);
    const warm = fakeAppServer();
    await expect(
      new CodexBackend({ spawn: warm.spawn }).startResident(spec, {
        ...start,
        session: "thread-0",
        newSession: false,
      }),
    ).rejects.toMatchObject({ name: "ResumeError", failure: "lost" });
    expect(warm.received.some((m) => m.method === "thread/start")).toBe(false);

    // A server that ends before it is asked to resume anything did not fail a resume.
    const dead = fakeAppServer({ dieAtStart: true });
    const ended = new CodexBackend({ spawn: dead.spawn }).runTurn(
      request({ session: "thread-3", newSession: false }),
    );
    await expect(ended).rejects.toThrow("codex app-server exited");
    await expect(ended).rejects.not.toBeInstanceOf(ResumeError);
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
        // An effort the board could not name is left out, and the default is one of those listed.
        efforts: [
          { id: "low", description: "Fast." },
          { id: "xhigh", description: "Thorough." },
        ],
        defaultEffort: "xhigh",
      },
      { id: "gpt-6-luna", name: "GPT-6-Luna", description: "", isDefault: false, efforts: [] },
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
    // The thread's totals keep growing; each turn counts only its own requests.
    expect(second.usage).toEqual(first.usage);
    expect(second.usage.outputTokens).toBe(80);
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

/**
 * The codes codex-cli 0.162.1 ends a turn with. The first five rows are what its app server sent
 * when a stub model service answered so; the rest are from its error enum.
 */
describe("isTransient", () => {
  it.each([
    ["a 503 or a failed stream saying the server is overloaded", "serverOverloaded", true],
    ["a 500 after its stream retries", "internalServerError", true],
    ["a 429 rate limit", { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, true],
    ["the plan's usage limit", "usageLimitExceeded", false],
    ["a rate limit Codex gave up on", "rateLimitExceeded", true],
    ["flex capacity", "flexUnavailable", true],
    ["no connection", { httpConnectionFailed: { httpStatusCode: null } }, true],
    ["a 502 on the stream", { responseStreamConnectionFailed: { httpStatusCode: 502 } }, true],
    ["a dropped stream", { responseStreamDisconnected: {} }, true],
    ["a 401", { httpConnectionFailed: { httpStatusCode: 401 } }, false],
    ["a 400", { responseTooManyFailedAttempts: { httpStatusCode: 400 } }, false],
    ["the context window", "contextWindowExceeded", false],
    ["a policy", "cyberPolicy", false],
    ["a sign-in", "unauthorized", false],
    ["a bad request", "badRequest", false],
    ["anything else", "other", false],
    ["no code", undefined, false],
  ])("%s", (_case, codexErrorInfo, transient) => {
    expect(isTransient({ message: "failed", codexErrorInfo })).toBe(transient);
  });
});
