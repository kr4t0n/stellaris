import { serve } from "@hono/node-server";
import { ClaudeAgentBackend } from "@stellaris/adapter-claude";
import { CodexBackend, CodexSandboxSchema } from "@stellaris/adapter-codex";
import { Board } from "@stellaris/board-core";
import { LocalRunner } from "@stellaris/runner-core";
import { parseTimings, Scheduler } from "@stellaris/scheduler";
import { loadServerConfig, SERVER_RUNNER } from "@stellaris/shared";
import pino from "pino";
import { createApp } from "./app.js";
import { TurnHub } from "./turn-hub.js";

const VERSION = "0.0.0";

const config = loadServerConfig(process.env);
const log = pino({ level: config.logLevel });
const board = await Board.open(config.dataDir);
const mcpUrl = `http://${config.host}:${config.port}/mcp`;
const turns = new TurnHub();

const runner = new LocalRunner({
  board,
  runnerName: SERVER_RUNNER,
  mcpUrl,
  backends: {
    claude: new ClaudeAgentBackend({
      stderr: (line) => log.debug({ claude: line.trimEnd() }, "cli stderr"),
      recordDir: process.env["STELLARIS_RECORD_DIR"],
    }),
    codex: new CodexBackend({
      stderr: (line) => log.debug({ codex: line.trimEnd() }, "cli stderr"),
      recordDir: process.env["STELLARIS_RECORD_DIR"],
      // Full access by default: no sandbox, no approvals. A runner that wants Codex's own
      // sandbox back sets STELLARIS_CODEX_SANDBOX; on Linux that needs user namespaces.
      sandbox: CodexSandboxSchema.parse(
        process.env["STELLARIS_CODEX_SANDBOX"] ?? "danger-full-access",
      ),
    }),
  },
  log,
  turnTimeoutMs: config.turnTimeoutMs,
  maxTurns: config.toolRounds,
  // Resident roles keep a warm session this long after their last turn.
  residentIdleMs: Number(process.env["STELLARIS_RESIDENT_IDLE_MS"] ?? String(10 * 60_000)),
  onEvent: (agent, project, event) => {
    turns.push(agent, project, event);
    log.debug({ agent, project, event }, "agent event");
  },
});

const concurrency = config.concurrency ?? Number.POSITIVE_INFINITY;
// Timings are JSON in one variable, for example {"opsIntervalMs":60000}; unset keys keep their defaults.
const timings = parseTimings(JSON.parse(process.env["STELLARIS_TIMINGS"] ?? "{}"));
const scheduler = new Scheduler({ board, runner, log, concurrency, timings });

// What the API shows: the scheduler's queues and the runner's warm sessions, read live.
const view = {
  get pendingPairs() {
    return scheduler.pendingPairs;
  },
  get runningPairs() {
    return scheduler.runningPairs;
  },
  get residentPairs() {
    return runner.residentPairs;
  },
  get activeSignals() {
    return scheduler.activeSignals;
  },
};
const app = createApp({ board, version: VERSION, turns, scheduler: view });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log.info(
    { host: info.address, port: info.port, dataDir: config.dataDir, mcpUrl },
    "board server listening",
  );
});

// The embedded runner is this machine. Its record is what capability signals are computed against.
const capabilities = (process.env["STELLARIS_CAPABILITIES"] ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item.length > 0);
await board.markRunner(SERVER_RUNNER, {
  status: "connected",
  clis: ["claude", "codex"],
  capabilities,
});
await scheduler.start();
log.info(
  {
    concurrency: config.concurrency ?? "unlimited",
    turnTimeoutMs: config.turnTimeoutMs ?? "unlimited",
    toolRounds: config.toolRounds ?? "unlimited",
    timings,
  },
  "scheduler started",
);

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, "shutting down; waiting for running turns");
  await scheduler.stop();
  await runner.close();
  await board.markRunner(SERVER_RUNNER, { status: "disconnected" }).catch((error: unknown) => {
    log.warn({ error: String(error) }, "could not record runner shutdown");
  });
  server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
