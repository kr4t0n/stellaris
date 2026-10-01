import type { Board } from "@stellaris/board-core";
import path from "node:path";
import {
  FileReadSchema,
  NameSchema,
  RunnerAnswerSchema,
  RunnerHelloSchema,
  TurnEventsSchema,
  TurnOutcomeSchema,
  UlidSchema,
  WarmSessionsSchema,
  type Name,
  type RunnerMessage,
} from "@stellaris/shared";
import type { RunnerHub } from "@stellaris/turn-host";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { HomeGit } from "./home-git.js";

type RunnerEnv = { Variables: { runner: Name } };

/** How often an idle stream carries a comment, so proxies keep it open. */
const KEEPALIVE_MS = 15_000;

function bearer(c: Context<RunnerEnv>): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
  return match?.[1]?.trim() ?? null;
}

/**
 * The runner protocol of PLAN.md section 7.1 over HTTP, under `/runner`, authenticated with runner
 * tokens: registration, the event stream jobs and requests go down, and the posts that come back,
 * turn events and outcomes, answers, and warm sessions; the board's projection as files; and each
 * agent's home as a git repository.
 */
export function runnerRoutes(board: Board, hub: RunnerHub): Hono<RunnerEnv> {
  const routes = new Hono<RunnerEnv>();

  routes.use("*", async (c, next): Promise<Response | void> => {
    const token = bearer(c);
    const runner = token === null ? null : board.resolveRunnerToken(token);
    if (runner === null) {
      return c.json({ error: "UNAUTHORIZED", message: "a valid runner token is required" }, 401);
    }
    c.set("runner", runner);
    await next();
  });

  routes.post("/hello", async (c) =>
    c.json(await hub.register(c.get("runner"), RunnerHelloSchema.parse(await c.req.json()))),
  );

  routes.get("/stream", (c) => {
    const runner = c.get("runner");
    return streamSSE(c, async (stream) => {
      const queue: RunnerMessage[] = [];
      let wake: (() => void) | null = null;
      stream.onAbort(() => wake?.());
      const send = (message: RunnerMessage): boolean => {
        if (stream.aborted || stream.closed) {
          return false;
        }
        queue.push(message);
        wake?.();
        return true;
      };
      const detach = await hub.attach(runner, send);
      try {
        // Headers go out with the first write, so the runner knows it is attached once this arrives.
        await stream.write(": attached\n\n");
        while (!stream.aborted && !stream.closed) {
          for (let message = queue.shift(); message !== undefined; message = queue.shift()) {
            await stream.writeSSE({ event: message.type, data: JSON.stringify(message) });
          }
          await Promise.race([
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
            stream.sleep(KEEPALIVE_MS),
          ]);
          wake = null;
          if (queue.length === 0 && !stream.aborted) {
            await stream.write(": ping\n\n");
          }
        }
      } finally {
        await detach();
      }
    });
  });

  routes.post("/turns/:id/events", async (c) => {
    const { entries } = TurnEventsSchema.parse(await c.req.json());
    await hub.turnEvents(c.get("runner"), UlidSchema.parse(c.req.param("id")), entries);
    return c.json({ ok: true });
  });

  routes.post("/turns/:id/outcome", async (c) =>
    c.json(
      await hub.turnOutcome(
        c.get("runner"),
        UlidSchema.parse(c.req.param("id")),
        TurnOutcomeSchema.parse(await c.req.json()),
      ),
    ),
  );

  routes.post("/requests/:id", async (c) => {
    hub.answer(c.get("runner"), c.req.param("id"), RunnerAnswerSchema.parse(await c.req.json()));
    return c.json({ ok: true });
  });

  routes.post("/warm", async (c) => {
    hub.warmChanged(c.get("runner"), WarmSessionsSchema.parse(await c.req.json()).warm);
    return c.json({ ok: true });
  });

  routes.get("/board/manifest", async (c) => c.json({ files: await board.boardManifest() }));
  routes.post("/board/read", async (c) =>
    c.json({ files: await board.readBoardFiles(FileReadSchema.parse(await c.req.json()).paths) }),
  );

  // A runner reaches an agent's home only while it runs a turn of that agent.
  const home = new Hono<RunnerEnv>();
  home.use("*", async (c, next): Promise<Response | void> => {
    const agent = NameSchema.parse(c.req.param("agent"));
    if (!hub.mayTouchHome(c.get("runner"), agent)) {
      return c.json(
        { error: "FORBIDDEN", message: `no turn of ${agent} runs on this runner` },
        403,
      );
    }
    await next();
  });
  // The home's repository over git's smart HTTP protocol, which the runner clones and pushes to.
  const homeGit = new HomeGit();
  home.all("/git/*", async (c) => {
    const agent = NameSchema.parse(c.req.param("agent"));
    const repository = await board.ensureHomeRepo(agent);
    const marker = `/homes/${agent}/git`;
    const at = c.req.path.indexOf(marker);
    return homeGit.serve({
      root: path.dirname(repository),
      agent,
      rest: at === -1 ? "" : c.req.path.slice(at + marker.length),
      request: c.req.raw,
      runner: c.get("runner"),
    });
  });
  routes.route("/homes/:agent", home);

  return routes;
}
