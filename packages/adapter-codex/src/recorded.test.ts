import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { TurnControl, type TurnRequest } from "@stellaris/runner-core";
import { turnStatusJsonSchema, type AgentEvent } from "@stellaris/shared";
import { describe, expect, it, vi } from "vitest";
import type { SpawnAppServer } from "./app-server.js";
import { CodexBackend } from "./backend.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** Where the recorded turn starts: an update before it is about the thread's earlier turns. */
function turnStart(lines: readonly string[]): number {
  return lines.findIndex((each) => each.includes('"method":"turn/started"'));
}

function isResponse(line: string): boolean {
  return /^\{"id":\d+,"result"/.test(line);
}

/**
 * Replays what a real server wrote: each request is answered by the recorded response with its
 * id, followed by the notifications recorded after it. The client numbers its requests the same
 * way on every run, so the ids line up.
 */
async function replay(
  fixture: string,
  keep: (line: string, index: number, lines: readonly string[]) => boolean = () => true,
): Promise<{ spawn: SpawnAppServer; methods: string[] }> {
  const lines = (await readFile(path.join(fixtures, fixture), "utf8"))
    .trim()
    .split("\n")
    .filter(keep);
  const methods: string[] = [];
  const spawn: SpawnAppServer = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const { promise: exited, resolve: exit } = Promise.withResolvers<number | null>();
    let at = 0;
    stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const message: unknown = JSON.parse(line);
        if (typeof message !== "object" || message === null) continue;
        if ("method" in message && typeof message.method === "string") methods.push(message.method);
        if (!("id" in message)) continue;
        const answer = lines.findIndex((each, index) => index >= at && isResponse(each));
        let end = answer + 1;
        while (end < lines.length && !isResponse(lines[end] ?? "")) end += 1;
        stdout.write(`${lines.slice(at, end).join("\n")}\n`);
        at = end;
      }
    });
    return { stdin, stdout, stderr: new PassThrough(), exited, kill: () => exit(null) };
  };
  return { spawn, methods };
}

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
      cli: "codex",
      runner: "server",
      cwd: "/tmp/codex-probe/wt",
      repoDir: "/tmp/codex-probe/wt",
      configHome: "/tmp/codex-probe",
      boardDir: "/tmp/codex-probe",
    },
    session: "pending-1",
    newSession: true,
    prompt: "",
    instructions: "You are a probe for an adapter test.",
    mcp: { url: "http://127.0.0.1:9/mcp", token: "probe" },
    limits: { timeoutMs: 60_000 },
    statusSchema: turnStatusJsonSchema(),
    ...overrides,
  };
}

/**
 * Two turns recorded from `codex app-server` 0.156 on 2026-09-29: a new thread that ran one
 * command, then the same thread resumed. Protocol drift in a future release fails here first.
 */
