import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { TurnRequest } from "@stellaris/runner-core";
import { turnStatusJsonSchema } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import type { SpawnAppServer } from "./app-server.js";
import { CodexBackend } from "./backend.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function isResponse(line: string): boolean {
  return /^\{"id":\d+,"result"/.test(line);
}

/**
 * Replays what a real server wrote: each request is answered by the recorded response with its
 * id, followed by the notifications recorded after it. The client numbers its requests the same
 * way on every run, so the ids line up.
 */
async function replay(fixture: string): Promise<{ spawn: SpawnAppServer; methods: string[] }> {
  const lines = (await readFile(path.join(fixtures, fixture), "utf8")).trim().split("\n");
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
    env: {},
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
    expect(result.usage.outputTokens).toBeGreaterThan(0);
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
  });
});
