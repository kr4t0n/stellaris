import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSpec, ResidentStart } from "@stellaris/runner-core";
import { describe, expect, it } from "vitest";
import { ClaudeAgentBackend, type QueryFn } from "./index.js";

const spec: AgentSpec = {
  agent: "desk",
  project: "society",
  cli: "claude",
  cwd: "/tmp/home",
  repoDir: "/tmp/home",
  configHome: "/tmp/home",
  boardDir: "/tmp/board",
};

const start: ResidentStart = {
  session: "11111111-2222-4333-8444-555555555555",
  newSession: true,
  instructions: "# desk",
  mcp: { url: "http://127.0.0.1:4700/mcp", token: "stl_resident" },
  limits: { timeoutMs: 500, maxTurns: 10 },
  statusSchema: { type: "object" },
  env: {},
};

/** Fixture frames the SDK would produce; only the fields the adapter reads are populated. */
function frames(turn: number, text: string, totalCost: number, stall = false): SDKMessage[] {
  const assistant = {
    type: "assistant",
    session_id: start.session,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
  const result = {
    type: "result",
    subtype: "success",
    session_id: start.session,
    result: text,
    structured_output: {
      summary: `turn ${turn}`,
      claimsHeld: [],
      blockedOn: [],
      needsOwnerDecision: false,
      memoryUpdated: false,
    },
    total_cost_usd: totalCost,
    usage: { input_tokens: 10 * turn, output_tokens: turn },
    errors: [],
  };
  // Test frames stand in for the SDK's own union, which is far too large to build here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (stall ? [assistant] : [assistant, result]) as unknown as SDKMessage[];
}

/**
 * A scripted SDK: reads user messages from the streamed prompt and answers each with the frames
 * for that turn, the way a real query does in streaming-input mode. Records interrupts and closes.
 */
function scripted(stallOn: number | null = null) {
  const prompts: string[] = [];
  const calls = { interrupts: 0, closes: 0 };
  let userMessages: AsyncIterable<SDKUserMessage> | null = null;
  const queryFn: QueryFn = (params) => {
    if (typeof params.prompt === "string") {
      throw new Error("resident sessions stream their prompts");
    }
    userMessages = params.prompt;
    const source = userMessages;
    const stream = (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: start.session,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      } as unknown as SDKMessage;
      let turn = 0;
      for await (const message of source) {
        turn += 1;
        prompts.push(
          typeof message.message.content === "string" ? message.message.content : "<blocks>",
        );
        for (const frame of frames(turn, `reply ${turn}`, 0.1 * turn, stallOn === turn)) {
          yield frame;
        }
      }
    })();
    return Object.assign(stream, {
      interrupt: () => {
        calls.interrupts += 1;
        return Promise.resolve();
      },
      close: () => {
        calls.closes += 1;
      },
    });
  };
  return { queryFn, prompts, calls };
}

describe("Claude resident sessions", () => {
  it("runs several turns on one streamed query and reports each turn's own cost", async () => {
    const script = scripted();
    const backend = new ClaudeAgentBackend({ queryFn: script.queryFn, runnerName: "r1" });
    const session = await backend.startResident(spec, start);

    const first = await session.runTurn("hello");
    expect(first.exitReason).toBe("completed");
    expect(first.status?.summary).toBe("turn 1");
    expect(first.costUsd).toBeCloseTo(0.1);
    expect(first.events.map((e) => e.type)).toEqual(["turn_started", "text", "turn_completed"]);
    expect(first.events[0]).toMatchObject({ type: "turn_started", runner: "r1" });

    const second = await session.runTurn("again");
    expect(second.status?.summary).toBe("turn 2");
    // The SDK reports a running total; the session hands back the delta.
    expect(second.costUsd).toBeCloseTo(0.1);
    expect(second.usage).toEqual({
      inputTokens: 20,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(script.prompts).toEqual(["hello", "again"]);

    await session.close();
    expect(script.calls.closes).toBe(1);
    await expect(session.runTurn("late")).rejects.toThrow(/ended/);
  });

  it("interrupts a turn that exceeds its limit and reports a timeout", async () => {
    const script = scripted(1);
    const backend = new ClaudeAgentBackend({ queryFn: script.queryFn });
    const session = await backend.startResident(spec, { ...start, limits: { timeoutMs: 100 } });
    const stalled = session.runTurn("stall");
    // Nothing settles the stalled turn by itself; closing the session does, like a crash would.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(script.calls.interrupts).toBe(1);
    await session.close();
    const result = await stalled;
    expect(result.exitReason).toBe("timeout");
    expect(result.error).toContain("exceeded 100 ms");
  });
});
