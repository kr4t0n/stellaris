import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MEMBER_VERBS } from "@stellaris/shared";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Board, type Actor } from "./index.js";

const USER: Actor = { name: "user", role: "user" };
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
    await board.writeSession("eng-1", "demo", "claude", "11111111-1111-4111-8111-111111111111");
    expect(await board.readSessions("eng-1", "demo")).toEqual({
      claude: "11111111-1111-4111-8111-111111111111",
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
