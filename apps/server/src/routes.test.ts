import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { TranscriptEntrySchema, TurnHistoryEntrySchema } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "./app.js";
import { addWorkRoles } from "./testing/scripted-backend.js";
import { TurnHub } from "./turn-hub.js";

const USER = { name: "user", role: "user" } as const;

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

describe("board server routes", () => {
  let dir: string;
  let board: Board;
  let userToken: string;
  let headers: Record<string, string>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-routes-"));
    const init = await Board.init(dir, { name: "routes" });
    board = init.board;
    userToken = init.userToken;
    headers = { authorization: `Bearer ${userToken}`, "content-type": "application/json" };
    await board.addProject(USER, { slug: "demo", channels: ["general", "dev"] });
    await addWorkRoles(board);
    await board.addAgent(USER, {
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
      await board.addAgent(USER, { name: "eng-2", role: "engineer", cli: "claude" })
    ).token;
    const forbidden = await app.request("/api/pause", {
      method: "POST",
      headers: { authorization: `Bearer ${engToken}` },
    });
    expect(forbidden.status).toBe(403);
  });

  it("serves dashboards, runners, roles, and proposals, and no inbox", async () => {
    const app = createApp({ board, version: "t" });
    const dashboard = z
      .object({ body: z.string() })
      .parse(await (await app.request("/api/projects/demo/dashboard", { headers })).json());
    expect(dashboard.body).toContain("dashboard");
    expect(await (await app.request("/api/runners", { headers })).json()).toMatchObject([
      { name: "server" },
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

    // The digest is the agents' view, read by the runner; the user follows the board itself.
    expect((await app.request("/api/inbox", { headers })).status).toBe(404);
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
      await board.addAgent(USER, { name: "eng-2", role: "engineer", cli: "claude" })
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

  it("serves knowledge per project and for the society, the society's skills, and reflection wakes", async () => {
    const app = createApp({ board, version: "t" });
    await board.writeKnowledge(USER, {
      project: "demo",
      topic: "testing",
      body: "Run the tests with uv.",
    });
    await board.writeKnowledge(USER, { project: null, topic: "norms", body: "Be brief." });
    const topics = z.array(
      z.object({ topic: z.string(), project: z.string().nullable(), body: z.string() }),
    );
    expect(
      topics.parse(await (await app.request("/api/projects/demo/knowledge", { headers })).json()),
    ).toMatchObject([
      {
        topic: "testing",
        project: "demo",
        body: expect.stringContaining("Run the tests with uv."),
      },
    ]);
    expect(
      topics.parse(await (await app.request("/api/society/knowledge", { headers })).json()),
    ).toMatchObject([{ topic: "norms", project: null }]);

    const proposal = await board.propose(USER, {
      kind: "skill",
      charter: { name: "release", summary: "Cut a release", body: "Tag, build, publish." },
      rationale: "Every project releases the same way.",
    });
    const stewToken = (await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" }))
      .token;
    await board.approve({ name: "stew", role: "steward" }, { proposal_id: proposal.id });
    const skills = z
      .array(z.object({ name: z.string(), summary: z.string(), scope: z.string() }))
      .parse(await (await app.request("/api/skills", { headers })).json());
    expect(skills).toMatchObject([{ name: "release", summary: "Cut a release", scope: "society" }]);
    expect(stewToken).toMatch(/^stl_/);

    const wake = await app.request("/api/wake", {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "eng-1", project: "demo", kind: "reflection" }),
    });
    expect(wake.status).toBe(200);
    expect(
      z.object({ payload: z.object({ kind: z.string() }) }).parse(await wake.json()).payload.kind,
    ).toBe("reflection");
  });

  it("lists each CLI's models and sets a citizen's model for its next turn", async () => {
    const app = createApp({
      board,
      version: "t",
      models: {
        list: (cli) =>
          Promise.resolve(
            cli === "claude"
              ? [{ id: "sonnet", name: "Sonnet 5", description: "", isDefault: false }]
              : [],
          ),
      },
    });
    expect(
      z
        .array(z.object({ id: z.string() }))
        .parse(await (await app.request("/api/models/claude", { headers })).json()),
    ).toEqual([expect.objectContaining({ id: "sonnet" })]);
    expect((await app.request("/api/models/gemini", { headers })).status).toBe(400);

    const set = await app.request("/api/agents/eng-1/model", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "sonnet" }),
    });
    expect(set.status).toBe(200);
    const agent = z.record(z.string(), z.unknown()).parse(await set.json());
    expect(agent["model"]).toBe("sonnet");
    expect(agent["tokenHash"]).toBeUndefined();
    expect((await board.readAgent("eng-1")).model).toBe("sonnet");

    const cleared = await app.request("/api/agents/eng-1/model", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: null }),
    });
    expect(cleared.status).toBe(200);
    expect((await board.readAgent("eng-1")).model).toBeUndefined();
    expect(
      (
        await app.request("/api/agents/eng-1/model", {
          method: "PUT",
          headers,
          body: JSON.stringify({ model: "two words" }),
        })
      ).status,
    ).toBe(400);
  });

  it("serves a citizen's turn history and memory core", async () => {
    const app = createApp({ board, version: "t" });
    const turn = {
      agent: "eng-1",
      project: "demo",
      runner: "server",
      cli: "claude" as const,
      session: "s",
      trigger: { kind: "mention" as const, from: "user", fromUser: true, reason: "asked" },
      startedAt: "2026-09-28T10:00:00.000Z",
      endedAt: "2026-09-28T10:01:00.000Z",
      exitReason: "completed" as const,
      status: {
        summary: "shipped it",
        claimsHeld: [],
        blockedOn: [],
        needsUserDecision: false,
        memoryUpdated: false,
      },
      error: null,
      usage: null,
      costUsd: 0.25,
      toolCalls: 3,
      model: "claude-sonnet-5",
    };
    const begun = await board.beginTurn(turn);
    const steps = [
      {
        ts: "2026-09-28T10:00:05.000Z",
        event: { type: "tool_call", name: "Bash", input: { command: "ls" } },
      },
      {
        ts: "2026-09-28T10:00:06.000Z",
        event: { type: "tool_result", name: "Bash", ok: true, output: "src" },
      },
    ] as const;
    await board.finishTurn(begun, [...steps]);
    const second = await board.beginTurn({ ...turn, startedAt: "2026-09-28T11:00:00.000Z" });
    await board.finishTurn({
      ...second,
      exitReason: "error",
      status: null,
      error: "boom",
    });
    const turns = TurnHistoryEntrySchema.array().parse(
      await (await app.request("/api/agents/eng-1/turns?limit=10", { headers })).json(),
    );
    expect(turns).toEqual([
      expect.objectContaining({
        outcome: "completed",
        trigger: "mention",
        costUsd: 0.25,
        model: "claude-sonnet-5",
        summary: "shipped it",
        toolCalls: 3,
      }),
      expect.objectContaining({ outcome: "failed", error: "boom" }),
    ]);
    // Each finished turn is paired with the start the log recorded for its scope.
    for (const entry of turns) {
      expect(entry.startedAt !== undefined && entry.startedAt <= entry.ts).toBe(true);
    }
    // The first turn kept its steps under the id the board gave it when it began.
    expect(turns[0]?.turnId).toBe(begun.id);
    expect(
      TranscriptEntrySchema.array().parse(
        await (await app.request(`/api/agents/eng-1/turns/${begun.id}`, { headers })).json(),
      ),
    ).toEqual(steps);
    expect(turns[1]?.turnId).toBeDefined();
    expect(
      (await app.request(`/api/agents/eng-1/turns/${turns[1]?.turnId}`, { headers })).status,
    ).toBe(404);
    expect((await app.request("/api/agents/eng-1/turns/..%2F..%2Fagent", { headers })).status).toBe(
      404,
    );
    expect(
      z
        .array(z.unknown())
        .parse(await (await app.request("/api/agents/eng-1/skills", { headers })).json()),
    ).toEqual([]);
    expect((await app.request("/api/agents/nobody/skills", { headers })).status).toBe(404);
    expect(
      z
        .object({ body: z.string() })
        .parse(await (await app.request("/api/agents/eng-1/memory", { headers })).json()).body,
    ).toContain("Core memory");
    expect((await app.request("/api/agents/nobody/memory", { headers })).status).toBe(404);
  });

  it("serves the roster with profiles and the runner's resident pairs", async () => {
    const app = createApp({
      board,
      version: "t",
      scheduler: {
        pendingPairs: [],
        runningPairs: [],
        residentPairs: ["desk/society"],
        activeSignals: ["backlog:demo:engineer"],
      },
    });
    const members = z
      .array(z.object({ name: z.string(), role: z.string(), profile: z.string() }))
      .parse(await (await app.request("/api/members", { headers })).json());
    expect(members.map((m) => m.name).toSorted()).toEqual(["eng-1", "user"]);
    expect(members.find((m) => m.name === "eng-1")?.profile).toContain("# Profile");
    expect(JSON.stringify(members)).not.toContain("tokenHash");
    const state = z
      .object({ resident: z.array(z.string()), signals: z.array(z.string()) })
      .parse(await (await app.request("/api/scheduler", { headers })).json());
    expect(state.resident).toEqual(["desk/society"]);
    expect(state.signals).toEqual(["backlog:demo:engineer"]);
  });

  it("lists channels with their newest message, and streams board events from the log's end", async () => {
    const app = createApp({ board, version: "t" });
    const before = await board.postMessage(USER, { channel: "demo/general", body: "earlier" });
    const channels = z
      .array(
        z.object({
          ref: z.string(),
          project: z.string().nullable(),
          messages: z.number(),
          lastMessageId: z.string().nullable(),
        }),
      )
      .parse(await (await app.request("/api/channels", { headers })).json());
    expect(channels.map((channel) => channel.ref)).toEqual([
      "general",
      "governance",
      "demo/general",
      "demo/dev",
    ]);
    expect(channels.find((channel) => channel.ref === "demo/general")).toMatchObject({
      project: "demo",
      messages: 1,
      lastMessageId: before.id,
    });

    const response = await app.request("/api/events/stream?since=latest", { headers });
    setTimeout(() => {
      void board.postMessage(USER, { channel: "demo/dev", body: "later" });
    }, 20);
    const [frame] = await readSse(response, 1);
    const event = z
      .object({ type: z.string(), payload: z.object({ channel: z.string() }) })
      .parse(JSON.parse(frame ?? "{}"));
    // Nothing from before the stream opened is replayed.
    expect(event).toMatchObject({ type: "message.posted", payload: { channel: "demo/dev" } });
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

  it("serves the built interface, with its own routes loading the page and nothing outside it", async () => {
    const web = path.join(dir, "web");
    await mkdir(path.join(web, "assets"), { recursive: true });
    await writeFile(path.join(web, "index.html"), "<html>sky</html>", "utf8");
    await writeFile(
      path.join(web, "assets", "app-1a2b.js"),
      "console.log(1);\n".repeat(200),
      "utf8",
    );
    await writeFile(path.join(web, "favicon.svg"), "<svg/>", "utf8");
    // A sibling whose name starts with the build directory's must stay out of reach.
    await mkdir(path.join(dir, "web-secret"));
    await writeFile(path.join(dir, "web-secret", "token"), "secret", "utf8");
    const app = createApp({ board, version: "t", webDir: web });

    const asset = await app.request("/assets/app-1a2b.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    const zipped = await app.request("/assets/app-1a2b.js", {
      headers: { "accept-encoding": "gzip, deflate, br" },
    });
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    const unzipped = zipped.body?.pipeThrough(new DecompressionStream("gzip"));
    expect(await new Response(unzipped).text()).toContain("console.log(1);");
    const icon = await app.request("/favicon.svg");
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("cache-control")).toBe("no-cache");

    for (const route of ["/", "/task/01M3Q2AAAAAAAAAAAAAAAAAAA1", "/c/lab/general"]) {
      const page = await app.request(route);
      expect(page.status).toBe(200);
      expect(await page.text()).toBe("<html>sky</html>");
    }

    for (const escape of [
      "/../web-secret/token",
      "/%2e%2e/web-secret/token",
      "/..%2fweb-secret/token",
    ]) {
      expect(await (await app.request(escape)).text()).not.toContain("secret");
    }
    expect((await app.request("/%E0%A4%A")).status).toBe(200);

    // A chunk a rebuild removed is missing, not the page.
    expect((await app.request("/assets/app-old.js")).status).toBe(404);

    const unknown = await app.request("/api/nothing-here", { headers });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "NOT_FOUND" });
    expect((await app.request("/api/me")).status).toBe(401);
    expect((await app.request("/health")).status).toBe(200);
  });

  it("serves the society's metrics for a window, and refuses a window it does not know", async () => {
    const app = createApp({ board, version: "t" });
    const week = await app.request("/api/metrics", { headers });
    expect(week.status).toBe(200);
    expect(await week.json()).toMatchObject({
      window: "7d",
      idle: { turns: 0, idle: 0, unknown: 0 },
      sentBack: { finished: 0 },
      latency: { medianMs: null },
      blocked: [],
    });
    expect((await app.request("/api/metrics?window=all", { headers })).status).toBe(200);
    expect((await app.request("/api/metrics?window=year", { headers })).status).toBe(400);
  });

  it("says the interface is not built when its directory has no page", async () => {
    const app = createApp({ board, version: "t", webDir: path.join(dir, "missing") });
    const page = await app.request("/");
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("pnpm build:web");
  });
});
