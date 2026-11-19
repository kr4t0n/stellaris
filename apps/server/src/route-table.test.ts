import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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
 * Each line terminator, encoded, which hono 4.13.13 to 4.13.15 let a path end with to skip wildcard
 * middleware (GHSA-h7mg-cq63-vhpq). Asked only under the trees whose token check is wildcard
 * middleware: elsewhere such a path is another path, which reaches no handler.
 */
const TERMINATORS = ["%0A", "%0D", "%E2%80%A8", "%E2%80%A9"];
const CHECKED_TREES = ["/api/", "/runner/"];

/** A request path for a route's pattern, with each parameter and wildcard filled. */
function pathOf(pattern: string): string {
  const filled = pattern.replace(/:[^/{}]+(?:\{[^}]*\})?/g, "x").replace(/\*$/, "x");
  return filled.startsWith("/") ? filled : `/${filled}`;
}

describe("the route table", () => {
  let dir: string;
  let board: Board;
  let hub: RunnerHub;
  let app: ReturnType<typeof createApp>;
  let server: ServerType;
  let url: string;
  let userToken: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-route-table-"));
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
    await rm(dir, { recursive: true, force: true });
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
      const response = await fetch(`${url}${pathOf(pattern.replace(":slug", slug))}`, {
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
});
