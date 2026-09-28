import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Board, type Actor } from "./index.js";

const OWNER: Actor = { name: "owner", role: "owner" };
const ENG: Actor = { name: "eng-1", role: "engineer" };
const REV: Actor = { name: "rev-1", role: "reviewer" };

describe("Board", () => {
  let dir: string;
  let clock: Date;
  const now = (): Date => clock;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-"));
    clock = new Date("2026-09-28T10:00:00.000Z");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function society() {
    const { board, ownerToken } = await Board.init(
      dir,
      { name: "test society" },
      { now, leaseMs: 60_000 },
    );
    await board.addProject(OWNER, { slug: "demo" });
    const eng = await board.addAgent(OWNER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const rev = await board.addAgent(OWNER, {
      name: "rev-1",
      role: "reviewer",
      cli: "codex",
      memberships: ["demo"],
    });
    return { board, ownerToken, eng, rev };
  }

  it("initializes a society with seed roles, channels, a local runner, and an owner", async () => {
    const { board, ownerToken } = await society();
    expect((await board.society()).channels).toEqual(["general", "ops", "governance", "decisions"]);
    const roles = (await board.listRoles()).map((role) => role.name).toSorted();
    expect(roles).toEqual(["engineer", "owner", "reviewer", "steward"]);
    expect(board.resolveToken(ownerToken)).toEqual(OWNER);
    expect(board.resolveToken("stl_not-a-token")).toBeNull();
    expect((await board.readProject("demo")).members.toSorted()).toEqual(["eng-1", "rev-1"]);
    await expect(Board.init(dir, { name: "again" })).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
    });
  });

  it("post, claim, review, close: the Phase 0 exit criterion", async () => {
    const { board, eng } = await society();
    expect(board.resolveToken(eng.token)).toEqual(ENG);

    const brief = await board.postMessage(OWNER, {
      channel: "demo/general",
      body: "Brief: build the thing. @eng-1 please start.",
    });
    expect(brief.mentions).toEqual(["eng-1"]);
    const task = await board.createTask(OWNER, {
      project: "demo",
      title: "Build the thing",
      body: "Details.",
    });

    const inbox = await board.readInbox(ENG);
    expect(inbox.messages.map((m) => m.id)).toEqual([brief.id]);
    expect(inbox.cursor).toBe(brief.id);
    expect((await board.readInbox(ENG)).messages).toEqual([]);

    const claimed = await board.claimTask(ENG, { task_id: task.id });
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimedBy).toBe("eng-1");
    expect(claimed.leaseExpiresAt).toBe("2026-09-28T10:01:00.000Z");
    await expect(board.claimTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "CLAIM_CONFLICT",
    });

    await board.openThread(ENG, { task_id: task.id });
    const threadMessage = await board.postMessage(ENG, {
      channel: "demo/general",
      body: "Working on it.",
      thread_id: task.id,
    });
    expect(threadMessage.thread).toBe(task.id);
    const reviewerInbox = await board.readInbox(REV);
    expect(reviewerInbox.messages.map((m) => m.id)).toEqual([brief.id]);

    await board.updateTask(ENG, { task_id: task.id, status: "in_review", note: "PR ready" });
    await expect(board.updateTask(ENG, { task_id: task.id, status: "done" })).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    const done = await board.updateTask(REV, { task_id: task.id, status: "done" });
    expect(done.status).toBe("done");
    expect(done.leaseExpiresAt).toBeUndefined();
    expect(done.body).toContain("@eng-1: PR ready");

    const summary = await board.closeThread(REV, { thread_id: task.id, summary: "Shipped." });
    expect(summary.task).toBe(task.id);
    expect((await board.getTask(ENG, { task_id: task.id })).thread).toBe("closed");
    expect((await board.listChannel("demo/general")).map((m) => m.id)).toEqual([
      brief.id,
      summary.id,
    ]);
    expect((await board.listThread(task.id)).map((m) => m.id)).toEqual([threadMessage.id]);

    const types = (await board.readEvents(null)).map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "society.initialized",
        "project.added",
        "agent.added",
        "message.posted",
        "task.created",
        "task.claimed",
        "thread.opened",
        "task.updated",
        "thread.closed",
      ]),
    );
  });

  it("treats claims as leases: expired ones can be taken over and are released by the sweep", async () => {
    const { board } = await society();
    const task = await board.createTask(OWNER, { project: "demo", title: "t" });
    await board.claimTask(ENG, { task_id: task.id });
    clock = new Date(clock.getTime() + 61_000);
    const taken = await board.claimTask(REV, { task_id: task.id });
    expect(taken.claimedBy).toBe("rev-1");
    clock = new Date(clock.getTime() + 61_000);
    const expired = await board.expireLeases();
    expect(expired.map((t) => t.id)).toEqual([task.id]);
    const reopened = await board.getTask(OWNER, { task_id: task.id });
    expect(reopened.status).toBe("open");
    expect(reopened.claimedBy).toBeUndefined();
    expect((await board.readEvents(null)).filter((e) => e.type === "lease.expired")).toHaveLength(
      2,
    );
  });

  it("enforces role charters and legal transitions", async () => {
    const { board } = await society();
    await expect(
      board.approve(ENG, { proposal_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const task = await board.createTask(ENG, { project: "demo", title: "t" });
    await expect(board.updateTask(ENG, { task_id: task.id, status: "done" })).rejects.toMatchObject(
      { code: "INVALID_TRANSITION" },
    );
    await expect(
      board.updateTask(ENG, { task_id: task.id, status: "claimed" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(board.postMessage(ENG, { channel: "demo/nope", body: "x" })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await board.claimTask(ENG, { task_id: task.id });
    await expect(board.releaseTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await board.releaseTask(ENG, { task_id: task.id })).status).toBe("open");
  });

  it("validates proposals by kind, forbids self-decisions, and reserves hiring for the owner", async () => {
    const { board } = await society();
    await board.addAgent(OWNER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };

    await expect(
      board.propose(ENG, { kind: "member", charter: { name: "x" } }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const hire = await board.propose(STEW, {
      kind: "member",
      charter: { name: "eng-2", role: "engineer", cli: "codex", memberships: ["demo"] },
      rationale: "Backlog is growing.",
    });
    expect(hire.status).toBe("proposed");
    await expect(board.approve(STEW, { proposal_id: hire.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await board.approve(OWNER, { proposal_id: hire.id })).outcome).toBe("approved");
    expect((await board.readProposal(hire.id)).status).toBe("approved");
    await expect(
      board.reject(OWNER, { proposal_id: hire.id, reason: "late" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    const channel = await board.propose(ENG, {
      kind: "channel",
      charter: { project: "demo", name: "design", purpose: "Design discussion" },
    });
    expect((await board.approve(STEW, { proposal_id: channel.id })).outcome).toBe("approved");
  });

  it("searches messages and tasks, and only the owner can pause", async () => {
    const { board } = await society();
    await board.postMessage(ENG, { channel: "demo/dev", body: "The pagination cursor is base64." });
    await board.createTask(ENG, { project: "demo", title: "Fix pagination", body: "cursor bug" });
    const hits = await board.search(ENG, { query: "pagination" });
    expect(hits.map((hit) => hit.kind).toSorted()).toEqual(["message", "task"]);
    expect(await board.isPaused()).toBe(false);
    await board.setPaused(OWNER, true);
    expect(await board.isPaused()).toBe(true);
    await expect(board.setPaused(ENG, false)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reopens with the token index intact", async () => {
    const { eng } = await society();
    const reopened = await Board.open(dir);
    expect(reopened.resolveToken(eng.token)).toEqual(ENG);
    await expect(Board.open(path.join(dir, "nowhere"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
