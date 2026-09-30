import { isBoardError, type Actor, type Board } from "@stellaris/board-core";
import { handleMcpRequest } from "@stellaris/board-mcp";
import {
  CliKindSchema,
  ModelNameSchema,
  NameSchema,
  RoleCharterSchema,
  VerbNameSchema,
  WakeRequestSchema,
  type LiveTurnEvent,
} from "@stellaris/shared";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z, ZodError } from "zod";
import type { ModelSource } from "./models.js";
import type { TurnHub } from "./turn-hub.js";

/** What the API shows of the scheduler and the runner. The Scheduler class satisfies the first two. */
export interface SchedulerView {
  readonly pendingPairs: string[];
  readonly runningPairs: string[];
  /** Agent-scope pairs with a warm session on the embedded runner. */
  readonly residentPairs?: string[] | undefined;
  /** Keys of the operations conditions holding right now. */
  readonly activeSignals?: string[] | undefined;
}

export interface AppDependencies {
  readonly board: Board;
  readonly version: string;
  readonly turns?: TurnHub | undefined;
  readonly scheduler?: SchedulerView | undefined;
  /** The models each CLI offers, for choosing a citizen's model. */
  readonly models?: ModelSource | undefined;
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

const RetireBodySchema = z.object({ reason: z.string().min(1) });
/** A model for a citizen, or null for its CLI's own default. */
const ModelBodySchema = z.object({ model: ModelNameSchema.nullable() });
const ChannelBodySchema = z.object({
  project: NameSchema.nullable().default(null),
  name: NameSchema,
  purpose: z.string().min(1),
});

function bearer(c: Context<Env>): string | null {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
}

/** The board server's HTTP surface: health, an authenticated API for the user and tools, and the MCP endpoint. */
export function createApp(deps: AppDependencies): Hono<Env> {
  const { board, version, turns, scheduler, models } = deps;
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

  // Identity and society
  api.get("/me", (c) => c.json(c.get("actor")));
  api.get("/society", async (c) => c.json(await board.society()));
  api.get("/agents", async (c) =>
    c.json((await board.listAgents()).map(({ tokenHash: _hash, ...agent }) => agent)),
  );
  api.get("/members", async (c) => c.json(await board.listMembers()));
  // A member's finished turns from the event log and each one's steps, its memory core, and its
  // own skills, read only.
  api.get("/agents/:name/turns", async (c) =>
    c.json(await board.listTurns(c.req.param("name"), Number(c.req.query("limit") ?? "50"))),
  );
  api.get("/agents/:name/turns/:turnId", async (c) =>
    c.json(await board.readTranscript(c.req.param("name"), c.req.param("turnId"))),
  );
  api.get("/agents/:name/memory", async (c) => {
    await board.readAgent(c.req.param("name"));
    return c.json({ body: await board.readMemoryCore(c.req.param("name")) });
  });
  api.get("/agents/:name/skills", async (c) => {
    await board.readAgent(c.req.param("name"));
    return c.json(await board.listAgentSkills(c.req.param("name")));
  });
  api.get("/roles", async (c) => c.json(await board.listRoles()));
  api.get("/runners", async (c) => c.json(await board.listRunners()));
  api.get("/proposals", async (c) => c.json(await board.listProposals()));
  api.get("/proposals/:id", async (c) => c.json(await board.readProposal(c.req.param("id"))));
  api.get("/signals", async (c) =>
    c.json(await board.listSignals(Number(c.req.query("limit") ?? "100"))),
  );
  // The shared memory tiers: the society's knowledge topics and its promoted skills.
  api.get("/society/knowledge", async (c) => c.json(await board.listKnowledge(null)));
  api.get("/skills", async (c) => c.json(await board.listSocietySkills()));

  // Governance the user does directly: retirement, charters, channels.
  api.post("/agents/:name/retire", async (c) => {
    const body = RetireBodySchema.parse(await c.req.json());
    const { tokenHash: _hash, ...agent } = await board.retireAgent(c.get("actor"), {
      name: c.req.param("name"),
      reason: body.reason,
    });
    return c.json(agent);
  });
  api.put("/agents/:name/model", async (c) => {
    const body = ModelBodySchema.parse(await c.req.json());
    const { tokenHash: _hash, ...agent } = await board.setAgentModel(
      c.get("actor"),
      c.req.param("name"),
      body.model,
    );
    return c.json(agent);
  });
  // What each CLI offers, asked of the CLI itself.
  api.get("/models/:cli", async (c) => {
    const cli = CliKindSchema.parse(c.req.param("cli"));
    return c.json(models === undefined ? [] : await models.list(cli));
  });
  api.put("/roles/:name", async (c) => {
    const charter = RoleCharterSchema.parse({
      ...z.record(z.string(), z.unknown()).parse(await c.req.json()),
      name: c.req.param("name"),
    });
    return c.json(await board.setRoleCharter(c.get("actor"), charter));
  });
  api.post("/channels", async (c) => {
    const body = ChannelBodySchema.parse(await c.req.json());
    return c.json({ channel: await board.addChannel(c.get("actor"), body) });
  });

  // Projects, tasks, channels, threads
  api.get("/projects", async (c) => c.json(await board.listProjects()));
  api.get("/projects/:slug", async (c) => c.json(await board.readProject(c.req.param("slug"))));
  api.get("/projects/:slug/tasks", async (c) => c.json(await board.listTasks(c.req.param("slug"))));
  api.get("/projects/:slug/dashboard", async (c) =>
    c.json(await board.readDashboard(c.req.param("slug"))),
  );
  api.get("/projects/:slug/knowledge", async (c) =>
    c.json(await board.listKnowledge(c.req.param("slug"))),
  );
  api.get("/tasks/:id", async (c) => c.json((await board.findTask(c.req.param("id"))).task));
  api.get("/tasks/:id/thread", async (c) => c.json(await board.listThread(c.req.param("id"))));
  api.get("/threads", async (c) => c.json(await board.listThreads()));
  api.get("/threads/:id", async (c) => {
    const id = c.req.param("id");
    return c.json({ thread: await board.readThread(id), messages: await board.listThread(id) });
  });
  api.get("/channels", async (c) => c.json(await board.listChannels()));
  api.get("/channels/:ref{.+}", async (c) => c.json(await board.listChannel(c.req.param("ref"))));

  // Board events: the durable log, as a page or as a stream.
  api.get("/events", async (c) => {
    const since = c.req.query("since") ?? null;
    const limit = Number(c.req.query("limit") ?? "200");
    return c.json(await board.readEvents(since === "" ? null : since, limit));
  });
  // `since=latest` starts at the end of the log, for a client that has just read the board's state.
  api.get("/events/stream", (c) => {
    let cursor = c.req.query("since") ?? null;
    return streamSSE(c, async (stream) => {
      if (cursor === "latest") {
        cursor = await board.latestEventId();
      }
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

  // Scheduler state and controls
  api.get("/scheduler", async (c) =>
    c.json({
      paused: await board.isPaused(),
      running: scheduler?.runningPairs ?? [],
      pending: scheduler?.pendingPairs ?? [],
      resident: scheduler?.residentPairs ?? [],
      signals: scheduler?.activeSignals ?? [],
    }),
  );
  api.post("/pause", async (c) => {
    await board.setPaused(c.get("actor"), true);
    return c.json({ paused: true });
  });
  api.post("/resume", async (c) => {
    await board.setPaused(c.get("actor"), false);
    return c.json({ paused: false });
  });
  api.post("/wake", async (c) => {
    const input = WakeRequestSchema.parse(await c.req.json());
    return c.json(await board.requestWake(c.get("actor"), input));
  });

  // Live turn events: what agents are doing right now, replayed from a short buffer then streamed.
  api.get("/turns/recent", (c) => {
    const since = Number(c.req.query("since") ?? "0");
    return c.json({ lastSeq: turns?.lastSeq ?? 0, events: turns?.since(since) ?? [] });
  });
  api.get("/turns/stream", (c) => {
    const since = Number(c.req.query("since") ?? "0");
    return streamSSE(c, async (stream) => {
      if (turns === undefined) {
        return;
      }
      const queue: LiveTurnEvent[] = turns.since(since);
      let wake: (() => void) | null = null;
      const unsubscribe = turns.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      try {
        while (!stream.aborted && !stream.closed) {
          while (queue.length > 0) {
            const item = queue.shift();
            if (item !== undefined) {
              await stream.writeSSE({
                id: String(item.seq),
                event: "turn",
                data: JSON.stringify(item),
              });
            }
          }
          await Promise.race([
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
            stream.sleep(15_000),
          ]);
          wake = null;
          if (queue.length === 0) {
            await stream.writeSSE({ event: "ping", data: "" });
          }
        }
      } finally {
        unsubscribe();
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
