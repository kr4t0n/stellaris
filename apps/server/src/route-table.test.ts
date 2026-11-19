import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerType } from "@hono/node-server";
import { Board } from "@stellaris/board-core";
import { SERVER_TOKEN } from "@stellaris/shared";
import { RunnerHub, TurnHost } from "@stellaris/turn-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { EnrollmentDesk } from "./enrollment.js";
import { serveBoard } from "./serve.js";
import { addWorkRoles, USER } from "./testing/scripted-backend.js";

/**
 * Every route anyone may ask without a token, by method and path as the route table names it, and
 * why. Every other route in the table must refuse a request with none.
 */
const PUBLIC = new Map([
  ["GET /health", "the health check, for probes and load balancers"],
  ["GET /auth/config", "tells the sign-in page whether GitHub sign-in is on"],
  ["GET /auth/app/signin", "the app's sign-in landing, which serves nothing"],
  ["GET /auth/github", "starts a GitHub sign-in, which is how a browser gets a token"],
  ["GET /auth/github/callback", "GitHub's redirect back, which ends in a token"],
  ["POST /auth/app/token", "the app trades its one-time code and its verifier for a token"],
  ["GET /.well-known/apple-app-site-association", "Apple reads it before the app may sign in"],
  ["POST /runner/enroll", "a runner with no token asks to be enrolled"],
  ["POST /runner/enroll/poll", "a runner waiting to be enrolled polls for its token"],
  ["GET /*", "the interface's page and bundle, which hold none of the board's data"],
]);

/**
 * Each line terminator, encoded, which hono 4.4.0 to 4.13.15 let a path end with to skip wildcard
 * middleware (GHSA-h7mg-cq63-vhpq). Asked only under the trees whose token check is wildcard
 * middleware: elsewhere such a path is another path, which only the interface's `GET /*` or
 * hono's 404 answers.
 */
const TERMINATORS = ["%0A", "%0D", "%E2%80%A8", "%E2%80%A9"];
const CHECKED_TREES = ["/api/", "/runner/"];

/**
 * A request path for a route's pattern, with each parameter filled from `values`, else with `x`,
 * and a trailing wildcard with `x`.
 */
function pathOf(pattern: string, values: Record<string, string> = {}): string {
  const filled = pattern
    .replace(/:([^/{}]+)(?:\{[^}]*\})?/g, (_param, name: string) => values[name] ?? "x")
    .replace(/\*$/, "x");
  return filled.startsWith("/") ? filled : `/${filled}`;
}

/** Every file under `folder`, by path, with a hash of its bytes. */
async function filesUnder(folder: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      files.set(
        file,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      );
    }
  }
  return files;
}

