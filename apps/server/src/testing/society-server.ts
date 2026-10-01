import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { Scheduler } from "@stellaris/scheduler";
import { z } from "zod";
import { startTestSociety } from "./harness.js";
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
 * API, the event and turn streams, the scheduler on its own loop, a runner connected over the
 * runner protocol with real git and merges, and the built interface served from disk.
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

  let scheduler: Scheduler | null = null;
  const society = await startTestSociety({
    board,
    port: options.port,
    webDir: options.webDir,
    backends: (app) => {
      const backend = new ScriptedBackend(app, checkpoint);
      return { claude: backend, codex: backend };
    },
    scheduler: {
      get pendingPairs() {
        return scheduler?.pendingPairs ?? [];
      },
      get runningPairs() {
        return scheduler?.runningPairs ?? [];
      },
      get residentPairs() {
        return society.hub.residentPairs;
      },
      get activeSignals() {
        return scheduler?.activeSignals ?? [];
      },
    },
    routes: (app) => {
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
    },
  });
  scheduler = new Scheduler({
    board,
    runner: society.hub,
    concurrency: 4,
    timings: {
      pollMs: 200,
      debounceMs: 0,
      userDebounceMs: 0,
      heartbeatMs: 3_600_000,
      waitingStageMs: 3_600_000,
    },
  });
  for (let round = 0; round < 3; round += 1) {
    await scheduler.tick();
    await scheduler.drain();
  }
  holding = true;
  await scheduler.start();

  return {
    url: society.url,
    async stop() {
      for (const each of held.values()) {
        for (const turn of each) {
          turn.release();
        }
      }
      await scheduler?.stop();
      await society.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
