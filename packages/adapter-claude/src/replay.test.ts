import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TurnControl, ZERO_USAGE, type TurnRequest } from "@stellaris/runner-core";
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

/**
 * A turn the API refused, as Claude Code 2.1.283 streamed it against a local server answering 400:
 * the init message that says it opened the session, a synthetic assistant message with the API's
 * words, then a `success` result marked `is_error`. Against 529 and 500 it streamed the same
 * frames once its own retries ran out, with `error: "server_error"` and the status.
 */
function refusedTurn(
  text = "API Error: 400 stub refuses",
  status: number | null = 400,
  error = "unknown",
): SDKMessage[] {
  const frames: unknown[] = [
    { type: "system", subtype: "init", session_id: "recorded", model: "claude-opus-5-5" },
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "<synthetic>",
        stop_reason: "stop_sequence",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: "text", text }],
      },
      parent_tool_use_id: null,
      error,
      is_api_error_message: true,
      session_id: "recorded",
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: status,
      terminal_reason: "api_error",
      result: text,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      num_turns: 1,
      session_id: "recorded",
    },
  ];
  // Hand-built frames in the SDK's shapes; the union is far too large to build here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return frames as SDKMessage[];
}

/** A cold run that ends as the SDK reports a CLI that exits, with code 1 unless told, after these frames. */
function exitingAfter(
  frames: readonly SDKMessage[],
  error = "Claude Code process exited with code 1",
): QueryFn {
  return () =>
    (async function* () {
      yield* frames;
      throw new Error(error);
    })();
}