describe("the route table", () => {
  /** A folder of the test's own, holding the data directory and what is planted beside it. */
  let root: string;
  let dir: string;
  let board: Board;
  let hub: RunnerHub;
  let app: ReturnType<typeof createApp>;
  let server: ServerType;
  let url: string;
  let userToken: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "stellaris-route-table-"));
    dir = path.join(root, "data");
    const init = await Board.init(dir, { name: "routes" });
    board = init.board;
    userToken = init.userToken;
    await board.addProject(USER, { slug: "demo" });
    await addWorkRoles(board);
    const host = new TurnHost({ board, mcpUrl: `${SERVER_TOKEN}/mcp`, residentIdleMs: 60_000 });
    hub = new RunnerHub({ board, host, version: "test" });
    // Every dependency that adds routes, so the table holds all of them.
    app = createApp({
      board,
      version: "test",
      runners: hub,
      enrollments: new EnrollmentDesk(board),
      signIn: {
        github: {
          clientId: "Iv1.test",
          clientSecret: "secret",
          users: ["signer-1"],
          appleAppId: "ABCDE12345.dev.example.app",
        },
      },
      webDir: path.join(dir, "web"),
    });
    server = serveBoard({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  });

  afterEach(async () => {
    await hub.close();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
    await closed;
    await rm(root, { recursive: true, force: true });
  });

  /** Each route the table holds, middleware included, as `METHOD pattern`, once. */
  const routeKeys = (): Set<string> =>
    new Set(app.routes.map((route) => `${route.method} ${route.path}`));

  it("refuses a request with no token on every route but the public ones", async () => {
    const keys = routeKeys();
    // The walk reads the whole table: the API, the runner protocol, MCP, and the public routes.
    for (const route of [
      "GET /api/me",
      "POST /api/verbs/:verb",
      "POST /runner/hello",
      "ALL /mcp",
    ]) {
      expect(keys).toContain(route);
    }
    // A public route no longer in the table leaves this list, so it never covers a new one.
    expect([...PUBLIC.keys()].filter((key) => !keys.has(key))).toEqual([]);

    const refused: string[] = [];
    let asked = 0;
    for (const key of keys) {
      if (PUBLIC.has(key)) {
        continue;
      }
      const [method = "", pattern = ""] = key.split(" ");
      const endings = CHECKED_TREES.some((tree) => pattern.startsWith(tree))
        ? ["", ...TERMINATORS]
        : [""];
      for (const verb of method === "ALL" ? ["GET", "POST"] : [method]) {
        for (const ending of endings) {
          const target = `${pathOf(pattern)}${ending}`;
          const response = await fetch(`${url}${target}`, { method: verb, redirect: "manual" });
          const text = await response.text();
          asked += 1;
          if (response.status !== 401 || !text.includes('"error":"UNAUTHORIZED"')) {
            refused.push(`${verb} ${target} (${key}): ${response.status} ${text.slice(0, 60)}`);
          }
        }
      }
    }
    expect(refused).toEqual([]);
    expect(asked).toBeGreaterThan(keys.size);
  });

  it("refuses a malformed project slug on every route that takes one, naming no path", async () => {
    // A body each write takes apart from its slug, so its answer is the slug's.
    const bodies = new Map([["PUT /api/projects/:slug/runner", { runner: "runner-1" }]]);
    const slugRoutes = [...routeKeys()].filter((key) => key.includes("/:slug"));
    expect(slugRoutes).toContain("GET /api/projects/:slug/knowledge");
    const ask = async (key: string, slug: string) => {
      const [method = "", pattern = ""] = key.split(" ");
      const body = bodies.get(key);
      const response = await fetch(`${url}${pathOf(pattern, { slug })}`, {
        method,
        headers: {
          authorization: `Bearer ${userToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, text: await response.text() };
    };

    expect(slugRoutes.filter((key) => !key.startsWith("GET ") && !bodies.has(key))).toEqual([]);

    const answers: string[] = [];
    for (const key of slugRoutes) {
      // A well-formed slug passes the check, so a refusal below is the slug's.
      expect((await ask(key, "demo")).status).not.toBe(400);
      for (const slug of ["demo%00", "..%2Fsociety", "DEMO"]) {
        const { status, text } = await ask(key, slug);
        const named = text.includes(dir) || text.includes("projects/");
        answers.push(
          `${key} ${slug}: ${status} ${text.match(/"error":"\w+"/)?.[0] ?? ""}${named ? " names a path" : ""}`,
        );
      }
      const missing = await ask(key, "nothing-here");
      answers.push(`${key} nothing-here: ${missing.status}`);
    }
    expect(answers).toEqual(
      slugRoutes.flatMap((key) => [
        `${key} demo%00: 400 "error":"VALIDATION"`,
        `${key} ..%2Fsociety: 400 "error":"VALIDATION"`,
        `${key} DEMO: 400 "error":"VALIDATION"`,
        `${key} nothing-here: 404`,
      ]),
    );
  });

  it("refuses a malformed name on every route that takes one, reaching no file", async () => {
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    // A citizen's home copied inside the data directory and outside it: an encoded slash in an
    // unparsed name reached either, to read its memory or to rewrite its `agent.json`.
    for (const folder of [path.join(dir, "outside-agent"), path.join(root, "outside-agent")]) {
      await cp(path.join(dir, "agents", "eng-1"), folder, { recursive: true });
      await writeFile(path.join(folder, "memory", "core.md"), "PLANTED-MEMORY\n");
    }
    // A body each write takes apart from its name, so its answer is the name's; null for a write
    // that reads none.
    const bodies = new Map<string, object | null>([
      ["POST /api/agents/:name/retire", { reason: "done" }],
      ["PUT /api/agents/:name/model", { model: "model-1" }],
      ["PUT /api/agents/:name/effort", { effort: "high" }],
      ["PUT /api/agents/:name/runner", { runner: null }],
      ["PUT /api/roles/:name", { purpose: "Plans.", verbs: [] }],
      ["PUT /api/runners/:name/name", { name: "runner-2" }],
      ["DELETE /api/runners/:name", null],
      ["POST /api/runners/:name/pause", null],
      ["POST /api/runners/:name/pause/:cli", null],
      ["POST /api/runners/:name/resume", null],
      ["POST /api/runners/:name/resume/:cli", null],
      ["POST /api/runners/:name/quota/:cli", null],
    ]);
    // What a well-formed name of nothing answers where that is not a 404, and why.
    const missing = new Map<string, [number, string]>([
      [
        "PUT /api/roles/:name",
        [200, "a charter's PUT writes the role, so a new name is a new role"],
      ],
      [
        "POST /api/runners/:name/quota/:cli",
        [503, "it asks the runner's connection, and none has"],
      ],
    ]);
    const nameRoutes = [...routeKeys()].filter((key) => key.includes("/:name"));
    expect(nameRoutes).toContain("GET /api/agents/:name/memory");
    // A write the table gains takes a line in `bodies`, so it is asked as it would be, and a line
    // whose route has gone leaves both lists.
    expect(nameRoutes.filter((key) => !key.startsWith("GET ") && !bodies.has(key))).toEqual([]);
    expect(
      [...bodies.keys(), ...missing.keys()].filter((key) => !nameRoutes.includes(key)),
    ).toEqual([]);
    const ask = async (key: string, name: string) => {
      const [method = "", pattern = ""] = key.split(" ");
      const body = bodies.get(key) ?? null;
      const response = await fetch(`${url}${pathOf(pattern, { name, cli: "claude" })}`, {
        method,
        headers: {
          authorization: `Bearer ${userToken}`,
          ...(body === null ? {} : { "content-type": "application/json" }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, text: await response.text() };
    };

    const before = await filesUnder(root);
    const answers: string[] = [];
    for (const key of nameRoutes) {
      for (const name of ["x%00", "..%2Foutside-agent", "..%2F..%2Foutside-agent", "USER"]) {
        const { status, text } = await ask(key, name);
        const named = text.includes(root) || text.includes("agents/");
        const planted = text.includes("PLANTED-MEMORY");
        answers.push(
          `${key} ${name}: ${status} ${text.match(/"error":"\w+"/)?.[0] ?? ""}${named ? " names a path" : ""}${planted ? " reads the planted home" : ""}`,
        );
      }
    }
    // A refused name writes nothing, in the data directory or beside it.
    const after = await filesUnder(root);
    const touched = [...new Set([...before.keys(), ...after.keys()])]
      .filter((file) => before.get(file) !== after.get(file))
      .map((file) => path.relative(root, file));
    for (const key of nameRoutes) {
      answers.push(`${key} nothing-here: ${(await ask(key, "nothing-here")).status}`);
    }

    expect({ answers, touched }).toEqual({
      answers: [
        ...nameRoutes.flatMap((key) =>
          ["x%00", "..%2Foutside-agent", "..%2F..%2Foutside-agent", "USER"].map(
            (name) => `${key} ${name}: 400 "error":"VALIDATION"`,
          ),
        ),
        ...nameRoutes.map((key) => `${key} nothing-here: ${missing.get(key)?.[0] ?? 404}`),
      ],
      touched: [],
    });
  });

  it("refuses a malformed id on every route that takes one, reaching no file", async () => {
    const eng = { name: "eng-1", role: "engineer" };
    await board.addAgent(USER, { ...eng, cli: "claude", memberships: ["demo"] });
    const task = await board.createTask(USER, { project: "demo", title: "Ship it", body: "Ship." });
    await board.postMessage(eng, { thread_id: task.id, body: "a step" });
    const proposal = await board.propose(eng, {
      kind: "channel",
      charter: { project: "demo", name: "design", purpose: "Design talk" },
    });
    const { token: runnerToken } = await board.addRunner(USER, "runner-1");
    // A task's record, its thread's record and messages, and a proposal's record, copied inside
    // the data directory and outside it: an encoded slash in an unparsed id reached either, from
    // the tasks', the threads', or the proposals' folder.
    const project = path.join(dir, "board", "projects", "demo");
    for (const folder of [dir, root]) {
      for (const [from, to] of [
        [path.join(project, "tasks", `${task.id}.md`), "outside-task.md"],
        [path.join(project, "threads", `${task.id}.md`), "outside-thread.md"],
        [path.join(project, "threads", task.id), "outside-thread"],
        [
          path.join(dir, "board", "society", "proposals", `${proposal.id}.md`),
          "outside-proposal.md",
        ],
      ] as const) {
        await cp(from, path.join(folder, to), { recursive: true });
      }
      for (const file of await readdir(folder, { recursive: true })) {
        if (file.startsWith("outside-") && file.endsWith(".md")) {
          await appendFile(path.join(folder, file), "PLANTED-RECORD\n");
        }
      }
    }
    // Three folders up from the society's threads or proposals is the data directory, four from
    // a project's tasks or threads; one more is outside it.
    const ids = [
      "x%00",
      ...[3, 4, 5].flatMap((depth) =>
        ["task", "thread", "proposal"].map((kind) => `${"..%2F".repeat(depth)}outside-${kind}`),
      ),
    ];
    const outcome = {
      exitReason: "completed",
      status: null,
      error: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      session: null,
      model: null,
      work: null,
    };
    // A body each write takes apart from its id, so its answer is the id's; null for one that
    // reads none.
    const bodies = new Map<string, object | null>([
      ["POST /runner/turns/:id/events", { entries: [] }],
      ["POST /runner/turns/:id/received", null],
      ["POST /runner/turns/:id/outcome", outcome],
      ["POST /runner/requests/:id", { ok: true, value: null }],
      ["ALL /runner/moves/:id/git/*", null],
    ]);
    // What a route answers that names no file by its id, malformed or not, and why.
    const unparsed = new Map<string, [number, string]>([
      [
        "POST /runner/requests/:id",
        [200, "a request's id is a UUID the hub made, looked up in memory and never a path"],
      ],
      [
        "ALL /runner/moves/:id/git/*",
        [404, "git asks it, and a move it doesn't know, by any id, is no repository to serve"],
      ],
    ]);
    // What a well-formed id of nothing answers where that is not a 404, and why.
    const missing = new Map<string, [number, string]>([
      ["POST /runner/turns/:id/events", [200, "a turn's steps the hub doesn't hold are dropped"]],
      ["POST /runner/turns/:id/received", [200, "a receipt for a job it didn't send is dropped"]],
      ["POST /runner/turns/:id/outcome", [200, "an outcome of a turn the host doesn't hold too"]],
    ]);
    const idRoutes = [...routeKeys()].filter((key) => key.includes("/:id"));
    expect(idRoutes).toContain("GET /api/threads/:id");
    expect(idRoutes.filter((key) => !key.startsWith("GET ") && !bodies.has(key))).toEqual([]);
    expect(
      [...bodies.keys(), ...unparsed.keys(), ...missing.keys()].filter(
        (key) => !idRoutes.includes(key),
      ),
    ).toEqual([]);
    const ask = async (key: string, id: string) => {
      const [method = "", pattern = ""] = key.split(" ");
      const body = bodies.get(key) ?? null;
      const target = pathOf(pattern, { id }).replace(/\/git\/x$/, "/git/info/refs");
      const token = pattern.startsWith("/runner/") ? runnerToken : userToken;
      const response = await fetch(
        `${url}${target}${target.endsWith("/info/refs") ? "?service=git-upload-pack" : ""}`,
        {
          method: method === "ALL" ? "GET" : method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === null ? {} : { "content-type": "application/json" }),
          },
          ...(body === null ? {} : { body: JSON.stringify(body) }),
        },
      );
      return { status: response.status, text: await response.text() };
    };

    const before = await filesUnder(root);
    const answers: string[] = [];
    for (const key of idRoutes) {
      for (const id of ids) {
        const { status, text } = await ask(key, id);
        const named = text.includes(root) || text.includes("outside-");
        const planted = text.includes("PLANTED-RECORD");
        answers.push(
          `${key} ${id}: ${status} ${text.match(/"error":"\w+"/)?.[0] ?? ""}${named ? " names a path" : ""}${planted ? " reads a planted record" : ""}`,
        );
      }
    }
    const after = await filesUnder(root);
    const touched = [...new Set([...before.keys(), ...after.keys()])]
      .filter((file) => before.get(file) !== after.get(file))
      .map((file) => path.relative(root, file));
    const nothing = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    for (const key of idRoutes) {
      answers.push(`${key} ${nothing}: ${(await ask(key, nothing)).status}`);
    }

    const refused = (key: string) => {
      const status = unparsed.get(key)?.[0];
      return status === undefined
        ? `400 "error":"VALIDATION"`
        : `${status} ${status === 404 ? `"error":"NOT_FOUND"` : ""}`;
    };
    expect({ answers, touched }).toEqual({
      answers: [
        ...idRoutes.flatMap((key) => ids.map((id) => `${key} ${id}: ${refused(key)}`)),
        ...idRoutes.map(
          (key) => `${key} ${nothing}: ${missing.get(key)?.[0] ?? unparsed.get(key)?.[0] ?? 404}`,
        ),
      ],
      touched: [],
    });
  });

  it("refuses a malformed channel reference, reaching no file", async () => {
    await board.postMessage(USER, { channel: "demo/general", body: "a post" });
    // A project's record one folder above the projects', and a channel's messages beside it: an
    // unparsed reference's project of `..` reached both.
    const boardDir = path.join(dir, "board");
    await cp(
      path.join(boardDir, "projects", "demo", "project.md"),
      path.join(boardDir, "project.md"),
    );
    const planted = path.join(boardDir, "channels", "general");
    await cp(path.join(boardDir, "projects", "demo", "channels", "general"), planted, {
      recursive: true,
    });
    for (const file of await readdir(planted)) {
      await appendFile(path.join(planted, file), "PLANTED-POST\n");
    }
    const refRoutes = [...routeKeys()].filter((key) => key.includes("/:ref"));
    expect(refRoutes).toContain("GET /api/channels/:ref{.+}");
    const malformed = ["x%00", "..%2Fgeneral", "DEMO%2Fgeneral", "demo%2F..%2Fgeneral"];

    const before = await filesUnder(root);
    const answers: string[] = [];
    for (const key of refRoutes) {
      const [method = "", pattern = ""] = key.split(" ");
      for (const ref of [...malformed, "nothing-here", "demo%2Fgeneral"]) {
        const response = await fetch(`${url}${pathOf(pattern, { ref })}`, {
          method,
          headers: { authorization: `Bearer ${userToken}` },
        });
        const text = await response.text();
        answers.push(
          `${key} ${ref}: ${response.status} ${text.match(/"error":"\w+"/)?.[0] ?? ""}${text.includes("PLANTED-POST") ? " reads the planted posts" : ""}`,
        );
      }
    }
    const after = await filesUnder(root);
    const touched = [...new Set([...before.keys(), ...after.keys()])]
      .filter((file) => before.get(file) !== after.get(file))
      .map((file) => path.relative(root, file));

    expect({ answers, touched }).toEqual({
      answers: refRoutes.flatMap((key) => [
        ...malformed.map((ref) => `${key} ${ref}: 400 "error":"VALIDATION"`),
        `${key} nothing-here: 404 "error":"NOT_FOUND"`,
        `${key} demo%2Fgeneral: 200 `,
      ]),
      touched: [],
    });
  });
});
