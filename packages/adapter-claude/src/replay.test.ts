import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnRequest } from "@stellaris/runner-core";
import { describe, expect, it } from "vitest";
import { ClaudeAgentBackend, type QueryFn } from "./index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

async function recorded(name: string): Promise<SDKMessage[]> {
  const raw = await readFile(path.join(fixtures, name), "utf8");
  return (
    raw
      .trim()
      .split("\n")
      // Recorded SDK frames are trusted fixtures; the union is far too large to validate here.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      .map((line) => JSON.parse(line) as SDKMessage)
  );
}

interface RecordedCall {
  prompt: string;
  options: Options | undefined;
}

function replaying(messages: readonly SDKMessage[]): { queryFn: QueryFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queryFn: QueryFn = (params) => {
    calls.push({
      prompt: typeof params.prompt === "string" ? params.prompt : "<stream>",
      options: params.options,
    });
    return (async function* () {
      for (const message of messages) {
        yield message;
      }
    })();
  };
  return { queryFn, calls };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The CLI's own check of the id it is to create a session under, which Claude Code 2.1.283 makes
 * before anything else: it exits with this error for an id that is not a UUID.
 */
function checkingIds(queryFn: QueryFn): QueryFn {
  return (params) => {
    const stream = queryFn(params);
    const id = params.options?.sessionId;
    if (id === undefined || UUID.test(id)) {
      return stream;
    }
    const exited = new Error(
      "Claude Code process exited with code 1. stderr: Error: Invalid session ID. Must be a valid UUID.",
    );
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(exited) }) };
  };
}

const request: TurnRequest = {
  spec: {
    agent: "eng-1",
    project: "demo",
    cli: "claude",
    runner: "server",
    cwd: "/tmp/wt",
    repoDir: "/tmp/repo",
    configHome: "/tmp/home",
    boardDir: "/tmp/board",
  },
  session: "92132dad-48ca-450a-a7e7-82f8b2ab9b24",
  newSession: false,
  prompt: "Digest.",
  instructions: "# eng-1",
  mcp: { url: "http://127.0.0.1:4700/mcp", token: "stl_turn" },
  limits: { timeoutMs: 60_000, maxTurns: 10 },
  statusSchema: { type: "object" },
};

