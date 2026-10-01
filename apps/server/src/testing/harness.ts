import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { Board } from "@stellaris/board-core";
import { createRunner, type AgentBackend, type RunnerDaemon } from "@stellaris/runner-core";
import { TurnDispatchSchema, type CliKind, type TurnRecord } from "@stellaris/shared";
import { RunnerHub, TurnHost } from "@stellaris/turn-host";
import type { Hono } from "hono";
import type { z } from "zod";
import { createApp, type AppDependencies } from "../app.js";
import { TurnHub } from "../turn-hub.js";
import { USER } from "./scripted-backend.js";

export type TestApp = ReturnType<typeof createApp>;

export interface TestSocietyOptions {
  readonly board: Board;
  /** The runner's adapters, built once the app exists, since scripted ones call its verbs. */
  readonly backends: (app: TestApp) => Partial<Record<CliKind, AgentBackend>>;
  readonly runnerName?: string | undefined;
  readonly turnTimeoutMs?: number | null | undefined;
  readonly maxTurns?: number | null | undefined;
  readonly residentIdleMs?: number | undefined;
  readonly turns?: TurnHub | undefined;
  readonly scheduler?: AppDependencies["scheduler"] | undefined;
  readonly webDir?: string | undefined;
  /** 0 for any free port. */
  readonly port?: number | undefined;
  readonly slots?: number | null | undefined;
  readonly capabilities?: readonly string[] | undefined;
  /** Routes only a test has, added before the server answers anything. */
  readonly routes?: ((app: TestApp) => void) | undefined;
}

export interface TestSociety {
  readonly url: string;
  readonly app: TestApp;
  readonly host: TurnHost;
  readonly hub: RunnerHub;
  readonly runner: RunnerDaemon;
  readonly turns: TurnHub;
  /** One turn start to finish, placed and run as the scheduler would. */
  readonly run: (dispatch: z.input<typeof TurnDispatchSchema>) => Promise<TurnRecord>;
  readonly stop: () => Promise<void>;
}

/**
 * A board server and one runner in this process, talking the runner protocol over real HTTP on a
 * free port: the server half and the runner half of production, with the CLIs replaced by the
 * backends a test hands in. The runner keeps a data directory of its own, as on another machine.
 */
export async function startTestSociety(options: TestSocietyOptions): Promise<TestSociety> {
  const { board } = options;
  let fetcher: Hono["fetch"] | null = null;
  const server = serve({
    fetch: (request, env) => {
      if (fetcher === null) {
        return new Response("starting", { status: 503 });
      }
      return fetcher(request, env);
    },
    port: options.port ?? 0,
    hostname: "127.0.0.1",
  });
  await once(server, "listening");
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  const turns = options.turns ?? new TurnHub();
  const host = new TurnHost({
    board,
    mcpUrl: `${url}/mcp`,
    turnTimeoutMs: options.turnTimeoutMs,
    maxTurns: options.maxTurns,
    residentIdleMs: options.residentIdleMs ?? 60_000,
    onEvent: (agent, scope, event, thread) => turns.push(agent, scope, event, thread),
  });
  const hub = new RunnerHub({ board, host, version: "test", graceMs: 5_000 });
  const app = createApp({
    board,
    version: "test",
    turns,
    runners: hub,
    models: { list: (cli) => hub.models(cli) },
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.webDir === undefined ? {} : { webDir: options.webDir }),
  });
  options.routes?.(app);
  fetcher = app.fetch;

  const name = options.runnerName ?? "pod";
  const { token } = await board.addRunner(USER, name);
  const runnerDir = await mkdtemp(path.join(os.tmpdir(), "stellaris-runner-"));
  const runner = createRunner({
    serverUrl: url,
    token,
    dataDir: runnerDir,
    backends: options.backends(app),
    version: "test",
    slots: options.slots ?? null,
    capabilities: options.capabilities,
    retryMs: 50,
  });
  await runner.start();

  return {
    url,
    app,
    host,
    hub,
    runner,
    turns,
    run: async (input) => {
      const dispatch = TurnDispatchSchema.parse(input);
      const assignment = await hub.assign(dispatch);
      if (assignment === null) {
        throw new Error(`no runner could take ${dispatch.agent}'s turn on ${dispatch.project}`);
      }
      return hub.runTurn(dispatch, assignment);
    },
    stop: async () => {
      await runner.stop();
      await hub.close();
      // Event streams never end on their own, and close() waits for every connection.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      if ("closeAllConnections" in server) {
        server.closeAllConnections();
      }
      await closed;
      await rm(runnerDir, { recursive: true, force: true });
    },
  };
}
