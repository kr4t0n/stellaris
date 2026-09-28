import { isBoardError, type Actor, type Board } from "@stellaris/board-core";
import { handleMcpRequest } from "@stellaris/board-mcp";
import { VerbNameSchema } from "@stellaris/shared";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { ZodError } from "zod";

export interface AppDependencies {
  readonly board: Board;
  readonly version: string;
}

type Env = { Variables: { actor: Actor } };

const ERROR_STATUS: Record<string, 400 | 403 | 404 | 409> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  CLAIM_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  INVALID_STATE: 409,
};

function bearer(c: Context<Env>): string | null {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
}

/** The board server's HTTP surface: health, an authenticated API for the UI and tools, and the MCP endpoint. */
export function createApp(deps: AppDependencies): Hono<Env> {
  const { board, version } = deps;
  const app = new Hono<Env>();

  app.get("/health", (c) => c.json({ ok: true, version }));

  app.onError((error, c) => {
    if (isBoardError(error)) {
      return c.json({ error: error.code, message: error.message }, ERROR_STATUS[error.code] ?? 400);
    }
    if (error instanceof ZodError) {
      return c.json({ error: "VALIDATION", message: error.message }, 400);
    }
    return c.json({ error: "INTERNAL", message: error.message }, 500);
  });

  const authenticate = async (
    c: Context<Env>,
    next: () => Promise<void>,
  ): Promise<Response | void> => {
    const token = bearer(c);
    const actor = token === null ? null : board.resolveToken(token);
    if (actor === null) {
      return c.json({ error: "UNAUTHORIZED", message: "a valid bearer token is required" }, 401);
    }
    c.set("actor", actor);
    await next();
  };

  const api = new Hono<Env>();
  api.use("*", authenticate);

  api.get("/me", (c) => c.json(c.get("actor")));
  api.get("/society", async (c) => c.json(await board.society()));
  api.get("/projects", async (c) => c.json(await board.listProjects()));
  api.get("/projects/:slug", async (c) => c.json(await board.readProject(c.req.param("slug"))));
  api.get("/projects/:slug/tasks", async (c) => c.json(await board.listTasks(c.req.param("slug"))));
  api.get("/agents", async (c) =>
    c.json((await board.listAgents()).map(({ tokenHash: _hash, ...agent }) => agent)),
  );
  api.get("/tasks/:id", async (c) => c.json((await board.findTask(c.req.param("id"))).task));
  api.get("/tasks/:id/thread", async (c) => c.json(await board.listThread(c.req.param("id"))));
  api.get("/channels/:ref{.+}", async (c) => c.json(await board.listChannel(c.req.param("ref"))));
  api.get("/events", async (c) => {
    const since = c.req.query("since") ?? null;
    const limit = Number(c.req.query("limit") ?? "200");
    return c.json(await board.readEvents(since === "" ? null : since, limit));
  });

  api.get("/events/stream", (c) => {
    let cursor = c.req.query("since") ?? null;
    return streamSSE(c, async (stream) => {
      while (!stream.aborted && !stream.closed) {
        const events = await board.readEvents(cursor === "" ? null : cursor, 100);
        for (const event of events) {
          await stream.writeSSE({ id: event.id, event: event.type, data: JSON.stringify(event) });
          cursor = event.id;
        }
        await stream.sleep(500);
      }
    });
  });

  api.post("/verbs/:verb", async (c) => {
    const verb = VerbNameSchema.parse(c.req.param("verb"));
    const input: unknown = await c.req.json().catch(() => ({}));
    const result = await board.invoke(c.get("actor"), verb, input ?? {});
    return c.json(result ?? null);
  });

  app.route("/api", api);

  app.all("/mcp", async (c) => {
    const token = bearer(c);
    const actor = token === null ? null : board.resolveToken(token);
    if (actor === null) {
      return c.json({ error: "UNAUTHORIZED", message: "a valid bearer token is required" }, 401);
    }
    return handleMcpRequest(board, actor, c.req.raw, version);
  });

  return app;
}
