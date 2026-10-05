#!/usr/bin/env node
import { ClaudeAgentBackend } from "@stellaris/adapter-claude";
import { CodexBackend, CodexSandboxSchema } from "@stellaris/adapter-codex";
import {
  RunnerHttpError,
  RunnerLayout,
  createRunner,
  enrollRunner,
  forgetCredentials,
  readCredentials,
  saveCredentials,
  type AgentBackend,
  type RunnerDaemon,
} from "@stellaris/runner-core";
import { STELLARIS_VERSION, loadRunnerConfig, type CliKind } from "@stellaris/shared";
import pino from "pino";

const VERSION = STELLARIS_VERSION;

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}
if (process.argv.includes("--help")) {
  console.log(
    [
      "stellaris-runner: runs a Stellaris society's turns on this machine with Claude Code and Codex.",
      "Start it with STELLARIS_SERVER_URL set to the board server: the first start prints a code",
      "to approve on the board, and the runner keeps what approval returns in STELLARIS_RUNNER_DIR",
      "(./runner-data) with its other files. STELLARIS_RUNNER_TOKEN takes a token registered on the",
      "board instead. Every setting is a STELLARIS_* variable:",
      "https://github.com/kr4t0n/stellaris#environment-variables",
    ].join("\n"),
  );
  process.exit(0);
}

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

const layout = new RunnerLayout(config.dataDir);

function fail(message: string): never {
  log.error(message);
  process.exit(1);
}

function refused(error: unknown): boolean {
  return error instanceof RunnerHttpError && error.status === 401;
}

/** Asks the board to enroll this runner, waits for the user's approval there, and keeps the token. */
async function enroll(): Promise<string> {
  const { name, token } = await enrollRunner({
    serverUrl: config.serverUrl,
    version: VERSION,
    clis: config.clis,
    capabilities: config.capabilities,
    log,
    onCode: (enrollment, approveUrl) => {
      log.info(
        { code: enrollment.userCode, url: approveUrl, expiresAt: enrollment.expiresAt },
        "waiting for the user to approve this runner on the board",
      );
      if (process.stderr.isTTY) {
        process.stderr.write(
          [
            "",
            "This runner is not enrolled yet. Approve it on the board:",
            `  ${approveUrl}`,
            `or open runners on the board and approve the code ${enrollment.userCode}.`,
            "",
            "",
          ].join("\n"),
        );
      }
    },
  }).catch((error: unknown) => fail(`could not enroll this runner: ${String(error)}`));
  await saveCredentials(layout, { serverUrl: config.serverUrl, name, token });
  log.info({ runner: name, credentials: layout.credentials }, "runner enrolled");
  return token;
}

async function connect(token: string): Promise<RunnerDaemon> {
  const daemon = createRunner({
    serverUrl: config.serverUrl,
    token,
    dataDir: config.dataDir,
    backends,
    version: VERSION,
    slots: config.slots,
    capabilities: config.capabilities,
    log,
  });
  await daemon.start();
  return daemon;
}

let runner: RunnerDaemon;
if (config.token !== null) {
  runner = await connect(config.token).catch((error: unknown) =>
    fail(
      refused(error)
        ? "the server refused STELLARIS_RUNNER_TOKEN; register the runner again or leave the variable unset to enroll"
        : String(error),
    ),
  );
} else {
  const saved = await readCredentials(layout, config.serverUrl);
  try {
    runner = await connect(saved?.token ?? (await enroll()));
  } catch (error) {
    // Saved credentials the server no longer knows, as after the runner was removed or the
    // society created again, are replaced by a new enrollment.
    if (saved === null || !refused(error)) {
      fail(String(error));
    }
    log.warn(
      { runner: saved.name },
      "the server refused this runner's saved token; enrolling again",
    );
    await forgetCredentials(layout);
    runner = await connect(await enroll()).catch((retry: unknown) => fail(String(retry)));
  }
}
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
