#!/usr/bin/env node
import { ClaudeAgentBackend } from "@stellaris/adapter-claude";
import { CodexBackend, CodexSandboxSchema } from "@stellaris/adapter-codex";
import { createRunner, type AgentBackend } from "@stellaris/runner-core";
import { loadRunnerConfig, type CliKind } from "@stellaris/shared";
import pino from "pino";

const VERSION = "0.0.0";

const config = loadRunnerConfig(process.env);
const log = pino({ level: config.logLevel });
const recordDir = process.env["STELLARIS_RECORD_DIR"];

const backends: Partial<Record<CliKind, AgentBackend>> = {};
if (config.clis.includes("claude")) {
  backends.claude = new ClaudeAgentBackend({
    stderr: (line) => log.debug({ claude: line.trimEnd() }, "cli stderr"),
    recordDir,
  });
}
if (config.clis.includes("codex")) {
  backends.codex = new CodexBackend({
    stderr: (line) => log.debug({ codex: line.trimEnd() }, "cli stderr"),
    recordDir,
    // Full access by default: no sandbox, no approvals. A runner that wants Codex's own
    // sandbox back sets STELLARIS_CODEX_SANDBOX; on Linux that needs user namespaces.
    sandbox: CodexSandboxSchema.parse(
      process.env["STELLARIS_CODEX_SANDBOX"] ?? "danger-full-access",
    ),
  });
}

const runner = createRunner({
  serverUrl: config.serverUrl,
  token: config.token,
  dataDir: config.dataDir,
  backends,
  version: VERSION,
  slots: config.slots,
  capabilities: config.capabilities,
  log,
});
await runner.start();
log.info(
  {
    runner: runner.name,
    server: config.serverUrl,
    dataDir: config.dataDir,
    clis: config.clis,
    slots: config.slots ?? "unlimited",
    capabilities: config.capabilities,
  },
  "runner started",
);

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, "runner shutting down; waiting for running turns");
  await runner.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
