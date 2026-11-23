import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { ResumeError, type TurnRequest } from "@stellaris/runner-core";
import { turnStatusJsonSchema, type AgentEvent } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { AntigravityBackend } from "./backend.js";
import type { SpawnAgy } from "./rpc.js";
import { modelsOf } from "./session.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

async function fixtureLines(fixture: string): Promise<string[]> {
  return (await readFile(path.join(fixtures, fixture), "utf8")).trim().split("\n");
}

/** Whether a line agy wrote is its reply to one of the client's requests. */
function isReply(line: string): boolean {
  const message: unknown = JSON.parse(line);
  return (
    typeof message === "object" && message !== null && "id" in message && !("method" in message)
  );
}

/**
 * Replays what a real `agy acp` wrote: each request is answered by the recorded reply after the
 * last one written, with the notifications recorded before it. The client numbers its requests
 * the same way on every run, so the ids line up.
 */
async function replay(
  fixture: string,
): Promise<{ spawn: SpawnAgy; sent: Record<string, unknown>[] }> {
  const lines = await fixtureLines(fixture);
  const sent: Record<string, unknown>[] = [];
  const spawn: SpawnAgy = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const { promise: exited, resolve: exit } = Promise.withResolvers<number | null>();
    let at = 0;
    stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const message: unknown = JSON.parse(line);
        if (typeof message !== "object" || message === null) continue;
        sent.push(Object.fromEntries(Object.entries(message)));
        if (!("method" in message) || !("id" in message)) continue;
        let end = lines.findIndex((each, index) => index >= at && isReply(each)) + 1;
        if (end === 0) end = lines.length;
        stdout.write(`${lines.slice(at, end).join("\n")}\n`);
        at = end;
      }
    });
    return { stdin, stdout, stderr: new PassThrough(), exited, kill: () => exit(null) };
  };
  return { spawn, sent };
}

const methodsOf = (sent: readonly Record<string, unknown>[]): unknown[] =>
  sent.flatMap((message) => ("method" in message ? [message["method"]] : []));

/** A turn's tool calls and results in order, as the board's steps show them. */
function stepsOf(events: readonly AgentEvent[]): unknown[][] {
  return events.flatMap((e) =>
    e.type === "tool_call"
      ? [["call", e.name, e.input]]
      : e.type === "tool_result"
        ? [["result", e.name, e.ok, e.output]]
        : [],
  );
}

function request(overrides: Partial<TurnRequest>): TurnRequest {
  return {
    spec: {
      agent: "probe",
      project: "probe",
      cli: "antigravity",
      runner: "server",
      cwd: "/tmp/agy-fixture/ws",
      repoDir: "/tmp/agy-fixture/ws",
      configHome: "/tmp/agy-fixture/home",
      boardDir: "/tmp/agy-fixture/home",
    },
    session: "pending-1",
    newSession: true,
    prompt: "MARK_TEXT",
    instructions: "You are a probe for an adapter test.",
    mcp: { url: "http://127.0.0.1:9/mcp", token: "probe-token" },
    limits: { timeoutMs: 60_000 },
    statusSchema: turnStatusJsonSchema(),
    ...overrides,
  };
}

/**
 * Turns recorded from `agy acp` 1.5.15 on 2026-11-23, through this adapter, against a local stub
 * of the Gemini API with a dummy key: the stub answers by markers in the prompt, with 1,000 + n
 * input tokens of which 400 cached, and 60 output tokens of which 10 thinking, for its n-th
 * request. Protocol drift in a later release fails here first.
 */
