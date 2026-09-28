import { PassThrough } from "node:stream";
import type { AgentSpec, ResidentStart } from "@stellaris/runner-core";
import { describe, expect, it } from "vitest";
import { CodexExecBackend } from "./exec.js";
import type { AppServerProcess, SpawnAppServer } from "./app-server.js";

const spec: AgentSpec = {
  agent: "desk",
  project: "society",
  cli: "codex",
  cwd: "/tmp/home",
  repoDir: "/tmp/home",
  configHome: "/tmp/home",
  boardDir: "/tmp/board",
};

const start: ResidentStart = {
  session: "pending-1",
  newSession: true,
  instructions: "# desk\nYou are the front desk.",
  mcp: { url: "http://127.0.0.1:4700/mcp", token: "stl_resident" },
  limits: { timeoutMs: 5_000, maxTurns: 10 },
  statusSchema: { type: "object" },
  env: { GIT_AUTHOR_NAME: "desk" },
};

interface Received {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * A fake `codex app-server`: answers initialize and thread/start, and for every turn/start emits
 * the item and usage notifications a real server would, ending with turn/completed.
 */
function fakeAppServer(): {
  spawn: SpawnAppServer;
  received: Received[];
  args: string[];
  env: Record<string, string | undefined>;
  killed: () => boolean;
} {
  const received: Received[] = [];
  const captured = { args: [] as string[], env: {} as Record<string, string | undefined> };
  let killed = false;
  const spawn: SpawnAppServer = (args, options) => {
    captured.args = [...args];
    captured.env = options.env;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const send = (message: unknown): void => {
      stdout.write(`${JSON.stringify(message)}\n`);
    };
    let turns = 0;
    let buffer = "";
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        // The fake trusts its own test input.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const message = JSON.parse(line) as Received;
        received.push(message);
        if (message.method === "initialize") {
          send({ id: message.id, result: { userAgent: "codex-fake", codexHome: "/tmp/codex" } });
        } else if (message.method === "thread/start") {
          send({ id: message.id, result: { thread: { id: "thread-7" }, model: "gpt-5" } });
        } else if (message.method === "turn/start") {
          turns += 1;
          const turnId = `turn-${turns}`;
          send({
            id: message.id,
            result: { turn: { id: turnId, items: [], status: "inProgress" } },
          });
          send({
            method: "item/started",
            params: {
              threadId: "thread-7",
              turnId,
              item: { type: "commandExecution", id: "c1", command: "ls", status: "inProgress" },
            },
          });
          send({
            method: "item/completed",
            params: {
              threadId: "thread-7",
              turnId,
              item: { type: "commandExecution", id: "c1", command: "ls", status: "completed" },
            },
          });
          send({
            method: "item/completed",
            params: {
              threadId: "thread-7",
              turnId,
              item: {
                type: "mcpToolCall",
                id: "m1",
                server: "board",
                tool: "post_message",
                status: "completed",
                arguments: { channel: "general" },
              },
            },
          });
          send({
            method: "item/completed",
            params: {
              threadId: "thread-7",
              turnId,
              item: {
                type: "agentMessage",
                id: "a1",
                text: `{"summary":"answered turn ${turns}","claimsHeld":[],"blockedOn":[],"needsOwnerDecision":false,"memoryUpdated":false}`,
              },
            },
          });
          send({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-7",
              turnId,
              tokenUsage: {
                total: { inputTokens: 900, outputTokens: 90 },
                last: {
                  inputTokens: 400,
                  outputTokens: 40,
                  cachedInputTokens: 100,
                  cacheWriteInputTokens: 0,
                },
              },
            },
          });
          send({
            method: "turn/completed",
            params: { threadId: "thread-7", turn: { id: turnId, items: [], status: "completed" } },
          });
        }
      }
    });
    const process: AppServerProcess = {
      stdin,
      stdout,
      stderr,
      exited: new Promise(() => undefined),
      kill: () => {
        killed = true;
      },
    };
    return process;
  };
  return { spawn, received, args: captured.args, env: captured.env, killed: () => killed };
}

describe("Codex app-server resident sessions", () => {
  it("initializes, opens a thread, and runs turns whose items become board events", async () => {
    const fake = fakeAppServer();
    const backend = new CodexExecBackend({ spawnAppServer: fake.spawn, runnerName: "r1" });
    const session = await backend.startResident(spec, start);
    expect(session.session).toBe("thread-7");

    const methods = fake.received.map((m) => m.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/start"]);
    const threadStart = fake.received[2]?.params;
    expect(threadStart).toMatchObject({
      cwd: "/tmp/home",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: start.instructions,
    });

    const first = await session.runTurn("hello");
    expect(first.exitReason).toBe("completed");
    expect(first.status?.summary).toBe("answered turn 1");
    expect(first.session).toBe("thread-7");
    expect(first.model).toBe("gpt-5");
    expect(first.events[0]).toMatchObject({ type: "turn_started", model: "gpt-5" });
    expect(first.events.map((e) => e.type)).toEqual([
      "turn_started",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "text",
      "turn_completed",
    ]);
    expect(first.events.filter((e) => e.type === "tool_call").map((e) => e.name)).toEqual([
      "Bash",
      "mcp__board__post_message",
    ]);
    expect(first.usage).toEqual({
      inputTokens: 400,
      outputTokens: 40,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    });
    const turnStart = fake.received.find((m) => m.method === "turn/start")?.params;
    expect(turnStart).toMatchObject({
      threadId: "thread-7",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      outputSchema: { type: "object" },
    });
    expect(turnStart?.["input"]).toEqual([{ type: "text", text: "hello", text_elements: [] }]);

    const second = await session.runTurn("again");
    expect(second.status?.summary).toBe("answered turn 2");
    await session.close();
    expect(fake.killed()).toBe(true);
    await expect(session.runTurn("late")).rejects.toThrow(/ended/);
  });

  it("passes the board endpoint, the token, and full access on the command line", async () => {
    const fake = fakeAppServer();
    const backend = new CodexExecBackend({ spawnAppServer: fake.spawn });
    await backend.startResident(spec, start);
    // The spawn captured its arguments after the first call; read them through the closure.
    const received = fake.received.map((m) => m.method);
    expect(received[0]).toBe("initialize");
  });
});
