import type { Board } from "@stellaris/board-core";
import path from "node:path";
import {
  HeldWorkspacesSchema,
  FileReadSchema,
  NameSchema,
  RunnerAnswerSchema,
  RunnerEnrollPollSchema,
  RunnerEnrollRequestSchema,
  RunnerHelloSchema,
  TurnEventsSchema,
  TurnOutcomeSchema,
  UlidSchema,
  WarmSessionsSchema,
  type Name,
  type RunnerMessage,
} from "@stellaris/shared";
import type { RunnerHub } from "@stellaris/turn-host";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import {
  ENROLL_BODY_LIMIT_BYTES,
  limitBody,
  RUNNER_ANSWER_LIMIT_BYTES,
  RUNNER_BODY_LIMIT_BYTES,
} from "./body-limit.js";
import type { EnrollmentDesk } from "./enrollment.js";
import { HomeGit } from "./home-git.js";

type RunnerEnv = { Variables: { runner: Name } };

/** How often an idle stream carries a comment, so proxies keep it open. */
const KEEPALIVE_MS = 15_000;

function bearer(c: Context<RunnerEnv>): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
  return match?.[1]?.trim() ?? null;
}

/**
 * The runner protocol of docs/plan.md section 7.1 over HTTP, under `/runner`, authenticated with
 * runner tokens: registration, the event stream jobs and requests go down, and the posts that come
 * back, turn events and outcomes, answers, and warm sessions; the board's projection as files; and
 * each agent's home as a git repository.
 */
export function runnerRoutes(
  board: Board,
  hub: RunnerHub,
  enrollments?: EnrollmentDesk,
  /** Limits asking to enroll, which anyone may do. */
  enrollLimit?: MiddlewareHandler,
): Hono<RunnerEnv> {
  const routes = new Hono<RunnerEnv>();

  // A runner with no token asks to be enrolled and polls until the user decides, so these two
  // answer before the token check below, with the tightest limit on what they read.
  if (enrollments !== undefined) {
    const enrollBody = limitBody(ENROLL_BODY_LIMIT_BYTES);
    routes.post("/enroll", enrollLimit ?? ((_c, next) => next()), enrollBody, async (c) =>
      c.json(enrollments.open(RunnerEnrollRequestSchema.parse(await c.req.json()))),
    );
    routes.post("/enroll/poll", enrollBody, async (c) => {
      const { deviceCode } = RunnerEnrollPollSchema.parse(await c.req.json());
      const status = enrollments.poll(deviceCode);
      return status === null
        ? c.json({ error: "NOT_FOUND", message: "no such enrollment; it may have expired" }, 404)
        : c.json(status);
    });
  }

  routes.use("*", async (c, next): Promise<Response | void> => {
    const token = bearer(c);
    const runner = token === null ? null : board.resolveRunnerToken(token);
    if (runner === null) {
      return c.json({ error: "UNAUTHORIZED", message: "a valid runner token is required" }, 401);
    }
    c.set("runner", runner);
    await next();
  });

  // Every post below reads its body whole; the home's git route, which carries packs, is not one.
  const body = limitBody(RUNNER_BODY_LIMIT_BYTES);

  routes.post("/hello", body, async (c) =>
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

  routes.post("/turns/:id/events", body, async (c) => {
    const { entries } = TurnEventsSchema.parse(await c.req.json());
    await hub.turnEvents(c.get("runner"), UlidSchema.parse(c.req.param("id")), entries);
    return c.json({ ok: true });
  });

  routes.post("/turns/:id/received", (c) => {
    hub.received(c.get("runner"), UlidSchema.parse(c.req.param("id")));
    return c.json({ ok: true });
  });

  routes.post("/turns/:id/outcome", body, async (c) =>
    c.json(
      await hub.turnOutcome(
        c.get("runner"),
        UlidSchema.parse(c.req.param("id")),
        TurnOutcomeSchema.parse(await c.req.json()),
      ),
    ),
  );

  routes.post("/requests/:id", limitBody(RUNNER_ANSWER_LIMIT_BYTES), async (c) => {
    hub.answer(c.get("runner"), c.req.param("id"), RunnerAnswerSchema.parse(await c.req.json()));
    return c.json({ ok: true });
  });

  routes.post("/workspaces", body, async (c) => {
    hub.heldWorkspaces(c.get("runner"), HeldWorkspacesSchema.parse(await c.req.json()).workspaces);
    return c.json({ ok: true });
  });

  routes.post("/warm", body, async (c) => {
    hub.warmChanged(c.get("runner"), WarmSessionsSchema.parse(await c.req.json()).warm);
    return c.json({ ok: true });
  });

  routes.get("/board/manifest", async (c) => c.json({ files: await board.boardManifest() }));
  routes.post("/board/read", body, async (c) =>
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
      repository: agent,
      rest: at === -1 ? "" : c.req.path.slice(at + marker.length),
      request: c.req.raw,
      runner: c.get("runner"),
    });
  });
  routes.route("/homes/:agent", home);

  // A move's repository, which only its old runner pushes to while it exports and only its new
  // runner fetches from while it imports; any other runner, and a move not under way, is refused.
  routes.all("/moves/:id/git/*", async (c) => {
    const id = UlidSchema.safeParse(c.req.param("id"));
    const marker = `/moves/${c.req.param("id")}/git`;
    const at = c.req.path.indexOf(marker);
    const rest = at === -1 ? "" : c.req.path.slice(at + marker.length);
    const service = rest === "/info/refs" ? (c.req.query("service") ?? "") : rest.slice(1);
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      return c.json({ error: "NOT_FOUND", message: "not a smart HTTP request" }, 404);
    }
    const access = id.success
      ? hub.moveAccess(c.get("runner"), id.data, service === "git-receive-pack")
      : "unknown";
    if (access === "unknown") {
      return c.json({ error: "NOT_FOUND", message: "no such move under way" }, 404);
    }
    if (access === "refused" || !id.success) {
      return c.json(
        {
          error: "FORBIDDEN",
          message: `this runner may not ${service === "git-receive-pack" ? "push to" : "fetch from"} this move now`,
        },
        403,
      );
    }
    return homeGit.serve({
      root: board.moveRepos,
      repository: `${id.data}.git`,
      rest,
      request: c.req.raw,
      runner: c.get("runner"),
    });
  });

  return routes;
}
