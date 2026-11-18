import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TurnRequest } from "@stellaris/runner-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClaudeAgentBackend } from "./index.js";

const TURN_TOKEN = "stl_turn_token_of_this_test";

/**
 * A stand-in for Claude Code, which the SDK starts as it would the CLI: it writes down its command
 * line and the two tokens its environment holds, then exits, so the turn fails.
 */
const STAND_IN = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.STAND_IN_OUT, JSON.stringify({
  args: process.argv.slice(2),
  agentToken: process.env.STELLARIS_AGENT_TOKEN ?? null,
  runnerToken: process.env.STELLARIS_RUNNER_TOKEN ?? null,
}));
process.exit(1);
`;

const StartedSchema = z.object({
  args: z.array(z.string()),
  agentToken: z.string().nullable(),
  runnerToken: z.string().nullable(),
});

const McpConfigSchema = z.object({
  mcpServers: z.object({
    board: z.object({ url: z.string(), headers: z.object({ Authorization: z.string() }) }),
  }),
});

describe("the board token a Claude turn starts with", () => {
  let dir: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("reaches the CLI through its environment, never its command line, and the runner's token not at all", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-claude-token-"));
    const cli = path.join(dir, "claude.mjs");
    const out = path.join(dir, "started.json");
    await writeFile(cli, STAND_IN, "utf8");
    vi.stubEnv("STELLARIS_RUNNER_TOKEN", "stl_runner_token_of_this_test");
    const request: TurnRequest = {
      spec: {
        agent: "eng-1",
        project: "demo",
        cli: "claude",
        runner: "server",
        cwd: dir,
        repoDir: dir,
        configHome: dir,
        boardDir: dir,
      },
      session: "92132dad-48ca-450a-a7e7-82f8b2ab9b24",
      newSession: true,
      prompt: "Digest.",
      instructions: "# eng-1",
      mcp: { url: "http://127.0.0.1:4700/mcp", token: TURN_TOKEN },
      limits: { timeoutMs: 30_000, maxTurns: 10 },
      statusSchema: { type: "object" },
    };

    // The real SDK starts the stand-in, which ends at once; only how it was started matters here.
    await new ClaudeAgentBackend({ pathToClaudeCodeExecutable: cli, env: { STAND_IN_OUT: out } })
      .runTurn(request)
      .catch(() => undefined);

    const started = StartedSchema.parse(JSON.parse(await readFile(out, "utf8")));
    expect(started.args.join(" ")).not.toContain(TURN_TOKEN);
    const config = McpConfigSchema.parse(
      JSON.parse(started.args[started.args.indexOf("--mcp-config") + 1] ?? "null"),
    );
    // Claude Code fills the variable in as it connects (checked against 2.1.312).
    expect(config.mcpServers.board.headers.Authorization).toBe("Bearer ${STELLARIS_AGENT_TOKEN}");
    expect(started.agentToken).toBe(TURN_TOKEN);
    expect(started.runnerToken).toBeNull();
  });
});
