import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ClaudeAgentBackend, type QueryFn } from "./index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/**
 * A stream recorded from a live Claude Code turn on 2026-09-28: the reviewer approving a task
 * submitted by a Codex engineer. It carries frames the mapper must ignore (rate limits, thinking
 * token counts) as well as the ones it maps. SDK drift in a future release fails here.
 */
describe("recorded Claude stream", () => {
  it("replays a review turn to a completed status with the board call mapped", async () => {
    const raw = await readFile(path.join(fixtures, "sdk-review-recorded.jsonl"), "utf8");
    const messages = raw
      .trim()
      .split("\n")
      // Recorded SDK frames are trusted fixtures; the union is far too large to validate here.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      .map((line) => JSON.parse(line) as SDKMessage);
    const queryFn: QueryFn = () =>
      (async function* () {
        for (const message of messages) {
          yield message;
        }
      })();
    const result = await new ClaudeAgentBackend({
      queryFn,
      sessionExists: () => Promise.resolve(true),
    }).runTurn({
      spec: {
        agent: "rev-1",
        project: "demo",
        cli: "claude",
        runner: "server",
        cwd: "/tmp/wt",
        repoDir: "/tmp/repo",
        configHome: "/tmp/home",
        boardDir: "/tmp/board",
      },
      session: "recorded",
      newSession: false,
      prompt: "Digest.",
      instructions: "# rev-1",
      mcp: { url: "http://127.0.0.1:4712/mcp", token: "t" },
      limits: { timeoutMs: 60_000 },
      statusSchema: { type: "object" },
      env: {},
    });
    expect(result.exitReason).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.status?.summary).toContain("approved");
    const calls = result.events
      .filter((e) => e.type === "tool_call")
      .map((e) => (e.type === "tool_call" ? e.name : ""));
    expect(calls).toContain("mcp__board__update_task");
    expect(calls).toContain("StructuredOutput");
    const results = result.events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(3);
    // A board verb answers with content blocks; their text is the output.
    expect(results[1]).toMatchObject({ output: expect.stringContaining('"project": "demo"') });
    expect(result.events[0]?.type).toBe("turn_started");
  });
});
