import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Board } from "@stellaris/board-core";
import { LocalRunner } from "@stellaris/runner-core";
import { Scheduler } from "@stellaris/scheduler";
import { createApp } from "../app.js";
import { TurnHub } from "../turn-hub.js";
import { OWNER, ScriptedBackend } from "./scripted-backend.js";

export interface ScriptedServer {
  readonly url: string;
  readonly ownerToken: string;
  readonly dataDir: string;
  stop(): Promise<void>;
}

/**
 * A whole board server on a fresh society with the scripted backend standing in for the CLIs:
 * what the browser session in CI drives. Everything but the agents is the production path,
 * including the built UI served from disk and the scheduler on a short poll.
 */
export async function startScriptedServer(options: {
  readonly port: number;
  readonly staticDir: string;
}): Promise<ScriptedServer> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "stellaris-e2e-"));
  const { board, ownerToken } = await Board.init(dataDir, { name: "playground" });
  await board.addProject(OWNER, { slug: "demo", name: "Demo" });
  await board.addAgent(OWNER, {
    name: "eng-1",
    role: "engineer",
    cli: "claude",
    memberships: ["demo"],
  });
  await board.addAgent(OWNER, {
    name: "rev-1",
    role: "reviewer",
    cli: "claude",
    memberships: ["demo"],
  });
  await board.addAgent(OWNER, { name: "desk", role: "concierge", cli: "claude" });
  const turns = new TurnHub();
  // The API reads the scheduler's queues live, through getters, as the real server does.
  let scheduler: Scheduler | null = null;
  const view = {
    get pendingPairs() {
      return scheduler?.pendingPairs ?? [];
    },
    get runningPairs() {
      return scheduler?.runningPairs ?? [];
    },
    get residentPairs() {
      return runner.residentPairs;
    },
    get activeSignals() {
      return scheduler?.activeSignals ?? [];
    },
  };
  const app = createApp({
    board,
    version: "e2e",
    turns,
    scheduler: view,
    staticDir: options.staticDir,
  });
  const mcpUrl = `http://127.0.0.1:${options.port}/mcp`;
  const backend = new ScriptedBackend(app, 3_000);
  const runner = new LocalRunner({
    board,
    mcpUrl,
    backends: { claude: backend, codex: backend },
    onEvent: (agent, project, event) => turns.push(agent, project, event),
  });
  scheduler = new Scheduler({
    board,
    runner,
    concurrency: 2,
    timings: {
      pollMs: 200,
      debounceMs: 0,
      ownerDebounceMs: 0,
      heartbeatMs: 3_600_000,
      unclaimedTaskMs: 3_600_000,
    },
  });
  const server = serve({ fetch: app.fetch, port: options.port, hostname: "127.0.0.1" });
  await board.markRunner("local", { status: "connected", clis: ["claude"], capabilities: [] });
  await scheduler.start();
  return {
    url: `http://127.0.0.1:${options.port}`,
    ownerToken,
    dataDir,
    async stop() {
      await scheduler.stop();
      await runner.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