describe("recorded agy acp turns", () => {
  it("replays a new session's turn that ran a command", async () => {
    const { spawn, sent } = await replay("acp-start-recorded.jsonl");
    const result = await new AntigravityBackend({ spawn }).runTurn(request({}));
    expect(methodsOf(sent)).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(result.exitReason).toBe("completed");
    expect(result.session).toBe("6b98cecf-cf82-4a72-a2bc-28d4b3331028");
    expect(result.model).toBe("gemini-3.1-pro");
    expect(result.status?.summary).toBe("stub turn");
    expect(stepsOf(result.events)).toEqual([
      ["call", "Bash", { command: "echo hello-from-agy" }],
      [
        "result",
        "Bash",
        true,
        expect.stringContaining("Command exited with code 0.\n\nCommand output:\nhello-from-agy"),
      ],
    ]);
    // Two requests, the title request to flash-lite left out: input outside the cache apart.
    expect(result.usage).toEqual({
      inputTokens: 1_205,
      outputTokens: 120,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
    expect(result.contextTokens).toBe(1_063);
    expect(result.transient).toBeUndefined();
  });

  it("puts the board in the session's MCP servers and the instructions in the append", async () => {
    const { spawn, sent } = await replay("acp-start-recorded.jsonl");
    await new AntigravityBackend({ spawn }).runTurn(request({}));
    const opened = sent.find((message) => message["method"] === "session/new");
    expect(opened?.["params"]).toMatchObject({
      cwd: "/tmp/agy-fixture/ws",
      mcpServers: [
        {
          type: "http",
          name: "board",
          url: "http://127.0.0.1:9/mcp",
          headers: [{ name: "Authorization", value: "Bearer probe-token" }],
        },
      ],
      _meta: {
        antigravity: {
          systemPrompt: {
            append: expect.stringMatching(
              /^You are a probe for an adapter test\.\n\n## The status object/,
            ),
          },
        },
      },
    });
  });

  it("replays a board tool's call under the name Claude gives it, without the tool summary", async () => {
    const { spawn } = await replay("acp-board-recorded.jsonl");
    const result = await new AntigravityBackend({ spawn }).runTurn(request({}));
    expect(result.exitReason).toBe("completed");
    // agy reports no MCP tool's output, only that it completed.
    expect(stepsOf(result.events)).toEqual([
      ["call", "mcp__board__echo_a", { msg: "hi" }],
      ["result", "mcp__board__echo_a", true, undefined],
    ]);
  });

  it("replays a resumed session's turn", async () => {
    const { spawn, sent } = await replay("acp-resume-recorded.jsonl");
    const result = await new AntigravityBackend({ spawn }).runTurn(
      request({ session: "6b98cecf-cf82-4a72-a2bc-28d4b3331028", newSession: false }),
    );
    expect(methodsOf(sent)).toEqual(["initialize", "session/resume", "session/prompt"]);
    const resumed = sent.find((message) => message["method"] === "session/resume");
    expect(resumed?.["params"]).toMatchObject({
      sessionId: "6b98cecf-cf82-4a72-a2bc-28d4b3331028",
      _meta: { antigravity: { systemPrompt: { append: expect.any(String) } } },
    });
    expect(result.exitReason).toBe("completed");
    expect(result.session).toBe("6b98cecf-cf82-4a72-a2bc-28d4b3331028");
    // A prompt's usage is its own turn's, never the session's running total.
    expect(result.usage).toEqual({
      inputTokens: 604,
      outputTokens: 60,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });
    expect(result.contextTokens).toBe(1_064);
  });

  it("asks once more for a status the turn's last message lacked, counting both prompts", async () => {
    const { spawn, sent } = await replay("acp-reask-recorded.jsonl");
    const result = await new AntigravityBackend({ spawn }).runTurn(request({}));
    expect(methodsOf(sent)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
      "session/prompt",
    ]);
    expect(result.exitReason).toBe("completed");
    expect(result.status?.summary).toBe("stub turn");
    expect(result.usage).toEqual({
      inputTokens: 1_221,
      outputTokens: 120,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
  });

  it("fails a turn agy said the service refused with a 500, as transient, and asks no status", async () => {
    const { spawn, sent } = await replay("acp-failed-recorded.jsonl");
    const result = await new AntigravityBackend({ spawn }).runTurn(request({}));
    expect(methodsOf(sent)).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(result.exitReason).toBe("error");
    expect(result.error).toBe(
      "agent executor error: generating and executing: Error 500, Message: stub refusal 500, Status: INTERNAL, Details: []",
    );
    expect(result.transient).toBe(true);
    expect(result.events.filter((e) => e.type === "text")).toEqual([]);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("fails a turn whose key the service refused, never as transient", async () => {
    const { spawn } = await replay("acp-key-recorded.jsonl");
    const result = await new AntigravityBackend({ spawn }).runTurn(request({}));
    expect(result.exitReason).toBe("error");
    expect(result.error).toContain("Error 400, Message: API key not valid.");
    expect(result.transient).toBeUndefined();
  });

  it("sets the citizen's model family and effort through the session's config options", async () => {
    const { spawn, sent } = await replay("acp-effort-recorded.jsonl");
    const base = request({});
    const result = await new AntigravityBackend({ spawn }).runTurn({
      ...base,
      spec: { ...base.spec, model: "gemini-4-neon", effort: "xhigh" },
    });
    expect(sent.filter((message) => message["method"] === "session/set_config_option")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ configId: "model", value: "gemini-4-neon" }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({ configId: "thought_level", value: "xhigh" }),
      }),
    ]);
    expect(result.exitReason).toBe("completed");
    expect(result.model).toBe("gemini-4-neon");
  });

  it("lists model families with their thinking levels from a new session's answer", async () => {
    const opened = (await fixtureLines("acp-start-recorded.jsonl"))
      .map((line): unknown => JSON.parse(line))
      .find((message) => JSON.stringify(message).includes('"availableModels"'));
    const models = modelsOf(
      typeof opened === "object" && opened !== null && "result" in opened ? opened.result : null,
    );
    expect(models.map((model) => model.id)).toEqual([
      "gemini-4-neon",
      "gemini-4-carbon",
      "gemini-4-hydrogen",
      "gemini-4-argon",
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.1-pro",
    ]);
    expect(models.find((model) => model.id === "gemini-4-neon")?.efforts.map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(models.filter((model) => model.isDefault)).toEqual([
      expect.objectContaining({
        id: "gemini-3.1-pro",
        efforts: [
          { id: "low", description: "" },
          { id: "high", description: "" },
        ],
        defaultEffort: "low",
      }),
    ]);
  });

  it("refuses a resume agy has no session for as lost, by the session list", async () => {
    // agy 1.5.14 and 1.5.15 both answer -32603, "Failed to read session …", for an unknown id.
    const lines = [
      ...(await fixtureLines("acp-start-recorded.jsonl")).slice(0, 1),
      '{"jsonrpc":"2.0","error":{"code":-32603,"message":"Failed to read session 0f8fad5b-d9cb-469f-a165-70867728950e; retry, or load it with session/load"},"id":2}',
      '{"jsonrpc":"2.0","result":{"sessions":[{"sessionId":"6b98cecf-cf82-4a72-a2bc-28d4b3331028","cwd":"/tmp/agy-fixture/ws","title":"ok MARK_CMD"}]},"id":3}',
    ];
    const spawn: SpawnAgy = () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let at = 0;
      stdin.on("data", () => {
        stdout.write(`${lines[at] ?? ""}\n`);
        at += 1;
      });
      return {
        stdin,
        stdout,
        stderr: new PassThrough(),
        exited: new Promise(() => undefined),
        kill: () => undefined,
      };
    };
    const failure = await new AntigravityBackend({ spawn })
      .runTurn(request({ session: "0f8fad5b-d9cb-469f-a165-70867728950e", newSession: false }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ResumeError);
    expect(failure).toMatchObject({ failure: "lost" });
  });
});
