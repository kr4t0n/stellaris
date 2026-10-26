import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ResidentStart, TurnRequest } from "@stellaris/runner-core";
import type { Usage } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { ClaudeAgentBackend, type QueryFn } from "./index.js";

/*
 * The streams Claude Code 2.1.283 (the Agent SDK 0.3.283's binary) sent through this adapter
 * against a local stub of the Messages API. The stub charged each main-loop request 100 input,
 * 10 cache-write, 2,000 cache-read and 50 output tokens, a sub-agent's request 7,000 input and 70
 * output, and the CLI's own title request 30 input and 3 output. Each turn's Agent call ran its
 * sub-agent in the background, and the sub-agent's end started another run.
 *
 * - `sdk-subagent-recorded.jsonl`: a new session's turn, its sub-agent on a second model.
 * - `sdk-subagent-resumed-recorded.jsonl`: the same session's third turn, after a plain second
 *   one left it at 7,530 input, 323 output, 10,000 cache-read and 50 cache-write tokens.
 * - `sdk-warm-subagent-recorded.jsonl`: a warm session of three prompts, whose first prompt's
 *   sub-agent finished after that turn's result, before the second prompt.
 */
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

function usage(input: number, output: number, cacheRead: number, cacheWrite: number): Usage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

/** A cold query that streams these frames. */
function replaying(frames: readonly SDKMessage[]): QueryFn {
  return () =>
    (async function* () {
      yield* frames;
    })();
}

/**
 * A warm query that streams these frames, holding each echo of a prompt until the adapter pushes
 * the prompt, and echoing it under the prompt's own id as the CLI does.
 */
function replayingWarm(frames: readonly SDKMessage[]): QueryFn {
  return (params) => {
    if (typeof params.prompt === "string") {
      throw new Error("warm sessions stream their prompts");
    }
    const prompts: AsyncIterator<SDKUserMessage> = params.prompt[Symbol.asyncIterator]();
    return (async function* () {
      for (const frame of frames) {
        if (frame.type === "user" && "isReplay" in frame && frame.isReplay) {
          const prompt = await prompts.next();
          if (prompt.done === true) {
            return;
          }
          yield { ...frame, uuid: prompt.value.uuid ?? frame.uuid };
        } else {
          yield frame;
        }
      }
    })();
  };
}

const spec = {
  agent: "eng-1",
  project: "demo",
  cli: "claude" as const,
  runner: "runner-1",
  cwd: "/tmp/wt",
  repoDir: "/tmp/repo",
  configHome: "/tmp/home",
  boardDir: "/tmp/board",
};

const request: TurnRequest = {
  spec,
  session: "4ae75d8d-1004-47e4-b142-b1fb7deaa207",
  newSession: false,
  prompt: "Digest.",
  instructions: "# eng-1",
  mcp: { url: "http://127.0.0.1:4700/mcp", token: "stl_turn" },
  limits: { timeoutMs: 60_000, maxTurns: 10 },
  statusSchema: { type: "object" },
};

const start: ResidentStart = {
  session: "49c5190d-3e0b-4b75-81eb-d7aca6ed1f5b",
  newSession: true,
  instructions: "# eng-1",
  mcp: { url: "http://127.0.0.1:4700/mcp", token: "stl_turn" },
  limits: { timeoutMs: 60_000, maxTurns: 10 },
  statusSchema: { type: "object" },
};

/** The parent's four main-loop requests, the sub-agent's one, and the CLI's title request. */
const NEW_WITH_SUBAGENT = usage(7_430, 273, 8_000, 40);

