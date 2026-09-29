import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Board } from "@stellaris/board-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "./app.js";

const USER = { name: "user", role: "user" } as const;

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
    await board.addProject(USER, { slug: "demo" });
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
    expect(invalid.status).toBe(409);

    const tasks = await app.request("/api/projects/demo/tasks", {
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(await tasks.json()).toHaveLength(1);
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
      // The SDK's client transport and its Transport interface disagree on optional `undefined` under strict optional typing.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      await client.connect(transport as unknown as Transport);
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
});
