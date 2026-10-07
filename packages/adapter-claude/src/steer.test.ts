import { randomUUID } from "node:crypto";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { TurnControl, type AgentSpec, type TurnRequest } from "@stellaris/runner-core";
import type { AgentEvent } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { ClaudeAgentBackend, type QueryFn } from "./index.js";

const spec: AgentSpec = {
  agent: "eng-1",
  project: "demo",
  cli: "claude",
  runner: "r1",
  cwd: "/tmp/work",
  repoDir: "/tmp/work",
  configHome: "/tmp/home",
  boardDir: "/tmp/board",
};

const request: TurnRequest = {
  spec,
  session: "11111111-2222-4333-8444-555555555555",
  newSession: true,
  prompt: "build it",
  instructions: "# eng",
  mcp: { url: "http://127.0.0.1:4700/mcp", token: "stl_turn" },
  limits: { timeoutMs: 5_000, maxTurns: 10 },
  statusSchema: { type: "object" },
  env: {},
};

// Test frames stand in for the SDK's own union, which is far too large to build here.
function frame(value: Record<string, unknown>): SDKMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as unknown as SDKMessage;
}

function result(summary: string, total: number, subtype = "success"): SDKMessage {
  return frame({
    type: "result",
    subtype,
    session_id: request.session,
    result: summary,
    structured_output:
      subtype === "success"
        ? { summary, claimsHeld: [], blockedOn: [], needsUserDecision: false, memoryUpdated: false }
        : undefined,
    total_cost_usd: total,
    usage: { input_tokens: 10, output_tokens: 1 },
    errors: subtype === "success" ? [] : ["[Request interrupted by user]"],
  });
}

/** The CLI's echo of a user message it took. */
function echo(message: SDKUserMessage): SDKMessage {
  return frame({
    ...message,
    uuid: message.uuid ?? randomUUID(),
    session_id: request.session,
    isReplay: true,
  });
}

/** Reads a streamed prompt the way the CLI does: waiting for the next message, or only peeking. */
class Input {
  private readonly iterator: AsyncIterator<SDKUserMessage>;
  private pending: Promise<IteratorResult<SDKUserMessage>> | null = null;

  constructor(source: AsyncIterable<SDKUserMessage>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async next(): Promise<SDKUserMessage | null> {
    const read = this.pending ?? this.iterator.next();
    this.pending = null;
    const item = await read;
    return item.done === true ? null : item.value;
  }

  /** A message already queued, without waiting for one. */
  async queued(): Promise<SDKUserMessage | null> {
    this.pending ??= this.iterator.next();
    const read = this.pending;
    const item = await Promise.race([
      read,
      new Promise<null>((resolve) => setImmediate(resolve, null)),
    ]);
    if (item === null) {
      return null;
    }
    this.pending = null;
    return item.done === true ? null : item.value;
  }
}

/**
 * A scripted Claude Code over streaming input, as the live CLI behaved: the first turn runs a tool
 * that finishes when `release` is called, folds whatever was queued meanwhile into the turn after
 * the tool's result and echoes it, and ends with a result; a message arriving after that result
 * starts a continuation in the same process. An interrupt ends the running turn at once.
 */
function scriptedCli(options: { foldQueued?: boolean; backgroundTaskFirst?: boolean } = {}) {
  const received: SDKUserMessage[] = [];
  const calls = { interrupts: 0, closes: 0 };
  const released = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();

  const queryFn: QueryFn = (params) => {
    if (typeof params.prompt === "string") {
      throw new Error("turns stream their prompts so they can be steered");
    }
    const input = new Input(params.prompt);
    const stream = (async function* () {
      if (options.backgroundTaskFirst === true) {
        // A resumed session first runs a turn of its own for a background task left from before.
        yield frame({
          type: "system",
          subtype: "init",
          session_id: request.session,
          model: "claude-test",
        });
        yield frame({ type: "system", subtype: "task_notification", session_id: request.session });
        yield result("background task finished", 0.02);
      }
      const prompt = await input.next();
      if (prompt === null) {
        return;
      }
      received.push(prompt);
      yield frame({
        type: "system",
        subtype: "init",
        session_id: request.session,
        model: "claude-test",
      });
      yield echo(prompt);
      yield frame({
        type: "assistant",
        session_id: request.session,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }],
        },
      });
      started.resolve();
      const stopped = await Promise.race([
        released.promise.then(() => false),
        interrupted.promise.then(() => true),
      ]);
      if (stopped) {
        yield result("interrupted", 0.05, "error_during_execution");
        return;
      }
      yield frame({
        type: "user",
        session_id: request.session,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "built" }],
        },
      });
      if (options.foldQueued !== false) {
        for (let message = await input.queued(); message !== null; message = await input.queued()) {
          received.push(message);
          yield echo(message);
        }
      }
      yield frame({
        type: "assistant",
        session_id: request.session,
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      });
      yield result("first run", 0.1);
      // After a result the CLI waits for input; a message now is a continuation in this process.
      for (
        let message = await input.next(), run = 2;
        message !== null;
        message = await input.next(), run += 1
      ) {
        received.push(message);
        yield frame({
          type: "system",
          subtype: "init",
          session_id: request.session,
          model: "claude-test",
        });
        yield echo(message);
        yield result(`run ${run}`, 0.1 * run);
      }
    })();
    return Object.assign(stream, {
      interrupt: () => {
        calls.interrupts += 1;
        interrupted.resolve();
        return Promise.resolve();
      },
      close: () => {
        calls.closes += 1;
      },
    });
  };
  return { queryFn, received, calls, release: released.resolve, started: started.promise };
}

