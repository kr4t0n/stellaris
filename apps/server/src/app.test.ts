import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Board } from "@stellaris/board-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "./app.js";
import { addWorkRoles } from "./testing/scripted-backend.js";

const USER = { name: "user", role: "user" } as const;

// The limits board-mcp sets on `/mcp` (GHSA-46jr-4wx8-v453), restated so a change to either shows here.
const MCP_ELEMENT_LIMIT = 1_000;
const MCP_BODY_LIMIT = 1024 * 1024;

/** Serves the app on a free local port, for clients that speak real HTTP. */
function listen(app: ReturnType<typeof createApp>): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      resolve({ url: `http://127.0.0.1:${info.port}/mcp`, close: () => server.close() }),
    );
  });
}

describe("board server", () => {
  let dir: string;
  let board: Board;
  let userToken: string;
  let engToken: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-srv-"));
    const init = await Board.init(dir, { name: "srv" });
    board = init.board;
    userToken = init.userToken;
    await board.addProject(USER, { slug: "demo", channels: ["general", "dev"] });
    await addWorkRoles(board);
    engToken = (
      await board.addAgent(USER, {
        name: "eng-1",
        role: "engineer",
        cli: "claude",
        memberships: ["demo"],
      })
    ).token;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("answers the health check without a token", async () => {
    const response = await createApp({ board, version: "test" }).request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: "test" });
  });

  it("requires a bearer token on the API and resolves the actor", async () => {
    const app = createApp({ board, version: "test" });
    expect((await app.request("/api/me")).status).toBe(401);
    const me = await app.request("/api/me", { headers: { authorization: `Bearer ${engToken}` } });
    expect(await me.json()).toEqual({ name: "eng-1", role: "engineer" });
  });

  it("runs verbs over HTTP with board errors mapped to status codes", async () => {
    const app = createApp({ board, version: "test" });
    const headers = { authorization: `Bearer ${engToken}`, "content-type": "application/json" };
    const created = await app.request("/api/verbs/create_task", {
      method: "POST",
      headers,
      body: JSON.stringify({ project: "demo", title: "via http" }),
    });
    expect(created.status).toBe(200);
    const task = z.object({ id: z.string(), status: z.string() }).parse(await created.json());
    expect(task.status).toBe("open");

    const forbidden = await app.request("/api/verbs/approve", {
      method: "POST",
      headers,
      body: JSON.stringify({ proposal_id: task.id }),
    });
    expect(forbidden.status).toBe(403);

    const invalid = await app.request("/api/verbs/update_task", {
      method: "POST",
      headers,
      body: JSON.stringify({ task_id: task.id, status: "done" }),
    });
    expect(invalid.status).toBe(400);

    const claimed = await app.request("/api/verbs/claim_task", {
      method: "POST",
      headers,
      body: JSON.stringify({ task_id: task.id }),
    });
    expect(claimed.status).toBe(200);
    const conflict = await app.request("/api/verbs/claim_task", {
      method: "POST",
      headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
      body: JSON.stringify({ task_id: task.id }),
    });
    expect(conflict.status).toBe(409);

    const tasks = await app.request("/api/projects/demo/tasks", {
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(await tasks.json()).toHaveLength(1);

    const opened = await app.request("/api/verbs/open_thread", {
      method: "POST",
      headers,
      body: JSON.stringify({ channel: "demo/dev", title: "Which runner?" }),
    });
    const thread = z.object({ id: z.string() }).parse(await opened.json());
    await app.request("/api/verbs/post_message", {
      method: "POST",
      headers,
      body: JSON.stringify({ thread_id: thread.id, body: "vitest?" }),
    });
    // The task's thread opened with the task; the topic hangs off the channel it names.
    const listed = await app.request("/api/threads", { headers });
    expect(await listed.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: task.id, channel: "demo/general", messages: 0 }),
        expect.objectContaining({ id: thread.id, channel: "demo/dev" }),
      ]),
    );
    const shown = await app.request(`/api/threads/${thread.id}`, { headers });
    expect(await shown.json()).toMatchObject({
      thread: { title: "Which runner?", state: "open" },
      messages: [{ body: "vitest?\n", channel: "demo/dev" }],
    });
  });

  it("serves the board as an MCP endpoint with role-filtered tools", async () => {
    const app = createApp({ board, version: "test" });
    let server: ReturnType<typeof serve> | undefined;
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
        resolve(info.port),
      );
    });
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    try {
      const client = new Client({ name: "test-client", version: "0" });
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${engToken}` } },
      });
      await client.connect(transport);
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain("claim_task");
      expect(names).not.toContain("approve");

      const result = await client.callTool({
        name: "create_task",
        arguments: { project: "demo", title: "via mcp" },
      });
      expect(result.isError).toBeFalsy();
      const content = z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .parse(result.content);
      expect(JSON.parse(content[0]?.text ?? "")).toMatchObject({
        title: "via mcp",
        status: "open",
      });

      const denied = await client.callTool({
        name: "claim_task",
        arguments: { task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      });
      expect(denied.isError).toBe(true);
      await client.close();

      const unauthenticated = await fetch(url, { method: "POST", body: "{}" });
      expect(unauthenticated.status).toBe(401);
    } finally {
      server?.close();
    }
  });

  it("refuses an MCP tool call over the element limit and runs one at it", async () => {
    const served = await listen(createApp({ board, version: "test" }));
    try {
      const client = new Client({ name: "test-client", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(served.url), {
          requestInit: { headers: { authorization: `Bearer ${engToken}` } },
        }),
      );
      // Three members, project, title and required_capabilities, and one element per capability.
      const create = (title: string, elements: number) =>
        client.callTool({
          name: "create_task",
          arguments: {
            project: "demo",
            title,
            required_capabilities: Array.from({ length: elements - 3 }, (_, i) => `cap-${i}`),
          },
        });
      expect((await create("at the limit", MCP_ELEMENT_LIMIT)).isError).toBeFalsy();
      expect(await create("over the limit", MCP_ELEMENT_LIMIT + 1)).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringContaining(`more than the maximum of ${MCP_ELEMENT_LIMIT} elements`),
          },
        ],
      });
      await client.close();
      const tasks = await board.listTasks("demo");
      expect(tasks.map((task) => [task.title, task.requiredCapabilities.length])).toEqual([
        ["at the limit", MCP_ELEMENT_LIMIT - 3],
      ]);
    } finally {
      served.close();
    }
  });

  it("refuses an MCP request body over the size limit and reads one at it", async () => {
    const served = await listen(createApp({ board, version: "test" }));
    try {
      // A create_task call whose task body pads the request to exactly `size` bytes.
      const post = (title: string, size: number) => {
        const call = (body: string) =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "create_task", arguments: { project: "demo", title, body } },
          });
        const request = call("x".repeat(size - Buffer.byteLength(call(""))));
        expect(Buffer.byteLength(request)).toBe(size);
        return fetch(served.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${engToken}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: request,
        });
      };
      const atLimit = await post("at the limit", MCP_BODY_LIMIT);
      expect(atLimit.status).toBe(200);
      const answer = z
        .object({ result: z.object({ isError: z.boolean().optional() }) })
        .parse(await atLimit.json());
      expect(answer.result.isError).toBeUndefined();
      const over = await post("over the limit", MCP_BODY_LIMIT + 1);
      expect(over.status).toBe(413);
      expect(await over.json()).toMatchObject({
        error: { code: -32000, message: expect.stringContaining("Payload Too Large") },
      });
      expect((await board.listTasks("demo")).map((task) => task.title)).toEqual(["at the limit"]);
    } finally {
      served.close();
    }
  });
});
