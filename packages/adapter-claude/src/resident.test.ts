import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ResumeError, type AgentSpec, type ResidentStart } from "@stellaris/runner-core";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAgentBackend, type QueryFn } from "./index.js";

const spec: AgentSpec = {
  agent: "desk",
  project: "society",
  cli: "claude",
  runner: "r1",
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
      needsUserDecision: false,
      memoryUpdated: false,
    },
    total_cost_usd: totalCost,
    usage: { input_tokens: 10 * turn, output_tokens: turn },
    // The query's running totals: every turn's so far.
    modelUsage: {
      "claude-test-model": {
        inputTokens: (10 * turn * (turn + 1)) / 2,
        outputTokens: (turn * (turn + 1)) / 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: totalCost,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
    errors: [],
  };
  // Test frames stand in for the SDK's own union, which is far too large to build here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (stall ? [assistant] : [assistant, result]) as unknown as SDKMessage[];
}

/** A turn the API refused, as Claude Code 2.1.283 streamed it against a local server answering 400. */
function refusedFrames(): SDKMessage[] {
  const text = "API Error: 400 stub refuses";
  const assistant = {
    type: "assistant",
    session_id: start.session,
    error: "unknown",
    is_api_error_message: true,
    message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text }] },
  };
  const result = {
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 400,
    session_id: start.session,
    result: text,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return [assistant, result] as unknown as SDKMessage[];
}

/** A warm query that sends nothing but its init message, if it `opens`, and takes no interrupt. */
function hanging(opens: boolean): QueryFn {
  return () => {
    const ended = Promise.withResolvers<void>();
    const stream = (async function* () {
      if (opens) {
        yield {
          type: "system",
          subtype: "init",
          session_id: start.session,
          model: "claude-test-model",
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        } as unknown as SDKMessage;
      }
      await ended.promise;
    })();
    return Object.assign(stream, {
      interrupt: () => Promise.resolve(),
      close: () => ended.resolve(),
    });
  };
}

/**
 * A scripted SDK: reads user messages from the streamed prompt and answers each with the frames
 * for that turn, the way a real query does in streaming-input mode. Records interrupts and closes.
 */
