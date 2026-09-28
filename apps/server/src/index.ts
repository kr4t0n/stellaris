import { serve } from "@hono/node-server";
import { ClaudeAgentBackend } from "@stellaris/adapter-claude";
import { CodexExecBackend, CodexSandboxSchema } from "@stellaris/adapter-codex";
import { Board } from "@stellaris/board-core";
import { LocalRunner } from "@stellaris/runner-core";
import { Scheduler } from "@stellaris/scheduler";
import { loadServerConfig } from "@stellaris/shared";
import pino from "pino";
import { createApp } from "./app.js";

const VERSION = "0.0.0";

const config = loadServerConfig(process.env);
const log = pino({ level: config.logLevel });
const board = await Board.open(config.dataDir);
const mcpUrl = `http://${config.host}:${config.port}/mcp`;

const runner = new LocalRunner({
  board,
  mcpUrl,
  backends: {
    claude: new ClaudeAgentBackend({
      stderr: (line) => log.debug({ claude: line.trimEnd() }, "cli stderr"),
      recordDir: process.env["STELLARIS_RECORD_DIR"],
    }),
    codex: new CodexExecBackend({
      stderr: (line) => log.debug({ codex: line.trimEnd() }, "cli stderr"),
      recordDir: process.env["STELLARIS_RECORD_DIR"],
      // Codex's Linux sandbox needs user namespaces; containers without them must run unsandboxed.
      sandbox: CodexSandboxSchema.parse(
        process.env["STELLARIS_CODEX_SANDBOX"] ?? "workspace-write",
      ),
    }),
  },
  log,
  onEvent: (agent, project, event) => log.debug({ agent, project, event }, "agent event"),
});

const scheduler = new Scheduler({
  board,
  runner,
  log,
  concurrency: Number(process.env["STELLARIS_CONCURRENCY"] ?? "2"),
});

const app = createApp({ board, version: VERSION });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log.info(
    { host: info.address, port: info.port, dataDir: config.dataDir, mcpUrl },
    "board server listening",
  );
});

await scheduler.start();
log.info({ concurrency: Number(process.env["STELLARIS_CONCURRENCY"] ?? "2") }, "scheduler started");

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, "shutting down; waiting for running turns");
  await scheduler.stop();
  server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
