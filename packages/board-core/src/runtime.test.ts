import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MEMBER_VERBS } from "@stellaris/shared";
import { execa } from "execa";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Board, type Actor } from "./index.js";

const USER: Actor = { name: "user", role: "user" };

/** Git as eng-1, never throwing, for the home repository tests. */
function git(cwd: string, ...args: string[]) {
  return execa(
    "git",
    ["-c", "user.name=eng-1", "-c", "user.email=eng-1@stellaris.local", ...args],
    {
      cwd,
      reject: false,
    },
  );
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

  it("keeps each citizen's home as a repository whose working tree takes pushes and refuses the board's records", async () => {
    const board = await society();
    const home = board.paths.agent("eng-1");
    // Created as the home's first commit: what the citizen authors, and the ignore file.
    expect((await git(home, "ls-files")).stdout.split("\n").toSorted()).toEqual([
      ".gitignore",
      "memory/core.md",
      "profile.md",
    ]);
    // The board's own writes since, a session record and a joined project, leave the tree clean.
    await board.writeSession("eng-1", "demo", "claude", "s-1", "pod");
    await board.addProject(USER, { slug: "lab" });
    await board.joinProject(USER, { project: "lab", agent: "eng-1" });
    expect((await git(home, "status", "--porcelain")).stdout).toBe("");
    await expect(board.ensureHomeRepo("user")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await board.ensureHomeRepo("eng-1")).toBe(home);

    // A runner's push lands in the working tree the board reads.
    const copy = path.join(dir, "runner-copy");
    expect((await git(dir, "clone", "--quiet", home, copy)).exitCode).toBe(0);
    await writeFile(path.join(copy, "memory", "core.md"), "- A lesson.\n", "utf8");
    await git(copy, "commit", "--quiet", "-am", "turn 1");
    expect((await git(copy, "push", "--quiet", "origin", "HEAD:main")).exitCode).toBe(0);
    expect(await board.readMemoryCore("eng-1")).toBe("- A lesson.\n");

    // The hook refuses a push that would carry a record the board keeps, or rewrite the ignore file.
    for (const [file, content] of [
      ["agent.json", "{}"],
      ["role.md", "# rewritten"],
      ["projects/demo/sessions.json", "{}"],
      [".gitignore", "*.md\n"],
    ] as const) {
      await git(copy, "reset", "--quiet", "--hard", "origin/main");
      await mkdir(path.dirname(path.join(copy, file)), { recursive: true });
      await writeFile(path.join(copy, file), content, "utf8");
      await git(copy, "add", "--force", "--", file);
      await git(copy, "commit", "--quiet", "-m", `sneak ${file}`);
      const pushed = await git(copy, "push", "--quiet", "origin", "HEAD:main");
      expect(pushed.exitCode).not.toBe(0);
      expect(pushed.stderr).toMatch(/does not take|is the board's/);
    }
    expect((await board.readAgent("eng-1")).role).toBe("engineer");

    // A push that would drop another machine's work, even forced, is refused before it touches the
    // working tree, which stays clean and takes the merged push that follows.
    const other = path.join(dir, "other-copy");
    await git(copy, "reset", "--quiet", "--hard", "origin/main");
    expect((await git(dir, "clone", "--quiet", home, other)).exitCode).toBe(0);
    await writeFile(path.join(copy, "profile.md"), "From the first machine.\n", "utf8");
    await git(copy, "commit", "--quiet", "-am", "turn 2");
    expect((await git(copy, "push", "--quiet", "origin", "HEAD:main")).exitCode).toBe(0);
    await writeFile(path.join(other, "memory", "core.md"), "- From the second machine.\n", "utf8");
    await git(other, "commit", "--quiet", "-am", "turn 3");
    const stale = await git(other, "push", "--quiet", "--force", "origin", "HEAD:main");
    expect(stale.exitCode).not.toBe(0);
    expect((await git(home, "status", "--porcelain")).stdout).toBe("");
    await git(other, "pull", "--quiet", "--no-rebase", "--no-edit", "origin", "main");
    expect((await git(other, "push", "--quiet", "origin", "HEAD:main")).exitCode).toBe(0);
    expect(await board.readMemoryCore("eng-1")).toBe("- From the second machine.\n");
    expect(await board.readProfile("eng-1")).toContain("From the first machine.");
    // Only main moves.
    await git(copy, "reset", "--quiet", "--hard", "origin/main");
    expect(
      (await git(copy, "push", "--quiet", "origin", "HEAD:refs/heads/side")).exitCode,
    ).not.toBe(0);

    const projection = await board.boardManifest();
    expect(Object.keys(projection)).toContain("projects/demo/project.md");
    const read = await board.readBoardFiles(["projects/demo/project.md"]);
    expect(
      Buffer.from(read["projects/demo/project.md"] ?? "", "base64").toString("utf8"),
    ).toContain("slug: demo");
  });

  it("pins a citizen's work outside projects to a runner once, moves it on request, and lets the user choose", async () => {
    const board = await society();
    await board.addRunner(USER, "pod");
    await board.addRunner(USER, "laptop");
    expect(await board.pinAgent("eng-1", "pod")).toBe("pod");
    expect(await board.pinAgent("eng-1", "laptop")).toBe("pod");
    // A move names where the pin was, so two turns that find it gone move it once.
    expect(await board.pinAgent("eng-1", "laptop", "pod")).toBe("laptop");
    expect(await board.pinAgent("eng-1", "pod", "pod")).toBe("laptop");
    const placed = (await board.readEvents(null, 500)).filter((e) => e.type === "agent.placed");
    expect(placed.map((event) => event.payload)).toEqual([
      { agent: "eng-1", runner: "pod" },
      { agent: "eng-1", runner: "laptop", from: "pod" },
    ]);

    await expect(board.setAgentRunner(ENG, "eng-1", "pod")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(board.setAgentRunner(USER, "eng-1", "nowhere")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await board.setAgentRunner(USER, "eng-1", "pod")).homeRunner).toBe("pod");
    expect((await board.listMembers()).find((m) => m.name === "eng-1")?.homeRunner).toBe("pod");
    expect((await board.setAgentRunner(USER, "eng-1", null)).homeRunner).toBeUndefined();
    const configured = (await board.readEvents(null, 500)).filter(
      (e) => e.type === "agent.configured",
    );
    expect(configured.map((event) => event.payload)).toEqual([
      { agent: "eng-1", homeRunner: "pod", previous: "laptop" },
      { agent: "eng-1", homeRunner: null, previous: "pod" },
    ]);
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