describe("ClaudeAgentBackend replay", () => {
  it("announces a turn once when the SDK sends a second init message", async () => {
    const messages = await recorded("sdk-synthetic.jsonl");
    const init = messages.find((message) => message.type === "system");
    const again = init === undefined ? [] : [{ ...init, model: "claude-haiku-4-5" }];
    const { queryFn } = replaying([...messages.slice(0, 2), ...again, ...messages.slice(2)]);
    const backend = new ClaudeAgentBackend({ queryFn, sessionExists: () => Promise.resolve(true) });
    const result = await backend.runTurn(request);

    expect(result.events.filter((e) => e.type === "turn_started")).toHaveLength(1);
    expect(result.model).toBe("claude-opus-5-5");
  });

  it("maps a recorded SDK stream onto board events and the status object", async () => {
    const messages = await recorded("sdk-synthetic.jsonl");
    const { queryFn, calls } = replaying(messages);
    const backend = new ClaudeAgentBackend({ queryFn, sessionExists: () => Promise.resolve(true) });
    const result = await backend.runTurn(request);

    expect(result.exitReason).toBe("completed");
    expect(result.model).toBe("claude-opus-5-5");
    expect(result.events[0]).toMatchObject({ type: "turn_started", model: "claude-opus-5-5" });
    expect(result.costUsd).toBeCloseTo(0.1922);
    expect(result.usage).toEqual({
      inputTokens: 4,
      outputTokens: 412,
      cacheReadTokens: 21716,
      cacheWriteTokens: 22308,
    });
    expect(result.status?.summary).toBe("nothing to do");
    expect(result.events.map((e) => e.type)).toEqual([
      "turn_started",
      "text",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "turn_completed",
    ]);
    const toolResults = result.events.filter((e) => e.type === "tool_result");
    expect(
      toolResults.map((e) => (e.type === "tool_result" ? [e.name, e.ok, e.output] : null)),
    ).toEqual([
      ["Bash", true, "On branch agent/eng-1"],
      ["mcp__board__claim_task", false, "CLAIM_CONFLICT: held by rev-1"],
    ]);

    const options = calls[0]?.options;
    expect(options?.resume).toBe("92132dad-48ca-450a-a7e7-82f8b2ab9b24");
    expect(options?.sessionId).toBeUndefined();
    expect(options?.additionalDirectories).toEqual(["/tmp/home", "/tmp/board"]);
    expect(options?.permissionPrompts).toBe("none");
    // Full autonomy: bypass mode with the SDK's explicit consent flag, and no allowlist.
    expect(options?.permissionMode).toBe("bypassPermissions");
    expect(options?.allowDangerouslySkipPermissions).toBe(true);
    expect(options?.allowedTools).toBeUndefined();
  });

  it("reports a resumed turn's own cost, not the session's running total", async () => {
    const messages = await recorded("sdk-synthetic.jsonl");
    const resumed = new ClaudeAgentBackend({
      queryFn: replaying(messages).queryFn,
      sessionExists: () => Promise.resolve(true),
    });
    const result = await resumed.runTurn({ ...request, costSoFarUsd: 0.1 });
    expect(result.costUsd).toBeCloseTo(0.0922);
    expect(result.sessionCostUsd).toBeCloseTo(0.1922);

    // A session that does not exist yet starts from nothing, whatever the runner last recorded.
    const created = new ClaudeAgentBackend({
      queryFn: replaying(messages).queryFn,
      sessionExists: () => Promise.resolve(false),
    });
    expect((await created.runTurn({ ...request, costSoFarUsd: 0.1 })).costUsd).toBeCloseTo(0.1922);
  });

  it("runs with the citizen's effort over the runner's, and the CLI's default without either", async () => {
    const messages = await recorded("sdk-synthetic.jsonl");
    const set = replaying(messages);
    await new ClaudeAgentBackend({ queryFn: set.queryFn, effort: "low" }).runTurn({
      ...request,
      spec: { ...request.spec, effort: "max" },
    });
    expect(set.calls[0]?.options?.effort).toBe("max");
    // A level Claude Code does not have, as one set for a Codex model, falls back.
    const foreign = replaying(messages);
    await new ClaudeAgentBackend({ queryFn: foreign.queryFn, effort: "low" }).runTurn({
      ...request,
      spec: { ...request.spec, effort: "minimal" },
    });
    expect(foreign.calls[0]?.options?.effort).toBe("low");
    const unset = replaying(messages);
    await new ClaudeAgentBackend({ queryFn: unset.queryFn }).runTurn(request);
    expect(unset.calls[0]?.options).not.toHaveProperty("effort");
  });

  it("sets no round limit when the runner asks for none", async () => {
    const messages = await recorded("sdk-synthetic.jsonl");
    const limited = replaying(messages);
    await new ClaudeAgentBackend({ queryFn: limited.queryFn }).runTurn(request);
    expect(limited.calls[0]?.options?.maxTurns).toBe(10);
    const unlimited = replaying(messages);
    await new ClaudeAgentBackend({ queryFn: unlimited.queryFn }).runTurn({
      ...request,
      limits: { timeoutMs: null, maxTurns: null },
    });
    expect(unlimited.calls[0]?.options).not.toHaveProperty("maxTurns");
  });

  it("creates the session under the recorded id when it does not exist yet", async () => {
    const messages = await recorded("sdk-synthetic.jsonl");
    const { queryFn, calls } = replaying(messages);
    const backend = new ClaudeAgentBackend({
      queryFn,
      sessionExists: () => Promise.resolve(false),
    });
    await backend.runTurn(request);
    const options = calls[0]?.options;
    expect(options?.sessionId).toBe("92132dad-48ca-450a-a7e7-82f8b2ab9b24");
    expect(options?.resume).toBeUndefined();
  });

  it("creates a fresh session in place of a recorded id the CLI cannot take, and reports it", async () => {
    const messages = await recorded("sdk-synthetic.jsonl");
    const { queryFn, calls } = replaying(messages);
    const asked: string[] = [];
    const backend = new ClaudeAgentBackend({
      queryFn: checkingIds(queryFn),
      sessionExists: (session) => {
        asked.push(session);
        return Promise.resolve(false);
      },
    });
    // What runners before 0.3.24 recorded for a conversation whose first turn never started its CLI.
    const result = await backend.runTurn({ ...request, session: "unstarted", costSoFarUsd: 0.1 });
    expect(result.error).toBeUndefined();
    expect(result.exitReason).toBe("completed");
    const fresh = calls[0]?.options?.sessionId;
    expect(fresh).toMatch(UUID);
    expect(calls[0]?.options?.resume).toBeUndefined();
    // The runner records the new id, so the conversation's next turn resumes it.
    expect(result.session).toBe(fresh);
    // Nothing of a session that never existed is counted.
    expect(result.costUsd).toBeCloseTo(0.1922);
    expect(asked).toEqual([]);

    // A recorded UUID that names no session yet stays its id: the session is created under it.
    const kept = replaying(messages);
    const created = await new ClaudeAgentBackend({
      queryFn: checkingIds(kept.queryFn),
      sessionExists: () => Promise.resolve(false),
    }).runTurn(request);
    expect(kept.calls[0]?.options?.sessionId).toBe(request.session);
    expect(created.session).toBeUndefined();
  });

  it("treats a stream without a result message as an error", async () => {
    const messages = (await recorded("sdk-synthetic.jsonl")).slice(0, 2);
    const { queryFn } = replaying(messages);
    const result = await new ClaudeAgentBackend({
      queryFn,
      sessionExists: () => Promise.resolve(true),
    }).runTurn(request);
    expect(result.exitReason).toBe("error");
    expect(result.error).toContain("without a result message");
  });
});