describe("a Claude turn's usage", () => {
  it("counts a new session's sub-agent and the CLI's own request, summed over every model", async () => {
    const frames = await recorded("sdk-subagent-recorded.jsonl");
    const last = frames.findLast((frame) => frame.type === "result");
    // The sub-agent ran on a model of its own, so the session's usage names two.
    expect(last?.type === "result" ? Object.keys(last.modelUsage).toSorted() : []).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-opus-5-5[1m]",
    ]);
    const result = await new ClaudeAgentBackend({ queryFn: replaying(frames) }).runTurn({
      ...request,
      newSession: true,
    });
    expect(result.exitReason).toBe("completed");
    expect(result.usage).toEqual(NEW_WITH_SUBAGENT);
    expect(result.sessionUsage).toEqual(NEW_WITH_SUBAGENT);
    expect(result.events.at(-1)).toMatchObject({
      type: "turn_completed",
      usage: NEW_WITH_SUBAGENT,
    });
    // The cost was the session's whole spend already: the CLI prices the same requests.
    expect(result.costUsd).toBeCloseTo(0.01493);
  });

  it("counts a resumed session's growth past the running usage its last turn left", async () => {
    const frames = await recorded("sdk-subagent-resumed-recorded.jsonl");
    const result = await new ClaudeAgentBackend({ queryFn: replaying(frames) }).runTurn({
      ...request,
      costSoFarUsd: 0.01678,
      usageSoFar: usage(7_530, 323, 10_000, 50),
    });
    // Four main-loop requests and the sub-agent's.
    expect(result.usage).toEqual(usage(7_400, 270, 8_000, 40));
    expect(result.sessionUsage).toEqual(usage(14_930, 593, 18_000, 90));
    expect(result.costUsd).toBeCloseTo(0.01475);
  });

  it("counts a resumed session the board holds no running usage for by its results, never its whole total", async () => {
    const frames = await recorded("sdk-subagent-resumed-recorded.jsonl");
    const result = await new ClaudeAgentBackend({ queryFn: replaying(frames) }).runTurn(request);
    // The main loop alone, as before the running usage was kept; the next turn measures from here.
    expect(result.usage).toEqual(usage(400, 200, 8_000, 40));
    expect(result.sessionUsage).toEqual(usage(14_930, 593, 18_000, 90));
  });

  it("counts a session the CLI resumed from less than the board held by its results", async () => {
    // As after the CLI was killed outright: it saves its totals only as its process ends.
    const frames = await recorded("sdk-subagent-resumed-recorded.jsonl");
    const result = await new ClaudeAgentBackend({ queryFn: replaying(frames) }).runTurn({
      ...request,
      usageSoFar: usage(20_000, 300, 10_000, 100),
    });
    expect(result.usage).toEqual(usage(400, 200, 8_000, 40));
    // The next turn measures from what the CLI holds now, which it saves as it ends.
    expect(result.sessionUsage).toEqual(usage(14_930, 593, 18_000, 90));
  });

  it("finds a short resume from the turn's first result, though the turn outgrew the board's figure", async () => {
    // The first result holds 14,730 / 493 / 14,000 / 70, of which its run's main loop spent
    // 200 / 100 / 4,000 / 20, so the session held at most 393 output tokens before it, not 400.
    const frames = await recorded("sdk-subagent-resumed-recorded.jsonl");
    const result = await new ClaudeAgentBackend({ queryFn: replaying(frames) }).runTurn({
      ...request,
      usageSoFar: usage(7_530, 400, 10_000, 50),
    });
    expect(result.usage).toEqual(usage(400, 200, 8_000, 40));
  });

  it("counts in a warm session's next turn what it spent between turns, once", async () => {
    const frames = await recorded("sdk-warm-subagent-recorded.jsonl");
    const backend = new ClaudeAgentBackend({ queryFn: replayingWarm(frames) });
    const session = await backend.startResident(spec, start);
    const turns = [
      await session.runTurn("PARENT-TASK: SPAWN a helper."),
      await session.runTurn("PARENT-TASK: plain turn."),
      await session.runTurn("PARENT-TASK: plain again."),
    ];
    await session.close();
    expect(turns.map((turn) => turn.exitReason)).toEqual(["completed", "completed", "completed"]);
    expect(turns.map((turn) => turn.usage)).toEqual([
      // Two main-loop requests and the title request, before the sub-agent answered.
      usage(230, 103, 4_000, 20),
      // The sub-agent, the run its end started between turns, and this turn's own.
      usage(7_430, 273, 8_000, 40),
      usage(230, 103, 4_000, 20),
    ]);
    expect(turns.map((turn) => turn.sessionUsage)).toEqual([
      usage(230, 103, 4_000, 20),
      usage(7_660, 376, 12_000, 60),
      usage(7_890, 479, 16_000, 80),
    ]);
  });

  it("counts a warm session's first turn by its results when the board holds no running usage for it", async () => {
    const frames = await recorded("sdk-warm-subagent-recorded.jsonl");
    const backend = new ClaudeAgentBackend({ queryFn: replayingWarm(frames) });
    const session = await backend.startResident(spec, { ...start, newSession: false });
    const first = await session.runTurn("PARENT-TASK: SPAWN a helper.");
    const second = await session.runTurn("PARENT-TASK: plain turn.");
    await session.close();
    expect(first.usage).toEqual(usage(200, 100, 4_000, 20));
    expect(first.sessionUsage).toEqual(usage(230, 103, 4_000, 20));
    expect(second.usage).toEqual(usage(7_430, 273, 8_000, 40));
  });

  it("measures a warm session that resumed from the running usage the board held", async () => {
    const frames = await recorded("sdk-warm-subagent-recorded.jsonl");
    const backend = new ClaudeAgentBackend({ queryFn: replayingWarm(frames) });
    const session = await backend.startResident(spec, {
      ...start,
      newSession: false,
      usageSoFar: usage(10, 1, 0, 0),
    });
    const first = await session.runTurn("PARENT-TASK: SPAWN a helper.");
    await session.close();
    expect(first.usage).toEqual(usage(220, 102, 4_000, 20));
  });

  it("reports no running usage for a turn that saw no result, and counts it as before", async () => {
    const frames = await recorded("sdk-subagent-resumed-recorded.jsonl");
    const unfinished = frames.filter((frame) => frame.type !== "result");
    const result = await new ClaudeAgentBackend({ queryFn: replaying(unfinished) }).runTurn({
      ...request,
      usageSoFar: usage(7_530, 323, 10_000, 50),
    });
    expect(result.exitReason).toBe("error");
    expect(result.usage).toEqual(usage(0, 0, 0, 0));
    expect(result).not.toHaveProperty("sessionUsage");
  });
});