/** A cold run whose CLI sends these frames and then nothing, until the turn's limit aborts it. */
function hangingAfter(frames: readonly SDKMessage[]): QueryFn {
  return (params) =>
    (async function* () {
      yield* frames;
      const signal = params.options?.abortController?.signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("Claude Code process aborted by user");
    })();
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

/** A cold turn of a session that exists, on these frames. */
function coldTurn(queryFn: QueryFn) {
  return new ClaudeAgentBackend({ queryFn }).runTurn(request);
}

describe("ClaudeAgentBackend replay", () => {
  it("announces a turn once when the SDK sends a second init message", async () => {
    const messages = await recorded("sdk-synthetic.jsonl");
    const init = messages.find((message) => message.type === "system");
    const again = init === undefined ? [] : [{ ...init, model: "claude-haiku-4-5" }];
    const { queryFn } = replaying([...messages.slice(0, 2), ...again, ...messages.slice(2)]);
    const backend = new ClaudeAgentBackend({ queryFn });
    const result = await backend.runTurn(request);

    expect(result.events.filter((e) => e.type === "turn_started")).toHaveLength(1);
    expect(result.model).toBe("claude-opus-5-5");
  });

  it("maps a recorded SDK stream onto board events and the status object", async () => {
    const messages = await recorded("sdk-synthetic.jsonl");
    const { queryFn, calls } = replaying(messages);
    const backend = new ClaudeAgentBackend({ queryFn });
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
    });
    const result = await resumed.runTurn({ ...request, costSoFarUsd: 0.1 });
    expect(result.costUsd).toBeCloseTo(0.0922);
    expect(result.sessionCostUsd).toBeCloseTo(0.1922);

    // A new session starts from nothing, whatever the runner last recorded.
    const created = new ClaudeAgentBackend({ queryFn: replaying(messages).queryFn });
    const fresh = await created.runTurn({ ...request, newSession: true, costSoFarUsd: 0.1 });
    expect(fresh.costUsd).toBeCloseTo(0.1922);
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

  it("creates a new conversation's session under the id the runner chose", async () => {
    const messages = await recorded("sdk-synthetic.jsonl");
    const { queryFn, calls } = replaying(messages);
    const result = await new ClaudeAgentBackend({ queryFn }).runTurn({
      ...request,
      newSession: true,
    });
    const options = calls[0]?.options;
    expect(options?.sessionId).toBe(request.session);
    expect(options?.resume).toBeUndefined();
    expect(result.session).toBeUndefined();
    expect(result.resumeFailed).toBeUndefined();
  });

  it("fails a saved session whose id is not a UUID as lost, without starting the CLI", async () => {
    // What runners before 0.3.24 saved for a conversation whose first turn never started its CLI,
    // and the placeholder a Codex session goes by until its thread opens.
    for (const session of ["unstarted", "pending-0b9a3c55-6f8e-4d3e-9a51-2a6f0c7d1e42", "abc"]) {
      const { queryFn, calls } = replaying(await recorded("sdk-synthetic.jsonl"));
      const result = await new ClaudeAgentBackend({ queryFn }).runTurn({
        ...request,
        session,
        costSoFarUsd: 0.1,
      });
      expect(calls).toEqual([]);
      expect(result.exitReason).toBe("error");
      expect(result.resumeFailed).toBe("lost");
      expect(result.error).toBe(
        `the saved session id "${session}" is not a UUID, so Claude Code cannot resume it`,
      );
      // No session is started in its place, and nothing ran.
      expect(result.session).toBeUndefined();
      expect(result.costUsd).toBe(0);
      expect(result.events.map((event) => event.type)).toEqual(["error", "turn_completed"]);
    }
  });

  it("fails a resume the CLI cannot make, lost on its words for a missing session and retry otherwise, and starts no other", async () => {
    // Claude Code 2.1.283 asked to resume an id with no transcript, or one it cannot read: a result
    // before any init message, its usage zeroed, then the SDK's throw, and no model call.
    const missing = `No conversation found with session ID: ${request.session}`;
    const unresumed: unknown[] = [
      {
        type: "result",
        subtype: "error_during_execution",
        duration_ms: 0,
        is_error: true,
        num_turns: 0,
        session_id: request.session,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {},
        errors: [missing],
      },
    ];
    const sdkWords = `Claude Code returned an error result: ${missing}`;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const notFound = exitingAfter(unresumed as SDKMessage[], sdkWords);
    const calls: Array<Options | undefined> = [];
    const lost = await new ClaudeAgentBackend({
      queryFn: (params) => {
        calls.push(params.options);
        return notFound(params);
      },
    }).runTurn({ ...request, costSoFarUsd: 0.1, usageSoFar: { ...ZERO_USAGE, inputTokens: 500 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.resume).toBe(request.session);
    expect(calls[0]?.sessionId).toBeUndefined();
    expect(lost.exitReason).toBe("error");
    expect(lost.error).toBe(sdkWords);
    expect(lost.resumeFailed).toBe("lost");
    expect(lost.session).toBeUndefined();
    expect(lost.costUsd).toBe(0);
    // Its zeroed usage is no running usage of the session's.
    expect(lost).not.toHaveProperty("sessionUsage");

    // A CLI that ended before it opened the session for anything else may resume it next time.
    for (const queryFn of [exitingAfter([]), replaying([]).queryFn]) {
      const ended = await coldTurn(queryFn);
      expect(ended.exitReason).toBe("error");
      expect(ended.resumeFailed).toBe("retry");
    }

    // Not a resume: the same end for a new session, an API error once the CLI opened the session,
    // and a stop.
    const unstarted = await new ClaudeAgentBackend({ queryFn: notFound }).runTurn({
      ...request,
      newSession: true,
    });
    expect(unstarted.exitReason).toBe("error");
    expect(unstarted.resumeFailed).toBeUndefined();
    const refused = await coldTurn(replaying(refusedTurn()).queryFn);
    expect(refused.exitReason).toBe("error");
    expect(refused.resumeFailed).toBeUndefined();
    const control = new TurnControl();
    control.stop();
    const stopped = await new ClaudeAgentBackend({ queryFn: notFound }).runTurn(
      request,
      undefined,
      control,
    );
    expect(stopped.exitReason).toBe("stopped");
    expect(stopped.resumeFailed).toBeUndefined();
  });

  it("counts a resume the CLI never answers before the turn's limit as retry, and no limit after it opened the session", async () => {
    // Claude Code 2.1.283 on a transcript it never finishes reading, such as a named pipe: nothing
    // at all, no init message and no model call, until the turn's limit aborts it.
    const limits = { timeoutMs: 50, maxTurns: 10 };
    const never = await new ClaudeAgentBackend({ queryFn: hangingAfter([]) }).runTurn({
      ...request,
      limits,
    });
    expect(never.exitReason).toBe("timeout");
    expect(never.error).toBe("turn exceeded 50 ms");
    expect(never.resumeFailed).toBe("retry");

    // Not a resume: a new session's CLI that hangs so, and a saved session's once the CLI opened it.
    const fresh = await new ClaudeAgentBackend({ queryFn: hangingAfter([]) }).runTurn({
      ...request,
      newSession: true,
      limits,
    });
    expect(fresh.exitReason).toBe("timeout");
    expect(fresh.resumeFailed).toBeUndefined();
    const init = (await recorded("sdk-synthetic.jsonl")).filter((frame) => frame.type === "system");
    const opened = await new ClaudeAgentBackend({ queryFn: hangingAfter(init) }).runTurn({
      ...request,
      limits,
    });
    expect(opened.exitReason).toBe("timeout");
    expect(opened.resumeFailed).toBeUndefined();
  });

  it("fails a turn the API refused with the API's words, not the exit that follows them", async () => {
    for (const queryFn of [replaying(refusedTurn()).queryFn, exitingAfter(refusedTurn())]) {
      const result = await coldTurn(queryFn);
      expect(result.exitReason).toBe("error");
      expect(result.error).toBe("API Error: 400 stub refuses");
      expect(result.status).toBeNull();
    }
    const unsaid = await coldTurn(replaying(refusedTurn("")).queryFn);
    expect(unsaid.exitReason).toBe("error");
    expect(unsaid.error).toBe("the turn ended on an API error");

    // A process that exits with no result, or after one that completed, fails with what the SDK
    // threw, as before.
    for (const frames of [[], await recorded("sdk-synthetic.jsonl")]) {
      const crashed = await coldTurn(exitingAfter(frames));
      expect(crashed.exitReason).toBe("error");
      expect(crashed.error).toBe("Claude Code process exited with code 1");
    }

    // So does one after an error subtype's result, which the SDK words itself, as Claude Code
    // 2.1.283 did for a transcript holding only a summary line. That result is marked `is_error`
    // too, and only a `success` so marked is an API error.
    const missing = "No conversation found with session ID: 92132dad-48ca-450a-a7e7-82f8b2ab9b24";
    const unresumed: unknown[] = [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [missing],
        total_cost_usd: 0,
      },
    ];
    const sdkWords = `Claude Code returned an error result: ${missing}`;
    const failed = await coldTurn(() =>
      (async function* () {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        yield* unresumed as SDKMessage[];
        throw new Error(sdkWords);
      })(),
    );
    expect(failed.exitReason).toBe("error");
    expect(failed.error).toBe(sdkWords);
  });

  it("ends a turn of several runs as its latest run did", async () => {
    // A turn runs more than once in one process for a background task a resumed session reports
    // before the prompt, or for a steer the CLI takes after its result.
    const done = (await recorded("sdk-synthetic.jsonl")).filter((frame) => frame.type === "result");
    const maxTurns: unknown[] = [
      { type: "result", subtype: "error_max_turns", errors: ["10"], total_cost_usd: 0 },
    ];
    for (const earlier of [
      refusedTurn("API Error: 529 overloaded"),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      maxTurns as SDKMessage[],
    ]) {
      const completed = await coldTurn(replaying([...earlier, ...done]).queryFn);
      expect(completed.exitReason).toBe("completed");
      expect(completed.error).toBeUndefined();
      expect(completed.status?.summary).toBe("nothing to do");
      expect(completed.events.filter((event) => event.type === "error")).toEqual([]);
    }

    // A run that completed after an API error leaves the CLI's exit after it to say why it failed.
    const exited = await coldTurn(
      exitingAfter([...refusedTurn("API Error: 529 overloaded"), ...done]),
    );
    expect(exited.exitReason).toBe("error");
    expect(exited.error).toBe("Claude Code process exited with code 1");

    // And an API error after a completed run fails the turn.
    const refusedLast = await coldTurn(replaying([...done, ...refusedTurn()]).queryFn);
    expect(refusedLast.exitReason).toBe("error");
    expect(refusedLast.error).toBe("API Error: 400 stub refuses");
  });

  it("says a turn the API turned away with a 5xx or a 529 may pass, and no other", async () => {
    const overloaded = refusedTurn(
      "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.",
      529,
      "server_error",
    );
    const failing = refusedTurn("API Error: 500 Internal server error.", 500, "server_error");
    for (const queryFn of [
      replaying(overloaded).queryFn,
      exitingAfter(overloaded),
      replaying(failing).queryFn,
      replaying(refusedTurn("API Error: Overloaded", null, "overloaded")).queryFn,
    ]) {
      const result = await coldTurn(queryFn);
      expect(result.exitReason).toBe("error");
      expect(result.transient).toBe(true);
    }
    for (const frames of [
      refusedTurn(),
      refusedTurn("API Error: Connection error.", null),
      // The plan's limit, which the CLI's `rate_limit` says, waits for its reset instead.
      refusedTurn("You've hit your limit · resets 3pm", 429, "rate_limit"),
    ]) {
      const result = await coldTurn(replaying(frames).queryFn);
      expect(result.exitReason).toBe("error");
      expect(result.transient).toBeUndefined();
    }

    // The latest run decides: a run that completed after an overload, and an error of its own after one.
    const done = (await recorded("sdk-synthetic.jsonl")).filter((frame) => frame.type === "result");
    expect((await coldTurn(replaying([...overloaded, ...done]).queryFn)).transient).toBeUndefined();
    const maxTurns: unknown[] = [
      { type: "result", subtype: "error_max_turns", errors: ["10"], total_cost_usd: 0 },
    ];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const then = await coldTurn(replaying([...overloaded, ...(maxTurns as SDKMessage[])]).queryFn);
    expect(then.exitReason).toBe("error");
    expect(then.transient).toBeUndefined();
  });

  it("treats a stream without a result message as an error", async () => {
    const messages = (await recorded("sdk-synthetic.jsonl")).slice(0, 2);
    const { queryFn } = replaying(messages);
    const result = await new ClaudeAgentBackend({
      queryFn,
    }).runTurn(request);
    expect(result.exitReason).toBe("error");
    expect(result.error).toContain("without a result message");
  });
});
