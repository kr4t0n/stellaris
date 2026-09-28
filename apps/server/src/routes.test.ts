import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "./app.js";
import { TurnHub } from "./turn-hub.js";

const OWNER = { name: "owner", role: "owner" } as const;

async function readSse(response: Response, wanted: number): Promise<string[]> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("no body");
  }
  const decoder = new TextDecoder();
  let text = "";
  const lines: string[] = [];
  while (lines.length < wanted) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
    lines.length = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ") && line.length > 6) {
        lines.push(line.slice(6));
      }
    }
  }
  await reader.cancel();
  return lines;
}

describe("board server routes for the UI", () => {
  let dir: string;
  let board: Board;
  let ownerToken: string;
  let headers: Record<string, string>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-routes-"));
    const init = await Board.init(dir, { name: "routes" });
    board = init.board;
    ownerToken = init.ownerToken;
    headers = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
    await board.addProject(OWNER, { slug: "demo" });
    await board.addAgent(OWNER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("exposes scheduler state with pause, resume, and manual wakes", async () => {
    const app = createApp({
      board,
      version: "t",
      scheduler: { pendingPairs: ["eng-1/demo"], runningPairs: [] },
    });
    const state = z.object({
      paused: z.boolean(),
      running: z.array(z.string()),
      pending: z.array(z.string()),
    });
    expect(state.parse(await (await app.request("/api/scheduler", { headers })).json())).toEqual({
      paused: false,
      running: [],
      pending: ["eng-1/demo"],
    });
    expect((await app.request("/api/pause", { method: "POST", headers })).status).toBe(200);
    expect(
      state.parse(await (await app.request("/api/scheduler", { headers })).json()).paused,
    ).toBe(true);
    expect((await app.request("/api/resume", { method: "POST", headers })).status).toBe(200);

    const wake = await app.request("/api/wake", {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "eng-1", project: "demo", reason: "from the ui" }),
    });
    expect(wake.status).toBe(200);
    expect(z.object({ type: z.string() }).parse(await wake.json()).type).toBe("wake.requested");

    const engToken = (
      await board.addAgent(OWNER, { name: "eng-2", role: "engineer", cli: "claude" })
    ).token;
    const forbidden = await app.request("/api/pause", {
      method: "POST",
      headers: { authorization: `Bearer ${engToken}` },
    });
    expect(forbidden.status).toBe(403);
  });

  it("serves dashboards, runners, roles, proposals, and the caller's inbox", async () => {
    const app = createApp({ board, version: "t" });
    const dashboard = z
      .object({ body: z.string() })
      .parse(await (await app.request("/api/projects/demo/dashboard", { headers })).json());
    expect(dashboard.body).toContain("dashboard");
    expect(await (await app.request("/api/runners", { headers })).json()).toMatchObject([
      { name: "local" },
    ]);
    expect(
      z
        .array(z.object({ name: z.string() }))
        .parse(await (await app.request("/api/roles", { headers })).json()),
    ).toHaveLength(5);

    await board.propose(
      { name: "eng-1", role: "engineer" },
      { kind: "channel", charter: { project: "demo", name: "design", purpose: "Design talk" } },
    );
    const proposals = z
      .array(z.object({ status: z.string(), kind: z.string() }))
      .parse(await (await app.request("/api/proposals", { headers })).json());
    expect(proposals).toEqual(
      [{ status: "proposed", kind: "channel" }].map((p) => expect.objectContaining(p)),
    );

    await board.postMessage(
      { name: "eng-1", role: "engineer" },
      { channel: "demo/general", body: "@owner please decide" },
    );
    // The owner follows every society channel, so the proposal's governance post is unread too.
    const inbox = z.object({ messages: z.array(z.object({ body: z.string() })) });
    expect(
      inbox.parse(await (await app.request("/api/inbox", { headers })).json()).messages,
    ).toHaveLength(2);
    // A plain read does not advance the cursor; an explicit advance does.
    expect(
      inbox.parse(await (await app.request("/api/inbox", { headers })).json()).messages,
    ).toHaveLength(2);
    await app.request("/api/inbox?advance=true", { headers });
    expect(
      inbox.parse(await (await app.request("/api/inbox", { headers })).json()).messages,
    ).toHaveLength(0);
  });

  it("retires members, edits charters, opens channels, and lists signals", async () => {
    const app = createApp({ board, version: "t" });
    const charter = await app.request("/api/roles/engineer", {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...(await board.readRole("engineer")), maxReplicas: 2 }),
    });
    expect(charter.status).toBe(200);
    expect(z.object({ maxReplicas: z.number() }).parse(await charter.json()).maxReplicas).toBe(2);

    const channel = await app.request("/api/channels", {
      method: "POST",
      headers,
      body: JSON.stringify({ project: "demo", name: "design", purpose: "Design talk" }),
    });
    expect(await channel.json()).toEqual({ channel: "demo/design" });
    expect((await board.readProject("demo")).channels).toContain("design");

    const engToken = (
      await board.addAgent(OWNER, { name: "eng-2", role: "engineer", cli: "claude" })
    ).token;
    const forbidden = await app.request("/api/agents/eng-1/retire", {
      method: "POST",
      headers: { authorization: `Bearer ${engToken}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "no" }),
    });
    expect(forbidden.status).toBe(403);
    const retired = await app.request("/api/agents/eng-1/retire", {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "idle" }),
    });
    expect(retired.status).toBe(200);
    const payload: unknown = await retired.json();
    const agent = z.object({ status: z.string(), retiredReason: z.string() }).parse(payload);
    expect(agent).toEqual({ status: "retired", retiredReason: "idle" });
    expect(JSON.stringify(payload)).not.toContain("tokenHash");

    await board.publishSignal({
      kind: "idle_member",
      key: "idle_member:eng-1",
      summary: "eng-1 has not completed a turn for 3d",
      value: 3,
    });
    const signals = z
      .array(z.object({ signal: z.object({ kind: z.string() }) }))
      .parse(await (await app.request("/api/signals?limit=5", { headers })).json());
    expect(signals.map((record) => record.signal.kind)).toEqual(["idle_member"]);
  });

  it("serves the roster with profiles and the runner's resident pairs", async () => {
    const app = createApp({
      board,
      version: "t",
      scheduler: { pendingPairs: [], runningPairs: [], residentPairs: ["desk/society"] },
    });
    const members = z
      .array(z.object({ name: z.string(), role: z.string(), profile: z.string() }))
      .parse(await (await app.request("/api/members", { headers })).json());
    expect(members.map((m) => m.name).toSorted()).toEqual(["eng-1", "owner"]);
    expect(members.find((m) => m.name === "eng-1")?.profile).toContain("# Profile");
    expect(JSON.stringify(members)).not.toContain("tokenHash");
    const state = z
      .object({ resident: z.array(z.string()) })
      .parse(await (await app.request("/api/scheduler", { headers })).json());
    expect(state.resident).toEqual(["desk/society"]);
  });

  it("replays and streams live turn events", async () => {
    const turns = new TurnHub(10);
    const app = createApp({ board, version: "t", turns });
    turns.push("eng-1", "demo", { type: "text", delta: "hello" });
    turns.push("eng-1", "demo", { type: "tool_call", name: "Bash", input: { command: "ls" } });

    const recent = z.object({
      lastSeq: z.number(),
      events: z.array(z.object({ seq: z.number(), agent: z.string() })),
    });
    const page = recent.parse(await (await app.request("/api/turns/recent", { headers })).json());
    expect(page.lastSeq).toBe(2);
    expect(page.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(
      recent.parse(await (await app.request("/api/turns/recent?since=1", { headers })).json())
        .events,
    ).toHaveLength(1);

    const response = await app.request("/api/turns/stream?since=0", { headers });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    setTimeout(
      () => turns.push("eng-1", "demo", { type: "tool_result", name: "Bash", ok: true }),
      20,
    );
    const frames = await readSse(response, 3);
    expect(
      frames.map((frame) => z.object({ seq: z.number() }).parse(JSON.parse(frame)).seq),
    ).toEqual([1, 2, 3]);
  });

  it("serves the built UI with an index fallback for client routes", async () => {
    const ui = path.join(dir, "ui");
    await mkdir(path.join(ui, "assets"), { recursive: true });
    await writeFile(path.join(ui, "index.html"), "<html>board</html>", "utf8");
    await writeFile(path.join(ui, "assets", "app.js"), "console.log(1)", "utf8");
    const app = createApp({ board, version: "t", staticDir: ui });

    const asset = await app.request("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");

    const deep = await app.request("/projects/demo/tasks/abc");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe("<html>board</html>");

    const escape = await app.request("/../../etc/passwd");
    expect(await escape.text()).toBe("<html>board</html>");

    expect((await app.request("/api/me")).status).toBe(401);
    expect((await app.request("/health")).status).toBe(200);
  });
});
