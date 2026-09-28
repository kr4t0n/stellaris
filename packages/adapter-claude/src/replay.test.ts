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

const request: TurnRequest = {
  spec: {
    agent: "eng-1",
    project: "demo",
    cli: "claude",
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
  env: {},
};

describe("ClaudeAgentBackend replay", () => {
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
    expect(toolResults.map((e) => (e.type === "tool_result" ? [e.name, e.ok] : null))).toEqual([
      ["Bash", true],
      ["mcp__board__claim_task", false],
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
