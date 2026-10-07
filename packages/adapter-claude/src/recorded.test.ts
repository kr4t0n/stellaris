import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { TurnControl, type TurnRequest } from "@stellaris/runner-core";
import type { AgentEvent } from "@stellaris/shared";
import { describe, expect, it, vi } from "vitest";
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

  /**
   * A turn recorded on 2026-10-07 from Claude Code on Haiku over streaming input with replayed user
   * messages: it ran a 30-second command, the user's post arrived meanwhile as a steer, and the CLI
   * folded it in after the command's result and echoed it before acting on it.
   */
  it("replays a steered turn: the post is taken after the running command and acted on", async () => {
    const raw = await readFile(path.join(fixtures, "sdk-steered-recorded.jsonl"), "utf8");
    const messages = raw
      .trim()
      .split("\n")
      // Recorded SDK frames are trusted fixtures; the union is far too large to validate here.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      .map((line) => JSON.parse(line) as SDKMessage);
    const steerId = "b04273c7-da5e-4996-b0c1-7e8a7fccb670";
    const queryFn: QueryFn = (params) => {
      if (typeof params.prompt === "string") {
        throw new Error("a turn streams its prompt");
      }
      const input = params.prompt[Symbol.asyncIterator]();
      const next = async (): Promise<SDKUserMessage | undefined> => {
        const item = await input.next();
        return item.done === true ? undefined : item.value;
      };
      return (async function* () {
        const prompt = await next();
        let echoes = 0;
        for (const message of messages) {
          if (message.type === "user" && "isReplay" in message && message.isReplay) {
            echoes += 1;
            // The CLI echoes the ids it was given: the prompt's, then the steer's once it is pushed.
            const taken = echoes === 1 ? prompt : await next();
            yield { ...message, uuid: taken?.uuid ?? message.uuid };
            continue;
          }
          yield message;
        }
      })();
    };
    const request: TurnRequest = {
      spec: {
        agent: "cc",
        project: "demo",
        cli: "claude",
        runner: "live",
        cwd: "/tmp/wt",
        repoDir: "/tmp/repo",
        configHome: "/tmp/home",
        boardDir: "/tmp/board",
      },
      session: "recorded",
      newSession: false,
      prompt: "Digest.",
      instructions: "# cc",
      mcp: { url: "http://127.0.0.1:4791/mcp", token: "t" },
      limits: { timeoutMs: 60_000 },
      statusSchema: { type: "object" },
      env: {},
    };
    const control = new TurnControl();
    const events: AgentEvent[] = [];
    const running = new ClaudeAgentBackend({
      queryFn,
      sessionExists: () => Promise.resolve(true),
    }).runTurn(request, (event) => events.push(event), control);
    await vi.waitFor(async () =>
      expect(await control.steer({ id: steerId, text: "end your post with PINEAPPLE" })).toBe(true),
    );
    const result = await running;

    expect(result.exitReason).toBe("completed");
    const steps = events.map((event) =>
      event.type === "tool_call" || event.type === "tool_result"
        ? `${event.type}:${event.name}`
        : event.type,
    );
    const steered = steps.indexOf("steered");
    expect(steps[steered - 1]).toBe("tool_result:Bash");
    expect(steps.slice(steered)).toContain("tool_call:mcp__board__post_message");
    expect(events[steered]).toEqual({ type: "steered", steer: steerId });
    const post = events.find(
      (event) => event.type === "tool_call" && event.name === "mcp__board__post_message",
    );
    expect(JSON.stringify(post)).toContain("PINEAPPLE");
  });
});
