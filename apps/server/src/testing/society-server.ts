import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Board } from "@stellaris/board-core";
import { LocalRunner } from "@stellaris/runner-core";
import { Scheduler } from "@stellaris/scheduler";
import { SERVER_RUNNER } from "@stellaris/shared";
import { z } from "zod";
import { createApp } from "../app.js";
import { TurnHub } from "../turn-hub.js";
import { addWorkRoles, ScriptedBackend, USER } from "./scripted-backend.js";

export interface SocietyServer {
  readonly url: string;
  stop(): Promise<void>;
}

interface Held {
  readonly moment: string;
  readonly release: () => void;
}

const ReleaseSchema = z.object({ agent: z.string() });

/**
 * A whole board server on a fresh society, with scripted citizens standing in for the CLIs: what
 * the browser session of Phase 7's exit test drives. Everything else is the production path: the
 * API, the event and turn streams, the scheduler on its own loop, the runner with real git and
 * merges, and the built interface served from disk.
 *
 * A scripted turn stops at its checkpoint until the test releases it, so the browser can look at
 * the sky while the turn is running. Two routes exist only here: `POST /test/token` hands over the
 * user token, and `POST /test/release` lets the named citizen's held turn go on, answering 409
 * while it has none.
 */
export async function startSocietyServer(options: {
  /** 0 for any free port, so each browser session can have a society of its own. */
  readonly port: number;
  readonly webDir: string;
}): Promise<SocietyServer> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "stellaris-society-"));
  const { board, userToken } = await Board.init(dataDir, { name: "exit-test" });
  await board.addProject(USER, { slug: "demo", name: "Demo", onDone: "merge" });
  await addWorkRoles(board);
  await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
  await board.addAgent(USER, {
    name: "eng-1",
    role: "engineer",
    cli: "codex",
    memberships: ["demo"],
  });
  await board.addAgent(USER, {
    name: "rev-1",
    role: "reviewer",
    cli: "claude",
    memberships: ["demo"],
  });

  // Onboarding runs through before anyone watches; after that every checkpoint holds.
  let holding = false;
  const held = new Map<string, Held[]>();
  const checkpoint = (agent: string, moment: string): Promise<void> =>
    holding
      ? new Promise((resolve) => {
          held.set(agent, [...(held.get(agent) ?? []), { moment, release: resolve }]);
        })
      : Promise.resolve();

  const turns = new TurnHub();
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
    version: "exit-test",
    turns,
    scheduler: view,
    webDir: options.webDir,
  });
  app.post("/test/token", (c) => c.json({ token: userToken }));
  app.post("/test/release", async (c) => {
    const { agent } = ReleaseSchema.parse(await c.req.json());
    const [first, ...rest] = held.get(agent) ?? [];
    if (first === undefined) {
      return c.json({ held: false }, 409);
    }
    held.set(agent, rest);
    first.release();
    return c.json({ released: first.moment });
  });

  const server = serve({ fetch: app.fetch, port: options.port, hostname: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : options.port}`;

  const backend = new ScriptedBackend(app, checkpoint);
  const runner = new LocalRunner({
    board,
    runnerName: SERVER_RUNNER,
    mcpUrl: `${url}/mcp`,
    backends: { claude: backend, codex: backend },
    residentIdleMs: 60_000,
    onEvent: (agent, project, event, thread) => turns.push(agent, project, event, thread),
  });
  scheduler = new Scheduler({
    board,
    runner,
    concurrency: 4,
    timings: {
      pollMs: 200,
      debounceMs: 0,
      userDebounceMs: 0,
      heartbeatMs: 3_600_000,
      waitingStageMs: 3_600_000,
    },
  });
  await board.markRunner(SERVER_RUNNER, {
    status: "connected",
    clis: ["claude", "codex"],
    capabilities: [],
  });
  for (let round = 0; round < 3; round += 1) {
    await scheduler.tick();
    await scheduler.drain();
  }
  holding = true;
  await scheduler.start();

  return {
    url,
    async stop() {
      for (const each of held.values()) {
        for (const turn of each) {
          turn.release();
        }
      }
      await scheduler?.stop();
      await runner.close();
      // The page's event streams never end on their own, and close() waits for every connection.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      if ("closeAllConnections" in server) {
        server.closeAllConnections();
      }
      await closed;
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
