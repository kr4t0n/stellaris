import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { TurnRequest } from "@stellaris/runner-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexExecBackend, PENDING_SESSION_PREFIX, type SpawnCodex } from "./exec.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

interface FakeRun {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

/** A spawn that replays a recorded stream and exits with the given code. */
function replay(
  stdoutLines: string,
  options: { exitCode?: number | null; stderr?: string; timedOut?: boolean } = {},
): { spawn: SpawnCodex; runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  const spawn: SpawnCodex = (args, spawnOptions) => {
    runs.push({ args, cwd: spawnOptions.cwd, env: spawnOptions.env });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exited = new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve) => {
      setTimeout(() => {
        stdout.end(stdoutLines);
        stderr.end(options.stderr ?? "");
        resolve({
          exitCode: options.exitCode === undefined ? 0 : options.exitCode,
          timedOut: options.timedOut ?? false,
        });
      }, 5);
    });
    return { stdout, stderr, exited, kill() {} };
  };
  return { spawn, runs };
}

describe("CodexExecBackend", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "stellaris-codex-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
    return {
      spec: {
        agent: "eng-1",
        project: "demo",
        cli: "codex",
        cwd: "/tmp/wt",
        repoDir: "/tmp/repo",
        configHome: home,
        boardDir: "/tmp/board",
      },
      session: `${PENDING_SESSION_PREFIX}abc`,
      newSession: true,
      prompt: "Do the thing.",
      instructions: "# eng-1\n\nYou are an engineer.",
      mcp: { url: "http://127.0.0.1:4700/mcp", token: "stl_turn" },
      limits: { timeoutMs: 60_000 },
      statusSchema: { type: "object" },
      env: { GIT_AUTHOR_NAME: "eng-1" },
      ...overrides,
    };
  }

  it("maps a recorded structured-output turn and reports the thread id as the session", async () => {
    const stream = await readFile(path.join(fixtures, "exec-structured-ok.jsonl"), "utf8");
    const { spawn, runs } = replay(stream);
    const backend = new CodexExecBackend({ spawn });
    const result = await backend.runTurn(request());

    expect(result.exitReason).toBe("completed");
    expect(result.session).toBe("01a0e800-6f38-7b22-9e19-5a945e0af2a6");
    expect(result.status?.summary).toBe("OK");
    expect(result.usage.inputTokens).toBe(17559);
    expect(result.events.map((e) => e.type)).toEqual(["turn_started", "text", "turn_completed"]);

    const run = runs[0];
    if (run === undefined) throw new Error("no run");
    expect(run.args.slice(0, 2)).toEqual(["exec", "--json"]);
    // Full autonomy by default: no sandbox, no approvals.
    expect(run.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(run.args).not.toContain("--sandbox");
    expect(run.args).toContain("--output-schema");
    expect(run.args).toContain(`mcp_servers.board.url="http://127.0.0.1:4700/mcp"`);
    expect(run.args).toContain('mcp_servers.board.default_tools_approval_mode="approve"');
    expect(run.args).toContain("/tmp/repo");
    expect(run.args).not.toContain("resume");
    expect(run.args.at(-1)).toContain("You are an engineer.");
    expect(run.args.at(-1)).toContain("Do the thing.");
    expect(run.env["STELLARIS_AGENT_TOKEN"]).toBe("stl_turn");
    expect(run.env["GIT_AUTHOR_NAME"]).toBe("eng-1");
    expect(run.cwd).toBe("/tmp/wt");
    const schema = await readFile(path.join(home, ".codex", "status.schema.json"), "utf8");
    expect(JSON.parse(schema)).toEqual({ type: "object" });
  });

  it("maps tool items to tool_call and tool_result events without duplicates", async () => {
    const stream = await readFile(path.join(fixtures, "exec-tools-synthetic.jsonl"), "utf8");
    const { spawn } = replay(stream);
    const result = await new CodexExecBackend({ spawn }).runTurn(request());
    const calls = result.events
      .filter((e) => e.type === "tool_call")
      .map((e) => (e.type === "tool_call" ? e.name : ""));
    expect(calls).toEqual(["Bash", "mcp__board__claim_task", "Edit", "Bash"]);
    const results = result.events
      .filter((e) => e.type === "tool_result")
      .map((e) => (e.type === "tool_result" ? e.ok : null));
    expect(results).toEqual([true, true, true, false]);
    expect(result.status?.claimsHeld).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 90,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
    });
  });

  it("resumes an existing thread with the options before the subcommand", async () => {
    const stream = await readFile(path.join(fixtures, "exec-structured-ok.jsonl"), "utf8");
    const { spawn, runs } = replay(stream);
    await new CodexExecBackend({ spawn, model: "gpt-5.3-codex" }).runTurn(
      request({ session: "01a0e800-6f38-7b22-9e19-5a945e0af2a6", newSession: false }),
    );
    const args = runs[0]?.args ?? [];
    const resumeAt = args.indexOf("resume");
    expect(resumeAt).toBeGreaterThan(0);
    expect(args[resumeAt + 1]).toBe("01a0e800-6f38-7b22-9e19-5a945e0af2a6");
    expect(args.indexOf("--dangerously-bypass-approvals-and-sandbox")).toBeLessThan(resumeAt);
    expect(args.indexOf("-m")).toBeLessThan(resumeAt);
  });

  it("keeps Codex's own sandbox when a runner asks for one", async () => {
    const stream = await readFile(path.join(fixtures, "exec-structured-ok.jsonl"), "utf8");
    const { spawn, runs } = replay(stream);
    await new CodexExecBackend({ spawn, sandbox: "workspace-write" }).runTurn(request());
    const args = runs[0]?.args ?? [];
    expect(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2)).toEqual([
      "--sandbox",
      "workspace-write",
    ]);
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("starts a fresh thread when the recorded session no longer exists", async () => {
    const stream = await readFile(path.join(fixtures, "exec-structured-ok.jsonl"), "utf8");
    let call = 0;
    const attempts: string[][] = [];
    const spawn: SpawnCodex = (args, options) => {
      attempts.push([...args]);
      call += 1;
      const first = call === 1;
      return replay(
        first ? "" : stream,
        first ? { exitCode: 1, stderr: "error: no session found with id 0000" } : {},
      ).spawn(args, options);
    };
    const result = await new CodexExecBackend({ spawn }).runTurn(
      request({ session: "0000", newSession: false }),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toContain("resume");
    expect(attempts[1]).not.toContain("resume");
    expect(result.exitReason).toBe("completed");
    expect(result.session).toBe("01a0e800-6f38-7b22-9e19-5a945e0af2a6");
  });

  it("reports timeouts and failures as such", async () => {
    const timedOut = await new CodexExecBackend({
      spawn: replay("", { timedOut: true, exitCode: null }).spawn,
    }).runTurn(request());
    expect(timedOut.exitReason).toBe("timeout");

    const failed = await new CodexExecBackend({
      spawn: replay('{"type":"turn.failed","error":{"message":"model refused"}}\n', { exitCode: 1 })
        .spawn,
    }).runTurn(request());
    expect(failed.exitReason).toBe("error");
    expect(failed.error).toBe("model refused");
  });
});
