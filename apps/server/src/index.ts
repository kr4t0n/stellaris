import { access } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Board } from "@stellaris/board-core";
import { parseTimings, Scheduler } from "@stellaris/scheduler";
import { SERVER_TOKEN, loadServerConfig } from "@stellaris/shared";
import { RunnerHub, TurnHost } from "@stellaris/turn-host";
import pino from "pino";
import { createApp } from "./app.js";
import { ModelCatalog } from "./models.js";
import { TurnHub } from "./turn-hub.js";

const VERSION = "0.0.0";

const config = loadServerConfig(process.env);
const log = pino({ level: config.logLevel });
const board = await Board.open(config.dataDir);
const mcpUrl = `${config.publicUrl ?? SERVER_TOKEN}/mcp`;
const turns = new TurnHub();

// The server runs no turns: it prepares each one as a job for a runner that connected to it.
const host = new TurnHost({
  board,
  mcpUrl,
  turnTimeoutMs: config.turnTimeoutMs,
  maxTurns: config.toolRounds,
  residentIdleMs: config.residentIdleMs,
  log,
  onEvent: (agent, scope, event, thread) => {
    turns.push(agent, scope, event, thread);
    log.debug({ agent, scope, thread, event }, "agent event");
  },
});
const runners = new RunnerHub({ board, host, version: VERSION, log });

const concurrency = config.concurrency ?? Number.POSITIVE_INFINITY;
// Timings are JSON in one variable, for example {"opsIntervalMs":60000}; unset keys keep their defaults.
const timings = parseTimings(JSON.parse(process.env["STELLARIS_TIMINGS"] ?? "{}"));
const scheduler = new Scheduler({ board, runner: runners, log, concurrency, timings });

// What the API shows: the scheduler's queues and the runners' warm sessions, read live.
const view = {
  get pendingPairs() {
    return scheduler.pendingPairs;
  },
  get runningPairs() {
    return scheduler.runningPairs;
  },
  get residentPairs() {
    return runners.residentPairs;
  },
  get activeSignals() {
    return scheduler.activeSignals;
  },
};
// The built interface sits beside the server in the monorepo. It is read on every request, so a
// build made after the server started is served without a restart.
const webDir =
  process.env["STELLARIS_WEB_DIR"] ?? path.resolve(import.meta.dirname, "../../web/dist");
const webBuilt = await access(path.join(webDir, "index.html")).then(
  () => true,
  () => false,
);
const app = createApp({
  board,
  version: VERSION,
  turns,
  scheduler: view,
  models: new ModelCatalog((cli) => runners.models(cli)),
  runners,
  webDir,
});
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log.info(
    { host: info.address, port: info.port, dataDir: config.dataDir, mcpUrl, webDir, webBuilt },
    "board server listening",
  );
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
  log.info({ signal }, "shutting down; waiting for running turns to report");
  // The runners keep posting while the scheduler drains, so the server answers until then.
  await scheduler.stop();
  await runners.close();
  server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