describe("recorded Codex app-server turns", () => {
  it("replays a turn on a new thread", async () => {
    const { spawn, methods } = await replay("app-server-start-recorded.jsonl");
    const result = await new CodexBackend({ spawn }).runTurn(request({}));
    expect(methods).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(result.exitReason).toBe("completed");
    expect(result.session).toBe("01a0edff-8584-7ee1-91f8-6e8d4549a794");
    expect(result.model).toBe("gpt-6-astra");
    expect(result.status?.summary).toBe("echoed");
    expect(result.events.filter((e) => e.type === "tool_call")).toEqual([
      {
        type: "tool_call",
        name: "Bash",
        input: { command: "/bin/bash -lc 'echo stellaris-fixture'" },
      },
    ]);
    // Two requests: the thread's totals, with the cached input counted apart.
    expect(result.usage).toEqual({
      inputTokens: 18_712,
      outputTokens: 78,
      cacheReadTokens: 18_176,
      cacheWriteTokens: 0,
    });
    // How large the thread had grown: the latest request's whole input, its cached input within it.
    expect(result.contextTokens).toBe(18_495);
  });

  it("replays a turn on a resumed thread", async () => {
    const { spawn, methods } = await replay("app-server-resume-recorded.jsonl");
    const result = await new CodexBackend({ spawn }).runTurn(
      request({ session: "01a0edff-8584-7ee1-91f8-6e8d4549a794", newSession: false }),
    );
    expect(methods).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);
    expect(result.exitReason).toBe("completed");
    expect(result.session).toBe("01a0edff-8584-7ee1-91f8-6e8d4549a794");
    expect(result.status?.summary).toBe("stellaris-fixture");
    expect(result.events.map((e) => e.type)).toEqual(["turn_started", "text", "turn_completed"]);
    // The thread reports its totals on resuming; only what grew after counts for this turn.
    expect(result.usage).toEqual({
      inputTokens: 252,
      outputTokens: 85,
      cacheReadTokens: 18_304,
      cacheWriteTokens: 0,
    });
    expect(result.contextTokens).toBe(18_556);
  });

  it("measures a resumed thread by the turn's own requests, never by its previous turn's", async () => {
    // The update the server sends on resuming is about the thread's previous turn; with the turn's
    // own update gone, nothing says how large the thread is now.
    const { spawn } = await replay(
      "app-server-resume-recorded.jsonl",
      (line, index, lines) =>
        !(line.includes('"method":"thread/tokenUsage/updated"') && index > turnStart(lines)),
    );
    const result = await new CodexBackend({ spawn }).runTurn(
      request({ session: "01a0edff-8584-7ee1-91f8-6e8d4549a794", newSession: false }),
    );
    expect(result.exitReason).toBe("completed");
    expect(result.contextTokens).toBeUndefined();
  });

  it("replays a resumed turn whose thread's totals never came, counting the same", async () => {
    // Without the update the server sends right after `thread/resume` about the thread's last turn,
    // as a live 0.158.0 once sent none, the turn's own first update says where the thread stood.
    const { spawn } = await replay(
      "app-server-resume-recorded.jsonl",
      (line, index, lines) =>
        !(line.includes('"method":"thread/tokenUsage/updated"') && index < turnStart(lines)),
    );
    const result = await new CodexBackend({ spawn }).runTurn(
      request({ session: "01a0edff-8584-7ee1-91f8-6e8d4549a794", newSession: false }),
    );
    expect(result.exitReason).toBe("completed");
    expect(result.usage).toEqual({
      inputTokens: 252,
      outputTokens: 85,
      cacheReadTokens: 18_304,
      cacheWriteTokens: 0,
    });
  });

  /**
   * A turn recorded from `codex app-server` 0.156 on 2026-10-07: it ran a 30-second command, the
   * user's post arrived meanwhile as `turn/steer`, and it came back as a user message carrying the
   * steer's id once the command finished, before the turn acted on it.
   */
  it("replays a steered turn: the post arrives as a user message with the steer's id", async () => {
    const { spawn, methods } = await replay("app-server-steered-recorded.jsonl");
    const steerId = "ca202c2d-eb92-4f42-8eb3-78bd25d482bb";
    const control = new TurnControl();
    const events: AgentEvent[] = [];
    const running = new CodexBackend({ spawn }).runTurn(
      request({}),
      (event) => events.push(event),
      control,
    );
    await vi.waitFor(async () =>
      expect(await control.steer({ id: steerId, text: "end your post with PINEAPPLE" })).toBe(true),
    );
    const result = await running;

    expect(methods).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "turn/steer",
    ]);
    expect(result.exitReason).toBe("completed");
    const steps = events.map((event) =>
      event.type === "tool_call" || event.type === "tool_result"
        ? `${event.type}:${event.name}`
        : event.type,
    );
    const steered = steps.indexOf("steered");
    expect(events[steered]).toEqual({ type: "steered", steer: steerId });
    expect(steps.slice(steered)).toContain("tool_call:mcp__board__post_message");
    expect(result.finalText).toContain("PINEAPPLE");
    // Five requests, where the last alone holds 30,630 input tokens.
    expect(result.usage).toEqual({
      inputTokens: 5_313,
      outputTokens: 307,
      cacheReadTokens: 146_048,
      cacheWriteTokens: 0,
    });
    expect(result.contextTokens).toBe(30_630);
  });

  /**
   * A turn recorded from `codex app-server` 0.165.0 on 2026-11-04 against a stub of the model
   * service and of the board, which scripted the model's calls: `read_image`, `view_image` on the
   * file it named, `view_image` on a file that does not exist, then the status. Codex reports an
   * image it opened as an `imageView` item only once the file was read as an image; the missing
   * one went back to the model as an error and left no item, so it shows no step.
   */
  it("replays a turn that opens an image: the board's read, then Codex's view of the file", async () => {
    const { spawn, methods } = await replay("app-server-image-recorded.jsonl");
    const result = await new CodexBackend({ spawn }).runTurn(request({}));
    expect(methods).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(result.exitReason).toBe("completed");
    expect(result.status?.summary).toBe("viewed");
    const file =
      "/tmp/stellaris-images-01BX5ZZKBKACTAV9WEVGEMMVRZ-Qx7mWk/01ARZ3NDEKTSV4RRFFQ69G5FAV.png";
    expect(stepsOf(result.events)).toEqual([
      ["call", "mcp__board__read_image", { image_id: "image:01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
      ["result", "mcp__board__read_image", true, expect.stringContaining(file)],
      ["call", "Read", { path: file }],
      ["result", "Read", true, "[image]"],
    ]);
  });

  /**
   * Two turns recorded from `codex app-server` 0.165.0 on 2026-11-04 against a stub of the model
   * service, which scripted the model's sub-agent calls and gave each request its own usage: 1,000
   * input (400 cached) and 50 output for the parent, 7,000 and 70 for the sub-agent, which ran
   * `ls` on its first task. With `multi_agent`, Codex's default, every call comes as a
   * `collabAgentToolCall`; with `multi_agent_v2`, which the live models' metadata names, only a
   * wait does, and a call that starts, messages, or interrupts a sub-agent comes as a
   * `subAgentActivity`, as does the end of the sub-agent's turn, which is no call, and
   * `list_agents` comes as nothing.
   */
  it("replays a turn's multi_agent calls as one step each, none of the sub-agent's own", async () => {
    const { spawn } = await replay("app-server-subagents-v1-recorded.jsonl");
    const result = await new CodexBackend({ spawn }).runTurn(request({}));
    expect(result.exitReason).toBe("completed");
    expect(result.status?.summary).toBe("delegated");
    const agent = "01a1a5f7-38dc-79f1-b4b3-abdafc63627d";
    expect(stepsOf(result.events)).toEqual([
      ["call", "Agent", { prompt: "SUBTASK: list the files in the worktree" }],
      ["result", "Agent", true, `${agent}: pendingInit`],
      ["call", "wait_agent", { targets: [agent] }],
      ["result", "wait_agent", true, `${agent}: completed\nREADME.md`],
      ["call", "SendMessage", { to: agent, message: "FOLLOWUP: now count them" }],
      ["result", "SendMessage", true, `${agent}: completed\nREADME.md`],
      ["call", "wait_agent", { targets: [agent] }],
      ["result", "wait_agent", true, `${agent}: completed\nThere is 1 file.`],
      ["call", "TaskStop", { task_id: agent }],
      ["result", "TaskStop", true, `${agent}: completed\nThere is 1 file.`],
      ["call", "resume_agent", { id: agent }],
      ["result", "resume_agent", true, `${agent}: pendingInit`],
      ["call", "TaskStop", { task_id: agent }],
      ["result", "TaskStop", true, `${agent}: pendingInit`],
    ]);
    // Eight parent requests and the sub-agent's three, as the stub answered them.
    expect(result.usage).toEqual({
      inputTokens: 25_800,
      outputTokens: 610,
      cacheReadTokens: 3_200,
      cacheWriteTokens: 0,
    });
  });

  it("replays a turn's multi_agent_v2 calls as one step each, none for a sub-agent's end", async () => {
    const { spawn } = await replay("app-server-subagents-v2-recorded.jsonl");
    const result = await new CodexBackend({ spawn }).runTurn(request({}));
    expect(result.exitReason).toBe("completed");
    expect(result.status?.summary).toBe("delegated");
    expect(stepsOf(result.events)).toEqual([
      ["call", "Agent", { name: "/root/lister" }],
      ["result", "Agent", true, undefined],
      ["call", "wait_agent", { targets: [] }],
      ["result", "wait_agent", true, undefined],
      // `followup_task`, then `send_message`, which Codex reports alike.
      ["call", "SendMessage", { to: "/root/lister" }],
      ["result", "SendMessage", true, undefined],
      ["call", "wait_agent", { targets: [] }],
      ["result", "wait_agent", true, undefined],
      ["call", "SendMessage", { to: "/root/lister" }],
      ["result", "SendMessage", true, undefined],
      ["call", "TaskStop", { task_id: "/root/lister" }],
      ["result", "TaskStop", true, undefined],
    ]);
    expect(result.usage).toEqual({
      inputTokens: 25_800,
      outputTokens: 610,
      cacheReadTokens: 3_200,
      cacheWriteTokens: 0,
    });
  });

  it("counts a request whose only item is a command still running when its update comes", async () => {
    // The same turn resumed with no totals before it, and without its opening message, so the
    // first request answers with a command alone: it starts, the request's update follows, and it
    // completes requests later.
    const { spawn } = await replay("app-server-steered-recorded.jsonl", (line, index, lines) => {
      if (line.includes('"method":"thread/tokenUsage/updated"') && index < turnStart(lines)) {
        return false;
      }
      return !line.includes("msg_0b5fa85dcceaa350016ac65406efbc87d0b522610d734f7034");
    });
    const control = new TurnControl();
    const running = new CodexBackend({ spawn }).runTurn(
      request({ session: "01a116b8-0838-7542-905b-d37618ba329e", newSession: false }),
      undefined,
      control,
    );
    await vi.waitFor(async () =>
      expect(await control.steer({ id: "ca202c2d-eb92-4f42-8eb3-78bd25d482bb", text: "" })).toBe(
        true,
      ),
    );
    const result = await running;
    expect(result.exitReason).toBe("completed");
    expect(result.usage).toEqual({
      inputTokens: 5_313,
      outputTokens: 307,
      cacheReadTokens: 146_048,
      cacheWriteTokens: 0,
    });
  });
});