const steer = (text: string) => ({ id: randomUUID(), text });

describe("steering and stopping a Claude turn", () => {
  it("folds a steer into the running turn and reports it taken where the CLI took it", async () => {
    const cli = scriptedCli();
    const backend = new ClaudeAgentBackend({ queryFn: cli.queryFn });
    const control = new TurnControl();
    const events: AgentEvent[] = [];
    const running = backend.runTurn(request, (event) => events.push(event), control);
    await cli.started;
    const post = steer("## New in this conversation\n\nalso add a test");
    expect(await control.steer(post)).toBe(true);
    cli.release();
    const done = await running;

    expect(done.exitReason).toBe("completed");
    expect(done.status?.summary).toBe("first run");
    expect(cli.received.map((message) => message.priority ?? null)).toEqual([null, "next"]);
    expect(cli.received[1]?.uuid).toBe(post.id);
    expect(events.map((event) => event.type)).toEqual([
      "turn_started",
      "tool_call",
      "tool_result",
      "steered",
      "text",
      "turn_completed",
    ]);
    expect(events.find((event) => event.type === "steered")).toEqual({
      type: "steered",
      steer: post.id,
    });
    // Once the turn has ended, nothing more goes in.
    expect(await control.steer(steer("too late"))).toBe(false);
  });

  it("waits for a steer the CLI runs after its result, and ends with that run's result", async () => {
    const cli = scriptedCli({ foldQueued: false });
    const backend = new ClaudeAgentBackend({ queryFn: cli.queryFn });
    const control = new TurnControl();
    const events: AgentEvent[] = [];
    const running = backend.runTurn(request, (event) => events.push(event), control);
    await cli.started;
    const post = steer("one more thing");
    expect(await control.steer(post)).toBe(true);
    cli.release();
    const done = await running;

    expect(done.status?.summary).toBe("run 2");
    expect(done.exitReason).toBe("completed");
    expect(done.costUsd).toBeCloseTo(0.2);
    expect(events.filter((event) => event.type === "turn_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "steered")).toEqual([
      { type: "steered", steer: post.id },
    ]);
  });

  it("stops a running turn: interrupts the CLI, closes it, and reports the turn stopped", async () => {
    const cli = scriptedCli();
    const backend = new ClaudeAgentBackend({ queryFn: cli.queryFn });
    const control = new TurnControl();
    const events: AgentEvent[] = [];
    const running = backend.runTurn(request, (event) => events.push(event), control);
    await cli.started;
    control.stop();
    expect(await control.steer(steer("ignored"))).toBe(false);
    const done = await running;

    expect(cli.calls.interrupts).toBe(1);
    expect(cli.calls.closes).toBe(1);
    expect(done.exitReason).toBe("stopped");
    expect(done.error).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", exitReason: "stopped" });
  });

  it("steers and stops a turn on a warm session as it does a cold one", async () => {
    const cli = scriptedCli();
    const backend = new ClaudeAgentBackend({ queryFn: cli.queryFn });
    const session = await backend.startResident(spec, { ...request, newSession: true });
    const control = new TurnControl();
    const events: AgentEvent[] = [];
    const running = session.runTurn("build it", (event) => events.push(event), control);
    await cli.started;
    const post = steer("also add a test");
    expect(await control.steer(post)).toBe(true);
    cli.release();
    const done = await running;
    expect(done.status?.summary).toBe("first run");
    expect(events.filter((event) => event.type === "steered")).toEqual([
      { type: "steered", steer: post.id },
    ]);
    expect(await control.steer(steer("too late"))).toBe(false);
    await session.close();

    const stopping = scriptedCli();
    const warm = await new ClaudeAgentBackend({ queryFn: stopping.queryFn }).startResident(spec, {
      ...request,
      newSession: true,
    });
    const stopControl = new TurnControl();
    const stopped = warm.runTurn("build it", undefined, stopControl);
    await stopping.started;
    stopControl.stop();
    const ended = await stopped;
    expect(stopping.calls.interrupts).toBe(1);
    expect(ended.exitReason).toBe("stopped");
    expect(ended.error).toBeUndefined();
    await warm.close();
  });

  it("ends the turn at its own result, not at one the CLI gave a background task before the prompt", async () => {
    const cli = scriptedCli({ backgroundTaskFirst: true });
    const backend = new ClaudeAgentBackend({ queryFn: cli.queryFn });
    const control = new TurnControl();
    const events: AgentEvent[] = [];
    const running = backend.runTurn(request, (event) => events.push(event), control);
    await cli.started;
    const post = steer("also add a test");
    expect(await control.steer(post)).toBe(true);
    cli.release();
    const done = await running;
    expect(done.status?.summary).toBe("first run");
    expect(events.filter((event) => event.type === "steered")).toEqual([
      { type: "steered", steer: post.id },
    ]);
    expect(cli.received.map((message) => message.priority ?? null)).toEqual([null, "next"]);
  });
});
