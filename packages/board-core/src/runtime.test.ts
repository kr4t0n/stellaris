import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MEMBER_VERBS } from "@stellaris/shared";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Board, type Actor } from "./index.js";

const USER: Actor = { name: "user", role: "user" };

function b64(text: string): string {
  return Buffer.from(text).toString("base64");
}
const ENG: Actor = { name: "eng-1", role: "engineer" };

describe("Board runtime support", () => {
  let dir: string;
  let clock: Date;
  const now = (): Date => clock;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-rt-"));
    clock = new Date("2026-09-28T10:00:00.000Z");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function society() {
    const { board } = await Board.init(dir, { name: "rt" }, { now });
    await board.addProject(USER, { slug: "demo" });
    for (const role of ["engineer", "reviewer"]) {
      await board.setRoleCharter(USER, {
        name: role,
        purpose: `The ${role} of the test society.`,
        verbs: [...MEMBER_VERBS],
        wakeTriggers: ["heartbeat"],
      });
    }
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    await board.addAgent(USER, {
      name: "rev-1",
      role: "reviewer",
      cli: "codex",
      memberships: ["demo"],
    });
    await board.addAgent(USER, { name: "eng-2", role: "engineer", cli: "claude" });
    return board;
  }

  it("issues turn tokens that resolve until they expire", async () => {
    const board = await society();
    const token = board.issueTurnToken("eng-1", "engineer", 60_000);
    expect(board.resolveToken(token)).toEqual(ENG);
    clock = new Date(clock.getTime() + 60_001);
    expect(board.resolveToken(token)).toBeNull();
  });

  it("adds runners with a token, places a project once, and survives a reopen", async () => {
    const board = await society();
    await expect(board.addRunner(ENG, "pod")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { runner, token } = await board.addRunner(USER, "pod");
    expect(runner).toMatchObject({ name: "pod", status: "disconnected", clis: [] });
    await expect(board.addRunner(USER, "pod")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    expect(board.resolveRunnerToken(token)).toBe("pod");
    expect(board.resolveRunnerToken("stl_nothing")).toBeNull();
    // The token's hash stays out of the projection agents read.
    expect(JSON.stringify(await board.boardManifest())).not.toContain("tokenHash");
    expect((await Board.open(dir, { now })).resolveRunnerToken(token)).toBe("pod");

    await board.addRunner(USER, "laptop");
    await expect(board.placeProject("demo", "nowhere")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await board.placeProject("demo", "pod")).toBe("pod");
    expect(await board.placeProject("demo", "laptop")).toBe("pod");
    expect((await board.readProject("demo")).runner).toBe("pod");
    const placed = (await board.readEvents(null, 500)).filter((e) => e.type === "project.placed");
    expect(placed.map((event) => event.payload)).toEqual([{ slug: "demo", runner: "pod" }]);
  });

  it("serves an agent's home and the projection as files, and takes back only what the agent authors", async () => {
    const board = await society();
    const home = board.paths.agent("eng-1");
    await writeFile(path.join(home, "profile.md"), "Builds things.\n");
    await board.writeSession("eng-1", "demo", "claude", "s-1", "pod");
    const manifest = await board.homeManifest("eng-1");
    expect(Object.keys(manifest).toSorted()).toEqual([
      "memory/core.md",
      "profile.md",
      "projects/demo/notes.md",
      "role.md",
    ]);
    const files = await board.readHomeFiles("eng-1", ["profile.md", "agent.json", "../secret"]);
    expect(Object.keys(files)).toEqual(["profile.md"]);
    expect(Buffer.from(files["profile.md"] ?? "", "base64").toString("utf8")).toBe(
      "Builds things.\n",
    );

    await board.writeHomeFiles("eng-1", {
      put: {
        "skills/uv/SKILL.md": b64("---\nname: uv\n---\n"),
        "memory/core.md": b64("- a lesson\n"),
      },
      delete: ["profile.md"],
    });
    expect(await readFile(path.join(home, "memory", "core.md"), "utf8")).toBe("- a lesson\n");
    expect(Object.keys(await board.homeManifest("eng-1")).toSorted()).toEqual([
      "memory/core.md",
      "projects/demo/notes.md",
      "role.md",
      "skills/uv/SKILL.md",
    ]);
    // The board's own records and the charter never come back from a runner.
    for (const kept of ["agent.json", "role.md", "projects/demo/sessions.json", "../escape"]) {
      await expect(
        board.writeHomeFiles("eng-1", { put: { [kept]: b64("{}") }, delete: [] }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect((await board.readAgent("eng-1")).name).toBe("eng-1");

    const projection = await board.boardManifest();
    expect(Object.keys(projection)).toContain("projects/demo/project.md");
    const read = await board.readBoardFiles(["projects/demo/project.md"]);
    expect(
      Buffer.from(read["projects/demo/project.md"] ?? "", "base64").toString("utf8"),
    ).toContain("slug: demo");
  });

  it("dispatches verbs by name and records manual wakes as events", async () => {
    const board = await society();
    const created = await board.invoke(ENG, "create_task", { project: "demo", title: "t" });
    expect(z.object({ id: z.string() }).parse(created).id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const wake = await board.requestWake(USER, { agent: "eng-1", project: "demo" });
    expect(wake.type).toBe("wake.requested");
    await expect(
      board.requestWake(USER, { agent: "eng-2", project: "demo" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(board.requestWake(ENG, { agent: "eng-1", project: "demo" })).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
  });

  it("answers membership, role, and claim queries", async () => {
    const board = await society();
    expect((await board.projectMembers("demo")).map((a) => a.name).toSorted()).toEqual([
      "eng-1",
      "rev-1",
      "user",
    ]);
    expect((await board.membersWithRole("demo", "engineer")).map((a) => a.name)).toEqual(["eng-1"]);
    const task = await board.createTask(USER, { project: "demo", title: "t" });
    expect(await board.heldClaims("eng-1")).toEqual([]);
    await board.claimTask(ENG, { task_id: task.id });
    expect((await board.heldClaims("eng-1")).map((t) => t.id)).toEqual([task.id]);
    expect(await board.openTasks("demo")).toEqual([]);
  });

  it("keeps sessions, turn records, cursors, and state files", async () => {
    const board = await society();
    expect(await board.readSessions("eng-1", "demo")).toEqual({});
    await board.writeSession(
      "eng-1",
      "demo",
      "claude",
      "11111111-1111-4111-8111-111111111111",
      "pod",
    );
    expect(await board.readSessions("eng-1", "demo")).toEqual({
      claude: "11111111-1111-4111-8111-111111111111",
      runner: "pod",
    });
    // A session begun on another runner replaces the record: sessions stay where they began.
    await board.writeSession("eng-1", "demo", "codex", "thread-2", "laptop");
    expect(await board.readSessions("eng-1", "demo")).toEqual({
      codex: "thread-2",
      runner: "laptop",
    });

    expect(await board.readLastTurn("eng-1", "demo")).toBeNull();
    const record = {
      agent: "eng-1",
      project: "demo",
      runner: "server",
      cli: "claude" as const,
      session: "11111111-1111-4111-8111-111111111111",
      trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
      startedAt: clock.toISOString(),
      endedAt: null,
      exitReason: null,
      status: null,
      error: null,
      usage: null,
      costUsd: 0,
      toolCalls: 0,
      model: null,
    };
    await board.beginTurn(record);
    await board.finishTurn({
      ...record,
      endedAt: clock.toISOString(),
      exitReason: "error",
      error: "boom",
    });
    const last = await board.readLastTurn("eng-1", "demo");
    expect(last?.error).toBe("boom");
    const types = (await board.readEvents(null)).map((e) => e.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("turn.failed");

    await board.setDigestCursor("eng-1", "demo", null);
    expect(await board.readMemoryCore("eng-1")).toContain("Core memory");
    expect(await board.readAgentRoleBody("eng-1")).toContain("engineer");

    const schema = z.object({ cursor: z.string().nullable() });
    expect(await board.readState("scheduler", schema, { cursor: null })).toEqual({ cursor: null });
    await board.writeState("scheduler", { cursor: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(await board.readState("scheduler", schema, { cursor: null })).toEqual({
      cursor: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
  });
});