function scripted(stallOn: number | null = null, savedCost = 0, refuseOn: number | null = null) {
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
        model: "claude-test-model",
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      } as unknown as SDKMessage;
      let turn = 0;
      for await (const message of source) {
        turn += 1;
        prompts.push(
          typeof message.message.content === "string" ? message.message.content : "<blocks>",
        );
        // The CLI echoes each user message it takes.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        yield { ...message, session_id: start.session, isReplay: true } as unknown as SDKMessage;
        for (const frame of refuseOn === turn
          ? refusedFrames()
          : frames(turn, `reply ${turn}`, savedCost + 0.1 * turn, stallOn === turn)) {
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
  it("fails a saved session whose id is not a UUID as lost, without starting the CLI", async () => {
    const asked: Array<Options | undefined> = [];
    const backend = new ClaudeAgentBackend({
      queryFn: (params) => {
        asked.push(params.options);
        return scripted().queryFn(params);
      },
    });
    // What runners before 0.3.24 saved for a conversation whose first turn never started its CLI.
    const refused = backend.startResident(spec, {
      ...start,
      session: "unstarted",
      newSession: false,
    });
    await expect(refused).rejects.toBeInstanceOf(ResumeError);
    await expect(refused).rejects.toMatchObject({
      failure: "lost",
      message: 'the saved session id "unstarted" is not a UUID, so Claude Code cannot resume it',
    });
    expect(asked).toEqual([]);
  });

  it("fails a resume the CLI cannot make, whether it ends before the first turn or during it", async () => {
    const saved = { ...start, newSession: false };
    const missing = `No conversation found with session ID: ${start.session}`;
    const sdkWords = `Claude Code returned an error result: ${missing}`;
    const asked: Array<Options | undefined> = [];
    // Claude Code 2.1.283 answers a resume it cannot make with a result and no init message, and
    // the SDK then throws; `waits` holds that back until the first prompt arrives.
    const unresumed =
      (waits: boolean, said: string | null): QueryFn =>
      (params) => {
        asked.push(params.options);
        const prompts = params.prompt;
        return (async function* () {
          if (waits && typeof prompts !== "string") {
            await prompts[Symbol.asyncIterator]().next();
          }
          if (said !== null) {
            yield {
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              session_id: start.session,
              total_cost_usd: 0,
              usage: { input_tokens: 0, output_tokens: 0 },
              errors: [missing],
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            } as unknown as SDKMessage;
          }
          throw new Error(said ?? "Claude Code process exited with code 1");
        })();
      };

    // During the first turn: the turn fails with the CLI's words.
    const during = await new ClaudeAgentBackend({
      queryFn: unresumed(true, sdkWords),
    }).startResident(spec, saved);
    const failed = await during.runTurn("hello");
    expect(failed.exitReason).toBe("error");
    expect(failed.error).toBe(sdkWords);
    expect(failed.resumeFailed).toBe("lost");
    await during.close();

    // Before it: the turn throws, as on any session that has ended, but says it could not resume.
    const before = await new ClaudeAgentBackend({
      queryFn: unresumed(false, sdkWords),
    }).startResident(spec, saved);
    await vi.waitFor(async () => {
      await expect(before.runTurn("hello")).rejects.toMatchObject({
        name: "ResumeError",
        failure: "lost",
        message: sdkWords,
      });
    });
    await before.close();

    // A CLI that ended before it opened the session for anything else may resume it next time.
    const died = await new ClaudeAgentBackend({
      queryFn: unresumed(true, null),
    }).startResident(spec, saved);
    expect((await died.runTurn("hello")).resumeFailed).toBe("retry");
    await died.close();
    expect(asked.map((options) => [options?.resume, options?.sessionId])).toEqual([
      [start.session, undefined],
      [start.session, undefined],
      [start.session, undefined],
    ]);

    // A new session's CLI that ends so did not fail a resume.
    const fresh = await new ClaudeAgentBackend({ queryFn: unresumed(true, null) }).startResident(
      spec,
      start,
    );
    const ended = await fresh.runTurn("hello");
    expect(ended.exitReason).toBe("error");
    expect(ended.resumeFailed).toBeUndefined();
    await fresh.close();
  });

  it("counts a resume the CLI never answers before the turn's limit as retry, and no limit after it opened the session", async () => {
    // Claude Code 2.1.283 on a transcript it never finishes reading sends nothing and takes no
    // interrupt, so the turn ends at its limit and the grace after it, 30 s for a limit of 15 s.
    vi.useFakeTimers();
    try {
      for (const [opens, failed] of [
        [false, "retry"],
        [true, undefined],
      ] as const) {
        const session = await new ClaudeAgentBackend({ queryFn: hanging(opens) }).startResident(
          spec,
          {
            ...start,
            newSession: false,
          },
        );
        const turn = session.runTurn("hello");
        await vi.advanceTimersByTimeAsync(500 + 15_000);
        const result = await turn;
        expect(result.exitReason).toBe("timeout");
        expect(result.error).toBe("turn exceeded 500 ms");
        expect(result.resumeFailed).toBe(failed);
        await session.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails no later turn as a resume once the CLI opened the session", async () => {
    const script = scripted(null, 0, 2);
    const session = await new ClaudeAgentBackend({ queryFn: script.queryFn }).startResident(spec, {
      ...start,
      newSession: false,
    });
    expect((await session.runTurn("hello")).exitReason).toBe("completed");
    const refused = await session.runTurn("again");
    expect(refused.exitReason).toBe("error");
    expect(refused.resumeFailed).toBeUndefined();
    await session.close();
  });

  it("measures a resumed session's first turn from the total its transcript saved", async () => {
    const script = scripted(null, 4.2);
    const backend = new ClaudeAgentBackend({
      queryFn: script.queryFn,
    });
    const session = await backend.startResident(spec, {
      ...start,
      newSession: false,
      costSoFarUsd: 4.2,
    });
    const first = await session.runTurn("hello");
    expect(first.costUsd).toBeCloseTo(0.1);
    expect(first.sessionCostUsd).toBeCloseTo(4.3);
    await session.close();
  });

  it("runs several turns on one streamed query and reports each turn's own cost", async () => {
    const script = scripted();
    const backend = new ClaudeAgentBackend({ queryFn: script.queryFn });
    const session = await backend.startResident(spec, start);

    const first = await session.runTurn("hello");
    expect(first.exitReason).toBe("completed");
    expect(first.status?.summary).toBe("turn 1");
    expect(first.costUsd).toBeCloseTo(0.1);
    expect(first.events.map((e) => e.type)).toEqual(["turn_started", "text", "turn_completed"]);
    expect(first.events[0]).toMatchObject({ type: "turn_started", runner: "r1" });

    const second = await session.runTurn("again");
    expect(second.status?.summary).toBe("turn 2");
    // The init message arrives once per session; every turn after it knows the model.
    expect(second.model).toBe("claude-test-model");
    expect(second.events[0]).toMatchObject({ type: "turn_started", model: "claude-test-model" });
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

  it("fails a turn the API refused with the API's words, and runs the next one", async () => {
    const script = scripted(null, 0, 1);
    const backend = new ClaudeAgentBackend({ queryFn: script.queryFn });
    const session = await backend.startResident(spec, start);

    const refused = await session.runTurn("hello");
    expect(refused.exitReason).toBe("error");
    expect(refused.error).toBe("API Error: 400 stub refuses");
    expect(refused.finalText).toBe("API Error: 400 stub refuses");
    expect(refused.status).toBeNull();

    // The CLI stays up after an API error, and the next turn starts from a clean state.
    const next = await session.runTurn("again");
    expect(next.exitReason).toBe("completed");
    expect(next.error).toBeUndefined();
    expect(next.status?.summary).toBe("turn 2");
    await session.close();
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

const GIT_IDENTITY = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

describe("the CLI's environment", () => {
  it("is the runner's own with husky off, the board token, and no git identity, cold or warm", async () => {
    // Whatever identity the test process inherited is the runner's own, which would pass through.
    for (const name of GIT_IDENTITY) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv("STELLARIS_TEST_RUNNER_ENV", "kept");
    // husky's install would point the clone's hooks away from the runner's guard.
    vi.stubEnv("HUSKY", "1");
    try {
      const envs: (Record<string, string | undefined> | undefined)[] = [];
      const script = scripted();
      const queryFn: QueryFn = (params) => {
        envs.push(params.options?.env);
        return script.queryFn(params);
      };
      const backend = new ClaudeAgentBackend({ queryFn, env: { EXTRA: "set", HUSKY: "1" } });
      const cold = await backend.runTurn({ ...start, spec, prompt: "hello" });
      expect(cold.exitReason).toBe("completed");
      const session = await backend.startResident(spec, start);
      expect((await session.runTurn("again")).exitReason).toBe("completed");
      await session.close();

      expect(envs).toHaveLength(2);
      for (const env of envs) {
        expect(env).toMatchObject({
          STELLARIS_TEST_RUNNER_ENV: "kept",
          EXTRA: "set",
          HUSKY: "0",
          STELLARIS_AGENT_TOKEN: "stl_resident",
        });
        for (const name of GIT_IDENTITY) {
          expect(env).not.toHaveProperty(name);
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
