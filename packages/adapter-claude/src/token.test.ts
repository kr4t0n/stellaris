import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { TurnRequest } from "@stellaris/runner-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClaudeAgentBackend } from "./index.js";

const TURN_TOKEN = "stl_turn_token_of_this_test";

/**
 * A stand-in for Claude Code, which the SDK starts as it would the CLI: it writes down its command
 * line, the first line the SDK writes to its input, and the two tokens its environment holds, then
 * exits, so the turn fails.
 */
const STAND_IN = `import { writeFileSync } from "node:fs";
let input = "";
const done = () => {
  writeFileSync(process.env.STAND_IN_OUT, JSON.stringify({
    args: process.argv.slice(2),
    input: input.split("\\n")[0],
    agentToken: process.env.STELLARIS_AGENT_TOKEN ?? null,
    runnerToken: process.env.STELLARIS_RUNNER_TOKEN ?? null,
  }));
  process.exit(1);
};
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input.includes("\\n")) done();
});
process.stdin.on("end", done);
`;

const StartedSchema = z.object({
  args: z.array(z.string()),
  input: z.string(),
  agentToken: z.string().nullable(),
  runnerToken: z.string().nullable(),
});

const InitializeSchema = z.object({
  type: z.literal("control_request"),
  request: z.object({
    subtype: z.literal("initialize"),
    mcpServers: z
      .object({
        board: z.object({ url: z.string(), headers: z.object({ Authorization: z.string() }) }),
      })
      .optional(),
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

  /** Starts a turn on the stand-in and reads back how the SDK started it. */
  async function startStandIn(): Promise<z.infer<typeof StartedSchema>> {
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

    return StartedSchema.parse(JSON.parse(await readFile(out, "utf8")));
  }

  it("reaches the CLI through its environment, never its command line or input, and the runner's token not at all", async () => {
    const started = await startStandIn();
    expect(started.args.join(" ")).not.toContain(TURN_TOKEN);
    expect(started.input).not.toContain(TURN_TOKEN);
    expect(started.agentToken).toBe(TURN_TOKEN);
    expect(started.runnerToken).toBeNull();
  });

  it("names the board's server in the initialize request on the CLI's input, never its command line", async () => {
    const started = await startStandIn();
    expect(started.args).not.toContain("--mcp-config");
    expect(started.args.join(" ")).not.toContain("127.0.0.1:4700");
    const initialize = InitializeSchema.parse(JSON.parse(started.input));
    expect(initialize.request.mcpServers?.board.url).toBe("http://127.0.0.1:4700/mcp");
    // Claude Code fills the variable in as it connects (checked against 2.1.332).
    expect(initialize.request.mcpServers?.board.headers.Authorization).toBe(
      "Bearer ${STELLARIS_AGENT_TOKEN}",
    );
  });
});

/** A server on a free port of 127.0.0.1, answering every request with `answer`. */
async function listen(
  answer: (request: { method: string; authorization: string | undefined }) => {
    status: number;
    body: string;
  },
): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const { status, body } = answer({
        method: request.method ?? "",
        authorization: request.headers.authorization,
      });
      response.writeHead(status, { "content-type": "application/json" }).end(body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stub server has no port");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe("the Claude Code the SDK ships", () => {
  const servers: Server[] = [];
  let dir: string | undefined;

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.close();
    }
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("fills the board header in from its environment as it connects", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-claude-cli-"));
    // The model's API refuses every request, so the turn ends before any model call answers.
    const api = await listen(({ method }) =>
      method === "GET"
        ? { status: 200, body: '{"data":[]}' }
        : {
            status: 400,
            body: '{"type":"error","error":{"type":"invalid_request_error","message":"stub"}}',
          },
    );
    const received: Array<string | undefined> = [];
    const board = await listen(({ authorization }) => {
      received.push(authorization);
      return { status: 401, body: "" };
    });
    servers.push(api.server, board.server);
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
      session: "4f1d6c4e-2b8a-4c3e-9a51-7d0f3e6b2c19",
      newSession: true,
      prompt: "Digest.",
      instructions: "# eng-1",
      mcp: { url: `${board.url}/mcp`, token: TURN_TOKEN },
      limits: { timeoutMs: 25_000, maxTurns: 2 },
      statusSchema: { type: "object" },
    };

    // A home of its own, so the CLI reads no login of the machine's, a key the stub takes, and a
    // proxy where nothing listens for every address but 127.0.0.1, so nothing else leaves. Each
    // in both cases: the CLI reads a lowercase name, as the machine's may set, before the other.
    await new ClaudeAgentBackend({
      env: {
        HOME: dir,
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-stub",
        ANTHROPIC_AUTH_TOKEN: undefined,
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1",
        https_proxy: "http://127.0.0.1:9",
        http_proxy: "http://127.0.0.1:9",
        all_proxy: "http://127.0.0.1:9",
        no_proxy: "127.0.0.1",
      },
    })
      .runTurn(request)
      .catch(() => undefined);

    expect(received.length).toBeGreaterThan(0);
    expect(new Set(received)).toEqual(new Set([`Bearer ${TURN_TOKEN}`]));
  });
});
