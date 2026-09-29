import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexExecBackend, type SpawnCodex } from "./exec.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/**
 * A stream recorded from a live Codex turn on 2026-09-28: the engineer's resumed thread after the
 * reviewer approved its task. Protocol drift in a future Codex release fails here, not in production.
 */
describe("recorded Codex stream", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "stellaris-codex-rec-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("replays a resumed turn to a completed status", async () => {
    const stream = await readFile(path.join(fixtures, "exec-resume-recorded.jsonl"), "utf8");
    const spawn: SpawnCodex = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const exited = new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve) => {
        setTimeout(() => {
          stdout.end(stream);
          stderr.end();
          resolve({ exitCode: 0, timedOut: false });
        }, 5);
      });
      return { stdout, stderr, exited, kill() {} };
    };
    const result = await new CodexExecBackend({ spawn }).runTurn({
      spec: {
        agent: "eng-1",
        project: "demo",
        cli: "codex",
        runner: "server",
        cwd: home,
        repoDir: home,
        configHome: home,
        boardDir: home,
      },
      session: "01a0e808-3c55-7203-9fd9-1bcb2d3c7804",
      newSession: false,
      prompt: "Digest.",
      instructions: "# eng-1",
      mcp: { url: "http://127.0.0.1:4712/mcp", token: "t" },
      limits: { timeoutMs: 60_000 },
      statusSchema: { type: "object" },
      env: {},
    });
    expect(result.exitReason).toBe("completed");
    expect(result.session).toBe("01a0e808-3c55-7203-9fd9-1bcb2d3c7804");
    expect(result.status?.summary).toContain("merged agent/eng-1");
    expect(result.status?.needsUserDecision).toBe(false);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });
});
