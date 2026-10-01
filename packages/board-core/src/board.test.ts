import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MEMBER_VERBS, type Ulid } from "@stellaris/shared";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Board, SYSTEM_ACTOR, type Actor } from "./index.js";

const USER: Actor = { name: "user", role: "user" };
const ENG: Actor = { name: "eng-1", role: "engineer" };
const REV: Actor = { name: "rev-1", role: "reviewer" };

/** A turn record of eng-1 in demo, in a thread's conversation or at home. */
/** A tool's result as a turn's transcript keeps it. */
const result = (name: string, ok: boolean) => ({
  ts: "2026-09-28T10:00:30.000Z",
  event: { type: "tool_result" as const, name, ok },
});

const turnIn = (thread: Ulid | undefined, at: string) => ({
  agent: "eng-1",
  project: "demo",
  ...(thread === undefined ? {} : { thread }),
  runner: "server",
  cli: "claude" as const,
  session: thread === undefined ? "home-session" : "task-session",
  trigger: { kind: "manual" as const, fromUser: true, reason: "" },
  startedAt: at,
  endedAt: null,
  exitReason: null,
  status: null,
  error: null,
  usage: null,
  costUsd: 0,
  toolCalls: 0,
  model: null,
});

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
    const { board, userToken } = await Board.init(
      dir,
      { name: "test society" },
      { now, leaseMs: 60_000 },
    );
    // A second channel, beside the default general, for topics that do not belong in it.
    await board.addProject(USER, { slug: "demo", channels: ["general", "dev"] });
    for (const role of ["engineer", "reviewer"]) {
      await board.setRoleCharter(USER, {
        name: role,
        purpose: `The ${role} of the test society.`,
        verbs: [...MEMBER_VERBS],
        wakeTriggers: ["heartbeat"],
      });
    }
    const eng = await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const rev = await board.addAgent(USER, {
      name: "rev-1",
      role: "reviewer",
      cli: "codex",
      memberships: ["demo"],
    });
    return { board, userToken, eng, rev };
  }

  it("initializes a society with seed roles, channels, the server runner, and a user", async () => {
    const { board, userToken } = await society();
    expect((await board.society()).channels).toEqual(["general", "governance"]);
    const roles = (await board.listRoles()).map((role) => role.name).toSorted();
    expect(roles).toEqual(["concierge", "engineer", "reviewer", "steward", "user"]);
    expect(board.resolveToken(userToken)).toEqual(USER);
    expect(board.resolveToken("stl_not-a-token")).toBeNull();
    // The user takes no turns and reads no digest, so it follows no channel.
    expect((await board.readAgent("user")).subscriptions).toEqual([]);
    expect((await board.readProject("demo")).members.toSorted()).toEqual(["eng-1", "rev-1"]);
    await expect(Board.init(dir, { name: "again" })).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
    });
  });

  it("post, claim, review, close: the Phase 0 exit criterion", async () => {
    const { board, eng } = await society();
    expect(board.resolveToken(eng.token)).toEqual(ENG);

    const brief = await board.postMessage(USER, {
      channel: "demo/general",
      body: "Brief: build the thing. @eng-1 please start.",
    });
    expect(brief.mentions).toEqual(["eng-1"]);
    const task = await board.createTask(USER, {
      project: "demo",
      title: "Build the thing",
      body: "Details.",
      stages: [
        { name: "build", role: "engineer" },
        { name: "review", role: "reviewer", gate: true },
      ],
    });
    expect(task.stages.map((stage) => [stage.id, stage.name])).toEqual([
      ["s1", "build"],
      ["s2", "review"],
    ]);
    expect(task).toMatchObject({ status: "open", stage: "s1", onDone: "none" });

    const digest = await board.readDigest(ENG);
    expect(digest.messages.map((m) => m.id)).toEqual([brief.id]);
    expect(digest.cursor).toBe(brief.id);
    expect((await board.readDigest(ENG)).messages).toEqual([]);

    await expect(board.claimTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const claimed = await board.claimTask(ENG, { task_id: task.id });
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimedBy).toBe("eng-1");
    expect(claimed.leaseExpiresAt).toBe("2026-09-28T10:01:00.000Z");
    await expect(board.claimTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "CLAIM_CONFLICT",
    });

    // The task's thread opened with it, on the project's general channel, under the task's id.
    expect(await board.readThread(task.id)).toMatchObject({
      channel: "demo/general",
      state: "open",
      openedBy: "user",
      subject: { kind: "task", id: task.id },
    });
    await expect(board.openThread(ENG, { task_id: task.id })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    const threadMessage = await board.postMessage(ENG, {
      body: "Working on it.",
      thread_id: task.id,
    });
    expect(threadMessage).toMatchObject({ channel: "demo/general", thread: task.id });
    // The reviewer is not in the thread while the build is held.
    const reviewerDigest = await board.readDigest(REV);
    expect(reviewerDigest.messages.map((m) => m.id)).toEqual([brief.id]);

    const reviewing = await board.advanceTask(ENG, { task_id: task.id, note: "PR ready" });
    expect(reviewing).toMatchObject({ status: "open", stage: "s2" });
    expect(reviewing.body.trim()).toBe("Details.");
    expect(reviewing.claimedBy).toBeUndefined();
    const [, handover] = await board.listThread(task.id);
    expect(handover).toMatchObject({
      author: "eng-1",
      body: "PR ready\n",
      step: { action: "advanced", stage: "s1", to: "s2" },
    });
    // The review waits for the reviewer, which is now in the thread and reads the handover; the
    // step itself does not count toward a heartbeat, the talk before it does.
    expect(await board.unreadByConversation(REV)).toEqual([
      { scope: "demo", thread: task.id, count: 1 },
    ]);
    expect((await board.readDigest(REV, { advance: false })).messages.map((m) => m.id)).toEqual([
      threadMessage.id,
      handover?.id,
    ]);
    await expect(board.claimTask(ENG, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await board.claimTask(REV, { task_id: task.id });
    await expect(
      board.closeThread(REV, { thread_id: task.id, summary: "Shipped." }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await board.getTask(REV, { task_id: task.id })).messages.map((m) => m.body)).toEqual([
      "Working on it.\n",
      "PR ready\n",
    ]);
    const done = await board.advanceTask(REV, { task_id: task.id, note: "Approved." });
    expect(done.status).toBe("done");
    expect(done.leaseExpiresAt).toBeUndefined();
    expect(done.stages.map((stage) => stage.completedBy)).toEqual(["eng-1", "rev-1"]);
    expect(await board.readThread(task.id)).toMatchObject({ state: "closed", closedBy: "rev-1" });
    expect((await board.listThread(task.id)).at(-1)).toMatchObject({
      author: "rev-1",
      step: { action: "advanced", stage: "s2", to: null },
    });
    expect((await board.listChannel("demo/general")).map((m) => m.id)).toEqual([brief.id]);
    await expect(
      board.updateTask(ENG, { task_id: task.id, note: "One more thing." }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

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
        "task.advanced",
        "task.completed",
        "thread.closed",
      ]),
    );
  });

  it("files a citizen's digest by the scope a turn reads it in, with a cursor per scope", async () => {
    const { board } = await society();
    await board.addProject(USER, { slug: "lab" });
    await board.joinProject(USER, { project: "lab", agent: "eng-1" });
    const inDemo = await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 demo" });
    const inLab = await board.postMessage(USER, { channel: "lab/general", body: "@eng-1 lab" });
    const inSociety = await board.postMessage(USER, { channel: "general", body: "@eng-1 news" });
    const ids = async (scope?: string): Promise<Ulid[]> =>
      (
        await board.readDigest(
          { ...ENG, ...(scope === undefined ? {} : { scope }) },
          { advance: false },
        )
      ).messages.map((m) => m.id);

    // A society channel is filed where a mention there wakes eng-1: its first project.
    expect(await ids("demo")).toEqual([inDemo.id, inSociety.id]);
    expect(await ids("lab")).toEqual([inLab.id]);
    expect(await ids()).toEqual([inDemo.id, inLab.id, inSociety.id]);

    // A turn in lab moves lab's cursor alone, and a turn that read earlier but ends later cannot
    // rewind demo's.
    await board.setDigestCursor("eng-1", "lab", inLab.id);
    expect(await ids("lab")).toEqual([]);
    expect(await ids("demo")).toEqual([inDemo.id, inSociety.id]);
    await board.setDigestCursor("eng-1", "demo", inSociety.id);
    await board.setDigestCursor("eng-1", "demo", inDemo.id);
    expect(await ids("demo")).toEqual([]);

    // A turn token names its scope, so read_inbox in a turn reads and advances that scope only.
    const later = await board.postMessage(USER, { channel: "lab/general", body: "@eng-1 more" });
    const elsewhere = await board.postMessage(USER, {
      channel: "demo/general",
      body: "@eng-1 too",
    });
    const turnActor = board.resolveToken(board.issueTurnToken("eng-1", "engineer", 60_000, "lab"));
    expect(turnActor).toEqual({ ...ENG, scope: "lab" });
    if (turnActor === null) {
      throw new Error("the turn token did not resolve");
    }
    expect((await board.readDigest(turnActor)).messages.map((m) => m.id)).toEqual([later.id]);
    expect(await ids("lab")).toEqual([]);
    expect(await ids("demo")).toEqual([elsewhere.id]);
  });

  it("files each thread in a conversation of its own, with its own cursor, session, and last turn", async () => {
    const { board } = await society();
    const task = await board.createTask(USER, {
      project: "demo",
      title: "build",
      stages: [{ name: "build", role: "engineer" }],
    });
    const topic = await board.openThread(ENG, { channel: "demo/dev", title: "which library?" });
    const inChannel = await board.postMessage(USER, {
      channel: "demo/general",
      body: "@eng-1 a channel question",
    });
    const inTask = await board.postMessage(REV, { thread_id: task.id, body: "@eng-1 the spec" });
    const inTopic = await board.postMessage(REV, { thread_id: topic.id, body: "try zod" });
    const ids = async (thread?: Ulid): Promise<Ulid[]> =>
      (
        await board.readDigest(
          { ...ENG, scope: "demo", ...(thread === undefined ? {} : { thread }) },
          { advance: false },
        )
      ).messages.map((m) => m.id);

    // The home conversation carries the channels; each thread is a conversation of its own.
    expect(await ids()).toEqual([inChannel.id]);
    expect(await ids(task.id)).toEqual([inTask.id]);
    expect(await ids(topic.id)).toEqual([inTopic.id]);
    expect(await board.unreadByConversation(ENG)).toEqual([
      { scope: "demo", thread: null, count: 1 },
      { scope: "demo", thread: task.id, count: 1 },
      { scope: "demo", thread: topic.id, count: 1 },
    ]);

    // A turn in one thread moves that thread's cursor alone, and a thread token reads its thread.
    await board.setDigestCursor("eng-1", "demo", inTask.id, task.id);
    expect(await ids(task.id)).toEqual([]);
    expect(await ids()).toEqual([inChannel.id]);
    const token = board.issueTurnToken("eng-1", "engineer", 60_000, "demo", topic.id);
    const turnActor = board.resolveToken(token);
    expect(turnActor).toEqual({ ...ENG, scope: "demo", thread: topic.id });
    if (turnActor === null) {
      throw new Error("the turn token did not resolve");
    }
    expect((await board.readDigest(turnActor)).messages.map((m) => m.id)).toEqual([inTopic.id]);
    expect(await ids(topic.id)).toEqual([]);

    // Sessions and last turns are kept per conversation; the latest of a scope is any of them.
    await board.writeSession("eng-1", "demo", "claude", "home-session");
    await board.writeSession("eng-1", "demo", "claude", "task-session", task.id);
    expect(await board.readSessions("eng-1", "demo")).toEqual({ claude: "home-session" });
    expect(await board.readSessions("eng-1", "demo", task.id)).toEqual({
      claude: "task-session",
    });
    // Two turns in one scope at once: each pairs its start with its own end.
    clock = new Date("2026-09-28T10:01:00.000Z");
    const home = await board.beginTurn(turnIn(undefined, clock.toISOString()));
    clock = new Date("2026-09-28T10:02:00.000Z");
    const inThread = await board.beginTurn(turnIn(task.id, clock.toISOString()));
    await board.finishTurn({
      ...inThread,
      endedAt: "2026-09-28T10:04:00.000Z",
      exitReason: "completed",
    });
    await board.finishTurn({
      ...home,
      endedAt: "2026-09-28T10:03:00.000Z",
      exitReason: "completed",
    });
    expect((await board.readLastTurn("eng-1", "demo"))?.session).toBe("home-session");
    expect((await board.readLastTurn("eng-1", "demo", task.id))?.session).toBe("task-session");
    expect((await board.readLatestTurn("eng-1", "demo"))?.thread).toBe(task.id);
    expect(
      (await board.listTurns("eng-1")).map((entry) => [entry.thread, entry.startedAt]),
    ).toEqual([
      [task.id, "2026-09-28T10:02:00.000Z"],
      [undefined, "2026-09-28T10:01:00.000Z"],
    ]);
  });

  it("lists what citizens asked the user and the user has not answered, wherever they asked", async () => {
    const { board } = await society();
    const task = await board.createTask(USER, { project: "demo", title: "survey" });
    const ask = await board.postMessage(ENG, {
      body: "@user should the survey cover A or B?",
      thread_id: task.id,
    });
    const aside = await board.postMessage(REV, { channel: "demo/general", body: "@user FYI" });
    await board.postMessage(ENG, { channel: "demo/general", body: "no mention here" });
    const requests = async () =>
      (await board.listRequests()).map((r) => [r.message.id, r.thread?.id ?? null]);
    expect(await requests()).toEqual([
      [ask.id, task.id],
      [aside.id, null],
    ]);
    // An answer in the same thread, or the same channel, settles what was asked there before it.
    await board.postMessage(USER, { body: "B, please.", thread_id: task.id });
    expect(await requests()).toEqual([[aside.id, null]]);
    await board.postMessage(USER, { channel: "demo/general", body: "noted" });
    expect(await requests()).toEqual([]);
    // A closed thread asks nothing any more.
    const later = await board.createTask(USER, { project: "demo", title: "later" });
    await board.postMessage(ENG, { body: "@user a question", thread_id: later.id });
    expect(await requests()).toHaveLength(1);
    await board.updateTask(USER, { task_id: later.id, status: "abandoned" });
    expect(await requests()).toEqual([]);

    expect(await board.hasMentioned("eng-1", "user", ask.ts)).toBe(true);
    expect(await board.hasMentioned("rev-1", "user", "2099-01-01T00:00:00.000Z")).toBe(false);
  });

  it("lets the user set a citizen's model and clear it back to the CLI's default", async () => {
    const { board } = await society();
    const set = await board.setAgentModel(USER, "eng-1", "sonnet");
    expect(set.model).toBe("sonnet");
    expect((await board.listMembers()).find((m) => m.name === "eng-1")?.model).toBe("sonnet");
    const cleared = await board.setAgentModel(USER, "eng-1", null);
    expect(cleared.model).toBeUndefined();
    expect((await board.readAgent("eng-1")).model).toBeUndefined();

    const events = (await board.readEvents(null)).filter((e) => e.type === "agent.configured");
    expect(events.map((e) => e.payload)).toEqual([
      { agent: "eng-1", model: "sonnet", previous: null },
      { agent: "eng-1", model: null, previous: "sonnet" },
    ]);

    await expect(
      board.setAgentModel({ name: "stew", role: "steward" }, "eng-1", "opus"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(board.setAgentModel(USER, "eng-1", "opus 5")).rejects.toThrow(/one word/);
    await expect(board.setAgentModel(USER, "user", "opus")).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
  });

  it("treats claims as leases: expired ones can be taken over and are released by the sweep", async () => {
    const { board } = await society();
    const task = await board.createTask(USER, { project: "demo", title: "t" });
    await board.claimTask(ENG, { task_id: task.id });
    clock = new Date(clock.getTime() + 61_000);
    const taken = await board.claimTask(REV, { task_id: task.id });
    expect(taken.claimedBy).toBe("rev-1");
    clock = new Date(clock.getTime() + 61_000);
    const expired = await board.expireLeases();
    expect(expired.map((t) => t.id)).toEqual([task.id]);
    const reopened = await board.getTask(USER, { task_id: task.id });
    expect(reopened.status).toBe("open");
    expect(reopened.claimedBy).toBeUndefined();
    expect((await board.readEvents(null)).filter((e) => e.type === "lease.expired")).toHaveLength(
      2,
    );
  });

  it("enforces role charters and the lifecycle's ends", async () => {
    const { board } = await society();
    await expect(
      board.approve(ENG, { proposal_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      board.createTask(ENG, {
        project: "demo",
        title: "gated",
        stages: [{ name: "check", gate: true }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const task = await board.createTask(ENG, { project: "demo", title: "t" });
    expect(task.stages.map((stage) => stage.name)).toEqual(["work"]);
    await expect(board.advanceTask(ENG, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(board.updateTask(ENG, { task_id: task.id, stage: "s1" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(board.postMessage(ENG, { channel: "demo/nope", body: "x" })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await board.claimTask(ENG, { task_id: task.id });
    await expect(board.releaseTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await board.releaseTask(ENG, { task_id: task.id })).status).toBe("open");
    await board.claimTask(ENG, { task_id: task.id });
    expect((await board.advanceTask(ENG, { task_id: task.id })).status).toBe("done");
    await expect(board.claimTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    const other = await board.createTask(ENG, { project: "demo", title: "u" });
    await expect(
      board.updateTask(REV, { task_id: other.id, status: "abandoned" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await board.updateTask(ENG, { task_id: other.id, status: "abandoned" })).status).toBe(
      "abandoned",
    );
  });

  it("runs a plan: stages advance and return, members reshape what is ahead, and gates stay guarded", async () => {
    const { board } = await society();
    for (const role of ["researcher", "editor"]) {
      await board.setRoleCharter(USER, {
        name: role,
        purpose: `A ${role}.`,
        verbs: [...MEMBER_VERBS],
        wakeTriggers: [],
      });
    }
    const lab = await board.addProject(USER, { slug: "lab" });
    expect(lab.onDone).toBe("none");
    for (const [name, role] of [
      ["res-1", "researcher"],
      ["ed-1", "editor"],
      ["ed-2", "editor"],
    ] as const) {
      await board.addAgent(USER, { name, role, cli: "claude", memberships: ["lab"] });
    }
    const RES: Actor = { name: "res-1", role: "researcher" };
    const ED1: Actor = { name: "ed-1", role: "editor" };
    const ED2: Actor = { name: "ed-2", role: "editor" };

    const task = await board.createTask(USER, {
      project: "lab",
      title: "Churn model",
      stages: [
        { name: "experiment", role: "researcher" },
        { name: "write-up", role: "researcher" },
        { name: "referee review", role: "editor", gate: true },
      ],
    });
    expect(task.stages.map((s) => `${s.id}:${s.name}:${s.gate}`)).toEqual([
      "s1:experiment:false",
      "s2:write-up:false",
      "s3:referee review:true",
    ]);
    await board.claimTask(RES, { task_id: task.id });
    await board.advanceTask(RES, { task_id: task.id, note: "baseline done" });

    // Another round is one more stage, inserted mid-flight by the researcher itself.
    const replanned = await board.planTask(RES, {
      task_id: task.id,
      stages: [
        { name: "second experiment", role: "researcher" },
        { id: "s2", name: "write-up", role: "researcher" },
        { id: "s3", name: "referee review", role: "editor", gate: true },
      ],
    });
    expect(replanned.stage).toBe("s4");
    expect(replanned.stages.map((s) => s.id)).toEqual(["s1", "s4", "s2", "s3"]);

    // The member a gate checks cannot drop, clear, add, move, or reassign one.
    const refused = [
      [
        { id: "s4", name: "second experiment" },
        { id: "s2", name: "write-up" },
      ],
      [
        { id: "s4", name: "second experiment" },
        { id: "s2", name: "write-up" },
        { id: "s3", name: "referee review", role: "editor" },
      ],
      [
        { id: "s4", name: "second experiment" },
        { id: "s2", name: "write-up" },
        { id: "s3", name: "referee review", role: "editor", gate: true },
        { name: "second opinion", gate: true },
      ],
      [
        { id: "s4", name: "second experiment" },
        { id: "s3", name: "referee review", role: "editor", gate: true },
        { id: "s2", name: "write-up" },
      ],
      [
        { id: "s4", name: "second experiment" },
        { id: "s2", name: "write-up" },
        { id: "s3", name: "referee review", role: "researcher", gate: true },
      ],
    ];
    for (const stages of refused) {
      await expect(board.planTask(RES, { task_id: task.id, stages })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    await expect(
      board.planTask(RES, { task_id: task.id, stages: [{ id: "s1", name: "again" }] }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // The user inserts an unassigned audit; anyone in the project may hold it.
    const audited = await board.planTask(USER, {
      task_id: task.id,
      stages: [
        { id: "s4", name: "second experiment", role: "researcher" },
        { name: "data audit" },
        { id: "s2", name: "write-up", role: "researcher" },
        { id: "s3", name: "referee review", role: "editor", gate: true },
      ],
    });
    expect(audited.stages.map((s) => s.id)).toEqual(["s1", "s4", "s5", "s2", "s3"]);
    await board.claimTask(RES, { task_id: task.id });
    await board.advanceTask(RES, { task_id: task.id });
    await board.claimTask(ED1, { task_id: task.id });
    await board.advanceTask(ED1, { task_id: task.id });
    await board.claimTask(RES, { task_id: task.id });
    await board.advanceTask(RES, { task_id: task.id });

    // The gate is an independent check: ed-1 held the audit, so ed-2 referees.
    await expect(board.claimTask(RES, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(board.claimTask(ED1, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await board.claimTask(ED2, { task_id: task.id });
    const sentBack = await board.updateTask(ED2, {
      task_id: task.id,
      stage: "s2",
      note: "the write-up skips the ablation",
    });
    expect(sentBack).toMatchObject({ status: "open", stage: "s2" });
    expect(sentBack.stages.find((s) => s.id === "s2")?.completedBy).toBeUndefined();
    expect(sentBack.returned).toEqual({ from: "s3", by: "ed-2", at: expect.any(String) });
    await board.claimTask(RES, { task_id: task.id });
    const resubmitted = await board.advanceTask(RES, { task_id: task.id, note: "ablation added" });
    expect(resubmitted.returned).toBeUndefined();
    await board.claimTask(ED2, { task_id: task.id });
    const done = await board.advanceTask(ED2, { task_id: task.id });
    expect(done.status).toBe("done");

    const members = await board.listMembers();
    for (const name of ["res-1", "ed-1", "ed-2"]) {
      expect(members.find((m) => m.name === name)?.tasksDone).toBe(1);
    }
    const types = (await board.readEvents(null)).map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining(["task.planned", "task.moved", "task.advanced", "task.completed"]),
    );
  });

  it("records a send-back on the task for as long as its rework lasts", async () => {
    const { board } = await society();
    const task = await board.createTask(USER, {
      project: "demo",
      title: "report",
      stages: [{ name: "draft" }, { name: "figures" }, { name: "check" }],
    });
    await board.advanceTask(USER, { task_id: task.id });
    await board.advanceTask(USER, { task_id: task.id });
    const back = await board.updateTask(USER, { task_id: task.id, stage: "s1", note: "redo" });
    expect(back.returned).toEqual({ from: "s3", by: "user", at: expect.any(String) });
    expect((await board.claimTask(ENG, { task_id: task.id })).returned?.from).toBe("s3");
    // Still short of the stage that returned it: the rework goes on.
    expect((await board.advanceTask(ENG, { task_id: task.id })).returned?.from).toBe("s3");
    expect((await board.advanceTask(USER, { task_id: task.id })).returned).toBeUndefined();
    await board.updateTask(USER, { task_id: task.id, stage: "s2" });
    const abandoned = await board.updateTask(USER, { task_id: task.id, status: "abandoned" });
    expect(abandoned.returned).toBeUndefined();
  });

  it("runs completion effects: a merge project completes through the board, and a failure reopens the last stage", async () => {
    const { board } = await society();
    await expect(
      board.configureProject(ENG, { project: "demo", on_done: "merge" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const configured = await board.configureProject(USER, { project: "demo", on_done: "merge" });
    expect(configured).toMatchObject({ onDone: "merge" });

    // Without a plan, a task gets one stage anyone in the project may take.
    const task = await board.createTask(USER, { project: "demo", title: "Add hello.txt" });
    expect(task.stages.map((s) => `${s.name}:${s.role ?? s.agent ?? "anyone"}:${s.gate}`)).toEqual([
      "work:anyone:false",
    ]);
    expect(task.onDone).toBe("merge");
    await expect(
      board.planTask(ENG, {
        task_id: task.id,
        stages: [{ id: "s1", name: "build" }],
        on_done: "none",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await board.claimTask(ENG, { task_id: task.id });
    const completing = await board.advanceTask(ENG, { task_id: task.id });
    expect(completing).toMatchObject({ status: "open", completing: true });
    await expect(board.claimTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });

    const reopened = await board.finishCompletion(SYSTEM_ACTOR, {
      taskId: task.id,
      ok: false,
      detail: "conflict in hello.txt",
    });
    expect(reopened).toMatchObject({ status: "open", completing: false, stage: "s1" });
    expect(reopened.stages[0]?.completedBy).toBeUndefined();
    await board.claimTask(ENG, { task_id: task.id });
    await board.advanceTask(ENG, { task_id: task.id });
    const done = await board.finishCompletion(SYSTEM_ACTOR, {
      taskId: task.id,
      ok: true,
      detail: "merged",
    });
    expect(done.status).toBe("done");
    const events = await board.readEvents(null);
    expect(events.filter((e) => e.type === "task.completing")).toHaveLength(2);
    expect(events.find((e) => e.type === "task.reopened")?.payload["detail"]).toBe(
      "conflict in hello.txt",
    );
    expect(events.find((e) => e.type === "task.completed")?.payload["createdBy"]).toBe("user");
  });

  it("closes a task's open thread when the task ends, however it ends", async () => {
    const { board } = await society();
    const withThread = async (title: string, onDone?: "merge"): Promise<Ulid> => {
      const task = await board.createTask(USER, {
        project: "demo",
        title,
        stages: [{ name: "build", role: "engineer" }],
      });
      if (onDone !== undefined) {
        await board.planTask(USER, {
          task_id: task.id,
          stages: [{ id: "s1", name: "build", role: "engineer" }],
          on_done: onDone,
        });
      }
      await board.postMessage(ENG, { body: "note", thread_id: task.id });
      return task.id;
    };
    const state = async (id: Ulid): Promise<string> => (await board.readThread(id)).state;
    const lastStep = async (id: Ulid) => (await board.listThread(id)).at(-1)?.step;
    const finished = await withThread("finished");
    await board.claimTask(ENG, { task_id: finished });
    expect((await board.advanceTask(ENG, { task_id: finished })).status).toBe("done");
    expect(await state(finished)).toBe("closed");

    // A merge that fails leaves its thread open, says so there, and waits at the last stage.
    const conflicted = await withThread("conflicted", "merge");
    await board.claimTask(ENG, { task_id: conflicted });
    await board.advanceTask(ENG, { task_id: conflicted });
    const reopened = await board.finishCompletion(SYSTEM_ACTOR, {
      taskId: conflicted,
      ok: false,
      detail: "conflict in README.md",
    });
    expect(reopened).toMatchObject({ status: "open", stage: "s1", completing: false });
    expect(await state(conflicted)).toBe("open");
    expect((await board.listThread(conflicted)).at(-1)).toMatchObject({
      author: "board",
      body: expect.stringContaining("Landing failed: conflict in README.md."),
      step: { action: "reopened", stage: "s1", to: "s1" },
    });

    const merged = await withThread("merged", "merge");
    await board.claimTask(ENG, { task_id: merged });
    // A completing task is still in play, and its thread stays open until the effect lands.
    await board.advanceTask(ENG, { task_id: merged });
    expect(await state(merged)).toBe("open");
    await board.finishCompletion(SYSTEM_ACTOR, {
      taskId: merged,
      ok: true,
      detail: "merged into main at abc123",
    });
    expect(await state(merged)).toBe("closed");
    expect(await lastStep(merged)).toEqual({ action: "landed", stage: "s1", to: null });
    expect((await board.listChannel("demo/general")).map((m) => m.body)).toEqual([
      `Task ${merged} "merged" is done: merged into main at abc123.\n`,
    ]);

    const dropped = await withThread("dropped");
    await board.updateTask(USER, {
      task_id: dropped,
      status: "abandoned",
      note: "Not needed after all.",
    });
    expect(await state(dropped)).toBe("closed");
    expect(await lastStep(dropped)).toEqual({ action: "abandoned", stage: "s1", to: null });
    await expect(board.openThread(ENG, { task_id: dropped })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });

    await expect(
      board.postMessage(ENG, { channel: "demo/general", body: "late", thread_id: finished }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    const closed = (await board.readEvents(null)).filter((e) => e.type === "thread.closed");
    expect(closed.map((e) => [e.actor, e.payload["threadId"], e.payload["ended"]])).toEqual([
      ["eng-1", finished, "done"],
      ["board", merged, "done"],
      ["user", dropped, "abandoned"],
    ]);
  });

  it("opens threads on a channel and on a proposal, each reaching only its participants", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };
    const ids = async (actor: Actor): Promise<Ulid[]> =>
      (await board.readDigest(actor)).messages.map((m) => m.id);

    // A topic on a channel: the thread records its channel, and every message carries it.
    await expect(board.openThread(ENG, { channel: "demo/general" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const topic = await board.openThread(ENG, { channel: "demo/dev", title: "Which runner?" });
    expect(topic).toMatchObject({ channel: "demo/dev", state: "open", openedBy: "eng-1" });
    expect(topic.subject).toBeUndefined();
    const first = await board.postMessage(ENG, {
      body: "vitest or node:test?",
      thread_id: topic.id,
    });
    expect(first).toMatchObject({ channel: "demo/dev", thread: topic.id });
    await expect(
      board.postMessage(ENG, { channel: "demo/general", body: "x", thread_id: topic.id }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(board.postMessage(ENG, { body: "nowhere" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    // rev-1 follows demo/dev but is not in the thread until it is mentioned, then posts.
    await board.subscribe(REV, { channel: "demo/dev" });
    expect(await ids(REV)).not.toContain(first.id);
    const ask = await board.postMessage(ENG, { body: "@rev-1 your view?", thread_id: topic.id });
    expect(await ids(REV)).toEqual([ask.id]);
    await board.postMessage(REV, { body: "vitest", thread_id: topic.id });
    const more = await board.postMessage(ENG, { body: "agreed", thread_id: topic.id });
    expect(await ids(REV)).toEqual([more.id]);
    const summary = await board.closeThread(REV, { thread_id: topic.id, summary: "Vitest." });
    expect(summary).toMatchObject({ channel: "demo/dev", closes: topic.id });
    expect(summary.body).toContain('"Which runner?"');
    expect(await board.readThread(topic.id)).toMatchObject({ state: "closed", closedBy: "rev-1" });

    // A proposal opens its thread with its pitch, under its id in governance; the thread reaches
    // its proposer, its deciders, and the readers of signals, and its decision ends it.
    const proposal = await board.propose(STEW, {
      kind: "channel",
      charter: { project: "demo", name: "ideas", purpose: "Loose ideas." },
      rationale: "Ideas keep landing in general.",
    });
    expect(await board.readThread(proposal.id)).toMatchObject({
      channel: "governance",
      subject: { kind: "proposal", id: proposal.id },
      state: "open",
      openedBy: "stew",
    });
    const [pitch] = await board.listThread(proposal.id);
    expect(pitch?.body).toContain("Ideas keep landing in general.");
    expect(await board.listChannel("governance")).toEqual([]);
    await expect(board.openThread(ENG, { proposal_id: proposal.id })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expect(
      board.closeThread(STEW, { thread_id: proposal.id, summary: "never mind" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    const why = await board.postMessage(USER, { body: "Worth a channel?", thread_id: proposal.id });
    expect(await ids(STEW)).toContain(why.id);
    expect(await ids(ENG)).not.toContain(why.id);
    await board.approve(USER, { proposal_id: proposal.id, reason: "yes" });
    expect(await board.readThread(proposal.id)).toMatchObject({
      state: "closed",
      closedBy: "user",
    });
    expect((await board.listThread(proposal.id)).at(-1)).toMatchObject({
      author: "user",
      step: { action: "approved" },
      body: expect.stringContaining("Approved: channel demo/ideas"),
    });
    const decided = (await board.readEvents(null)).findLast((e) => e.type === "proposal.decided");
    expect(decided?.payload).toMatchObject({ outcome: "approved", proposedBy: "stew" });
    const listed = await board.listThreads();
    expect(listed.map((thread) => thread.id)).toEqual([proposal.id, topic.id]);
    expect(listed[0]).toMatchObject({ messages: 3, lastAuthor: "user" });
  });

  it("validates proposals by kind, forbids self-decisions, and reserves hiring for the user", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
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
    expect((await board.approve(USER, { proposal_id: hire.id })).outcome).toBe("approved");
    expect((await board.readProposal(hire.id)).status).toBe("provisioned");
    await expect(
      board.reject(USER, { proposal_id: hire.id, reason: "late" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    const channel = await board.propose(ENG, {
      kind: "channel",
      charter: { project: "demo", name: "design", purpose: "Design discussion" },
    });
    expect((await board.approve(STEW, { proposal_id: channel.id })).outcome).toBe("approved");
  });

  it("provisions what an approval asked for: members, channels, roles, retirements", async () => {
    const { board, eng } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };
    expect((await board.readAgent("stew")).subscriptions).toEqual(["general", "governance"]);

    // A member proposal becomes an agent with a home, memberships, and seed instructions.
    const hire = await board.propose(STEW, {
      kind: "member",
      charter: {
        name: "eng-2",
        role: "engineer",
        cli: "codex",
        memberships: ["demo"],
        seedInstructions: "Focus on the API layer first.",
      },
      rationale: "Backlog depth is above threshold.",
    });
    expect((await board.listThread(hire.id)).at(0)?.body).toContain(
      `Proposal ${hire.id}: member eng-2 as engineer on codex for demo`,
    );
    await board.approve(USER, { proposal_id: hire.id });
    const provisioned = await board.readProposal(hire.id);
    expect(provisioned.status).toBe("provisioned");
    expect(provisioned.provision).toMatchObject({ agent: "eng-2", memberships: ["demo"] });
    const eng2 = await board.readAgent("eng-2");
    expect(eng2.memberships).toEqual(["demo"]);
    expect((await board.readProject("demo")).members).toContain("eng-2");
    expect(await board.readAgentRoleBody("eng-2")).toContain("Focus on the API layer first.");
    const added = (await board.readEvents(null)).find(
      (event) => event.type === "agent.added" && event.payload["name"] === "eng-2",
    );
    expect(added?.payload["proposalId"]).toBe(hire.id);
    expect((await board.listThread(hire.id)).at(-1)?.body).toContain(
      "Approved: member eng-2 as engineer on codex for demo",
    );

    // A channel proposal opens the channel with its purpose as the first message.
    const channel = await board.propose(ENG, {
      kind: "channel",
      charter: { project: "demo", name: "design", purpose: "Design discussion" },
    });
    await board.approve(STEW, { proposal_id: channel.id });
    expect((await board.readProject("demo")).channels).toContain("design");
    expect((await board.listChannel("demo/design"))[0]?.body).toContain("Design discussion");
    expect((await board.readProposal(channel.id)).status).toBe("provisioned");

    // A role proposal writes the charter, and the role is usable at once.
    const role = await board.propose(STEW, {
      kind: "role",
      charter: {
        name: "designer",
        purpose: "Owns the visual language.",
        verbs: ["post_message", "read_inbox", "search"],
        wakeTriggers: ["heartbeat"],
      },
    });
    await board.approve(USER, { proposal_id: role.id });
    expect((await board.readRole("designer")).maxReplicas).toBe(1);
    expect((await board.listRoles()).map((r) => r.name)).toContain("designer");

    // A retirement releases claims, revokes the token, and leaves the projection.
    const task = await board.createTask(USER, { project: "demo", title: "t" });
    await board.claimTask(ENG, { task_id: task.id });
    const retirement = await board.propose(STEW, {
      kind: "retirement",
      charter: { agent: "eng-1", reason: "idle for a week" },
    });
    await expect(board.approve(STEW, { proposal_id: retirement.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await board.approve(USER, { proposal_id: retirement.id });
    const retired = await board.readAgent("eng-1");
    expect(retired.status).toBe("retired");
    expect(retired.retiredReason).toBe("idle for a week");
    expect((await board.getTask(USER, { task_id: task.id })).status).toBe("open");
    expect(board.resolveToken(eng.token)).toBeNull();
    expect((await board.readProject("demo")).members).not.toContain("eng-1");
    expect((await board.projectMembers("demo")).map((a) => a.name)).toEqual([
      "eng-2",
      "rev-1",
      "user",
    ]);
    expect((await board.listChannel("general")).at(-1)?.body).toContain("Retired eng-1");
    expect((await board.readProposal(retirement.id)).provision).toMatchObject({
      agent: "eng-1",
      releasedTasks: [task.id],
    });

    // A reallocation has nothing to provision; it stays approved on the record.
    const reallocation = await board.propose(STEW, {
      kind: "reallocation",
      charter: { description: "Move rev-1 to the api project." },
    });
    await board.approve(USER, { proposal_id: reallocation.id });
    expect((await board.readProposal(reallocation.id)).status).toBe("approved");
  });

  it("archives a project by the user alone, once no task there is in play, and keeps what it holds", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const DESK: Actor = { name: "desk", role: "concierge" };
    const STEW: Actor = { name: "stew", role: "steward" };
    const task = await board.createTask(USER, { project: "demo", title: "last study" });
    const topic = await board.openThread(ENG, { channel: "demo/dev", title: "sources" });
    await board.postMessage(ENG, { thread_id: topic.id, body: "@user which source wins?" });
    await board.postMessage(REV, { channel: "demo/general", body: "@user the findings are in." });
    const charter = { project: "demo", reason: "merged into phones" };

    // Only the user holds the verb; the others propose, and a task in play keeps the project open.
    await expect(
      board.archiveProject(DESK, { project: "demo", reason: "merged into phones" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(board.propose(DESK, { kind: "archive", charter })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await board.updateTask(USER, { task_id: task.id, status: "abandoned" });
    const proposal = await board.propose(DESK, { kind: "archive", charter });
    expect((await board.listThread(proposal.id)).at(0)?.body).toContain(
      "archive of project demo: merged into phones",
    );
    await expect(board.approve(STEW, { proposal_id: proposal.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await board.listRequests()).map((request) => request.message.author)).toEqual([
      "eng-1",
      "rev-1",
    ]);
    await board.approve(USER, { proposal_id: proposal.id });

    const archived = await board.readProject("demo");
    expect(archived.archived).toMatchObject({ by: "user", reason: "merged into phones" });
    expect(archived.members).toEqual([]);
    expect((await board.readProposal(proposal.id)).provision).toEqual({
      project: "demo",
      members: ["eng-1", "rev-1", "user"],
    });
    for (const name of ["eng-1", "rev-1", "user"]) {
      const agent = await board.readAgent(name);
      expect(agent.memberships).not.toContain("demo");
      expect(agent.subscriptions.filter((ref) => ref.startsWith("demo/"))).toEqual([]);
    }
    expect((await board.readThread(topic.id)).state).toBe("closed");
    // Nothing is asked of the user where nobody can answer any more, and the history stays readable.
    expect(await board.listRequests()).toEqual([]);
    expect((await board.listChannel("demo/general")).at(-1)?.body.trim()).toBe(
      "@user the findings are in.",
    );
    // The notice is the board's and names nobody, so it wakes nobody.
    const notice = (await board.listChannel("general")).at(-1);
    expect(notice).toMatchObject({ author: "board", mentions: [] });
    expect(notice?.body.trim()).toBe(
      "Project demo is archived by user. Its files and history stay; nothing more is posted, filed, or joined there.",
    );
    expect(
      (await board.readEvents(null)).find((event) => event.type === "project.archived")?.payload,
    ).toMatchObject({
      slug: "demo",
      members: ["eng-1", "rev-1", "user"],
      threadsClosed: [topic.id],
    });

    // An archived project takes no more work of any kind.
    for (const attempt of [
      () => board.postMessage(USER, { channel: "demo/general", body: "anyone?" }),
      () => board.createTask(USER, { project: "demo", title: "more" }),
      () => board.openThread(USER, { channel: "demo/general", title: "more" }),
      () => board.joinProject(USER, { project: "demo", agent: "eng-1" }),
      () => board.writeKnowledge(USER, { project: "demo", topic: "notes", body: "x" }),
      () => board.subscribe(ENG, { channel: "demo/dev" }),
      () => board.archiveProject(USER, { project: "demo", reason: "again" }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "INVALID_STATE" });
    }

    // The user may archive directly, without a proposal.
    await board.addProject(USER, { slug: "lab" });
    const lab = await board.archiveProject(USER, { project: "lab", reason: "never used" });
    expect(lab.archived).toMatchObject({ by: "user", reason: "never used" });
  });

  it("refuses proposals that could not be provisioned, and guards direct administration", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };
    await expect(
      board.propose(STEW, {
        kind: "member",
        charter: { name: "eng-1", role: "engineer", cli: "claude" },
      }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await expect(
      board.propose(STEW, {
        kind: "member",
        charter: { name: "eng-9", role: "wizard", cli: "claude" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      board.propose(STEW, { kind: "retirement", charter: { agent: "user", reason: "no" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      board.propose(STEW, {
        kind: "channel",
        charter: { project: "demo", name: "general", purpose: "dup" },
      }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });

    // Direct administration: the user retires and edits charters; the steward may not.
    await expect(board.retireAgent(STEW, { name: "eng-1", reason: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      board.setRoleCharter(STEW, { ...(await board.readRole("engineer")), maxReplicas: 2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const engineer = await board.setRoleCharter(USER, {
      ...(await board.readRole("engineer")),
      purpose: "Builds and ships, tests first.",
      maxReplicas: 3,
      backlogThreshold: 2,
    });
    expect(engineer.maxReplicas).toBe(3);
    expect((await board.readRole("engineer")).backlogThreshold).toBe(2);
    // The change reaches the members' own role files, which is what their turns render.
    expect(await board.readAgentRoleBody("eng-1")).toContain("Builds and ships, tests first.");

    // A replica is cloned from the newest active member of the role on the project.
    const replica = await board.addReplica(USER, { project: "demo", role: "engineer" });
    expect(replica.name).toBe("eng-2");
    expect(replica.cli).toBe("claude");
    expect(replica.memberships).toEqual(["demo"]);
    const scaled = (await board.readEvents(null)).find(
      (event) => event.type === "agent.added" && event.payload["name"] === "eng-2",
    );
    expect(scaled?.payload["scaledFrom"]).toBe("eng-1");
    await board.retireAgent(USER, { name: "eng-2", reason: "demo" });
    expect((await board.addReplica(USER, { project: "demo", role: "engineer" })).name).toBe(
      "eng-3",
    );
    // A society-wide member of the role is the fallback template; a role with none cannot scale.
    expect((await board.addReplica(USER, { project: "demo", role: "steward" })).name).toBe(
      "stew-2",
    );
    await board.setRoleCharter(USER, {
      name: "designer",
      purpose: "Owns the visual language.",
      verbs: ["post_message"],
      wakeTriggers: [],
    });
    await expect(
      board.addReplica(USER, { project: "demo", role: "designer" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Channels can be added directly by the user or the steward.
    expect(
      await board.addChannel(STEW, { project: null, name: "random", purpose: "Off topic" }),
    ).toBe("random");
    expect((await board.society()).channels).toContain("random");

    // Runner state changes are recorded and signalled; signals are readable back.
    const runner = await board.markRunner("server", { status: "connected", clis: ["claude"] });
    expect(runner.status).toBe("connected");
    await board.publishSignal({
      kind: "backlog",
      key: "backlog:demo:engineer",
      summary: "demo: 4 open or claimed tasks for 1 engineer",
      value: 4,
      threshold: 3,
      project: "demo",
      role: "engineer",
    });
    const signals = await board.listSignals();
    expect(signals.map((record) => record.signal.kind)).toEqual(["runner", "backlog"]);
    // A signal is logged, not posted: no channel carries it.
    expect(signals.at(-1)?.signal.summary).toBe("demo: 4 open or claimed tasks for 1 engineer");
    expect((await board.listChannels()).map((channel) => channel.ref)).not.toContain("ops");
    const types = (await board.readEvents(null)).map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining(["runner.changed", "ops.signal", "role.added", "channel.added"]),
    );
  });

  it("searches messages and tasks, and only the user can pause", async () => {
    const { board } = await society();
    await board.postMessage(ENG, { channel: "demo/dev", body: "The pagination cursor is base64." });
    await board.createTask(ENG, { project: "demo", title: "Fix pagination", body: "cursor bug" });
    const hits = await board.search(ENG, { query: "pagination" });
    expect(hits.map((hit) => hit.kind).toSorted()).toEqual(["message", "task"]);
    expect(await board.isPaused()).toBe(false);
    await board.setPaused(USER, true);
    expect(await board.isPaused()).toBe(true);
    await expect(board.setPaused(ENG, false)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reopens with the token index intact, aligning seed roles an older build wrote differently", async () => {
    const { board, eng } = await society();
    await board.addAgent(USER, {
      name: "stew",
      role: "steward",
      cli: "claude",
      seedInstructions: "Read the signals first.",
    });
    await rm(board.paths.role("concierge"));
    await rm(board.paths.members(), { recursive: true, force: true });
    // A charter written before a verb existed: the user's other edits must survive the grant.
    const steward = await board.readRole("steward");
    await board.setRoleCharter(USER, {
      ...steward,
      verbs: steward.verbs.filter((verb) => verb !== "write_knowledge"),
      maxReplicas: 4,
    });
    // A charter written before a field existed: the seed's value applies, not the schema's default.
    const stewardFile = board.paths.role("steward");
    await writeFile(
      stewardFile,
      (await readFile(stewardFile, "utf8")).replace("societyScope: true\n", ""),
      "utf8",
    );
    // The user charter is nobody's to edit, so it is the seed's in full.
    const userFile = board.paths.role("user");
    await writeFile(
      userFile,
      (await readFile(userFile, "utf8")).replace("reflects: false\n", "reflects: true\n"),
      "utf8",
    );
    const reopened = await Board.open(dir);
    expect(reopened.resolveToken(eng.token)).toEqual(ENG);
    expect((await reopened.readRole("concierge")).resident).toBe(true);
    expect((await reopened.listRoles()).map((role) => role.name)).toContain("concierge");
    const granted = await reopened.readRole("steward");
    expect(granted.verbs).toContain("write_knowledge");
    expect(granted.maxReplicas).toBe(4);
    expect(granted.societyScope).toBe(true);
    expect((await reopened.readRole("user")).reflects).toBe(false);
    const seeded = (await reopened.readEvents(null)).filter(
      (event) => event.type === "role.added" && event.payload["seeded"] === true,
    );
    expect(
      seeded.map((event) => [
        event.payload["name"],
        event.payload["verbsAdded"],
        event.payload["fieldsAligned"],
      ]),
    ).toEqual([
      ["user", [], ["reflects"]],
      ["steward", ["write_knowledge"], ["societyScope"]],
      ["concierge", undefined, undefined],
    ]);
    // The members' own role files follow, seed instructions included.
    const stewRole = await reopened.readAgentRoleBody("stew");
    expect(stewRole).toContain("# stew, steward");
    expect(stewRole).toContain("## Seed instructions\n\nRead the signals first.");
    // Opening again aligns nothing more.
    await Board.open(dir);
    expect(
      (await reopened.readEvents(null)).filter(
        (event) => event.type === "role.added" && event.payload["seeded"] === true,
      ),
    ).toHaveLength(3);
    await expect(Board.open(path.join(dir, "nowhere"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("aligns an older society once: decisions for ops readers, thread records, the digest cursor", async () => {
    const { board, eng } = await society();
    const STEW: Actor = { name: "stew", role: "steward" };
    const { agent } = await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    expect(agent.subscriptions).toEqual(["general", "governance"]);
    expect(eng.agent.subscriptions).not.toContain("decisions");

    // An older society had ops and decisions channels: signals were posted to ops, which ops
    // readers followed, and proposals were decided in decisions, which a steward from before that
    // did not follow. Both channels are retired on the next open, after the steward was aligned
    // to follow decisions; threads kept as a state on their task, as older builds wrote them,
    // become records.
    await board.addChannel(USER, { project: null, name: "ops", purpose: "operations signals" });
    await board.addChannel(USER, { project: null, name: "decisions", purpose: "decisions" });
    await board.subscribe(STEW, { channel: "ops" });
    const legacyThread = async (title: string, end: boolean): Promise<Ulid> => {
      const task = await board.createTask(USER, { project: "demo", title });
      await board.postMessage(ENG, { body: "old news", thread_id: task.id });
      if (end) {
        await board.updateTask(USER, { task_id: task.id, status: "abandoned" });
      }
      await rm(board.paths.threadFile(board.paths.threads("demo"), task.id));
      const file = board.paths.task("demo", task.id);
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace("status: ", "thread: open\nstatus: "),
        "utf8",
      );
      return task.id;
    };
    const live = await legacyThread("live", false);
    const ended = await legacyThread("ended", true);
    // Older builds logged thread events by task id; the record takes its opener from them.
    const legacyEvent = {
      id: ulid(),
      ts: clock.toISOString(),
      type: "thread.opened",
      actor: "rev-1",
      payload: { taskId: live, project: "demo" },
    };
    await appendFile(board.paths.eventLog(), `${JSON.stringify(legacyEvent)}\n`, "utf8");
    const untouched = await board.createTask(USER, { project: "demo", title: "no thread" });
    await rm(board.paths.threadFile(board.paths.threads("demo"), untouched.id));
    const untouchedFile = board.paths.task("demo", untouched.id);
    await writeFile(
      untouchedFile,
      (await readFile(untouchedFile, "utf8")).replace("status: ", "thread: none\nstatus: "),
      "utf8",
    );
    await expect(board.readThread(live)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A send-back was once only an event: a task still in its rework records it.
    const legacyReturn = async (resubmit: boolean): Promise<Ulid> => {
      const task = await board.createTask(USER, {
        project: "demo",
        title: resubmit ? "resubmitted" : "returned",
        stages: [{ name: "draft" }, { name: "check" }],
      });
      await board.advanceTask(USER, { task_id: task.id });
      await board.updateTask(USER, { task_id: task.id, stage: "s1" });
      if (resubmit) {
        await board.advanceTask(USER, { task_id: task.id });
      }
      const file = board.paths.task("demo", task.id);
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace(/returned:\n(?: {2}.*\n)+/, ""),
        "utf8",
      );
      return task.id;
    };
    const returned = await legacyReturn(false);
    const resubmitted = await legacyReturn(true);
    expect(await readFile(board.paths.task("demo", returned), "utf8")).not.toContain("returned:");
    // The digest was once the inbox: cursor files keyed it `inbox`, and the user followed channels.
    const Cursor = z.object({ digest: z.string().nullable() });
    const cursor = ulid();
    const cursorFile = board.paths.agentCursors("eng-1");
    await writeFile(cursorFile, JSON.stringify({ inbox: cursor }), "utf8");
    await board.subscribe(USER, { channel: "demo/general" });
    const reopened = await Board.open(dir);
    // Threads, once read in each scope's single conversation, start where that conversation was.
    expect(Cursor.parse(JSON.parse(await readFile(cursorFile, "utf8")))).toEqual({
      digest: cursor,
    });
    expect(JSON.parse(await readFile(cursorFile, "utf8"))).toEqual({
      digest: cursor,
      scopes: {},
      threadsFrom: { demo: cursor, society: cursor },
    });
    expect((await reopened.readAgent("user")).subscriptions).toEqual([]);
    expect((await reopened.readAgent("stew")).subscriptions).toEqual(["general", "governance"]);
    expect((await reopened.society()).channels).toEqual(["general", "governance"]);
    expect((await reopened.readAgent("eng-1")).subscriptions).not.toContain("decisions");
    expect(await reopened.readThread(live)).toMatchObject({
      channel: "demo/general",
      title: "live",
      subject: { kind: "task", id: live },
      state: "open",
      openedBy: "rev-1",
    });
    expect(await reopened.readThread(ended)).toMatchObject({ state: "closed", openedBy: "user" });
    expect((await reopened.listThread(live)).map((m) => m.body.trim())).toEqual(["old news"]);
    await expect(reopened.readThread(untouched.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await reopened.getTask(USER, { task_id: returned })).returned).toEqual({
      from: "s2",
      by: "user",
      at: expect.any(String),
    });
    expect((await reopened.getTask(USER, { task_id: resubmitted })).returned).toBeUndefined();
    for (const id of [live, ended, untouched.id]) {
      expect(await readFile(reopened.paths.task("demo", id), "utf8")).not.toContain("thread:");
    }

    // Only once: a later choice to leave the channel stands.
    await reopened.unsubscribe(STEW, { channel: "decisions" });
    const again = await Board.open(dir);
    expect((await again.readAgent("stew")).subscriptions).not.toContain("decisions");
    const aligned = (await again.readEvents(null)).filter(
      (e) => e.type === "subscription.changed" && e.payload["aligned"] === true,
    );
    expect(aligned.map((e) => e.actor)).toEqual(["stew"]);
  });

  it("runs the front desk: projects and membership as verbs, and a roster that dispatch can read", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const DESK: Actor = { name: "desk", role: "concierge" };

    // Only roles chartered for it open projects; the society scope is reserved.
    await expect(
      board.createProject(ENG, { slug: "api", name: "Public API" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(board.createProject(DESK, { slug: "society" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const api = await board.createProject(DESK, { slug: "api", name: "Public API" });
    expect(api.channels).toEqual(["general"]);
    expect((await board.readAgent("user")).memberships).toContain("api");

    // Citizens join themselves; the front desk adds others; an engineer may not.
    expect((await board.joinProject(ENG, { project: "api" })).memberships).toEqual(["demo", "api"]);
    await expect(board.joinProject(ENG, { project: "api", agent: "rev-1" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const rev = await board.joinProject(DESK, { project: "api", agent: "rev-1" });
    expect(rev.memberships).toContain("api");
    expect(rev.subscriptions).toContain("api/general");
    expect((await board.readProject("api")).members.toSorted()).toEqual(["eng-1", "rev-1"]);
    expect((await board.readEvents(null)).filter((e) => e.type === "agent.joined")).toHaveLength(2);
    // Joining twice is a no-op, leaving releases the claims held there.
    expect((await board.joinProject(ENG, { project: "api" })).memberships).toEqual(["demo", "api"]);
    const task = await board.createTask(USER, { project: "api", title: "t" });
    await board.claimTask(ENG, { task_id: task.id });
    const left = await board.leaveProject(ENG, { project: "api" });
    expect(left.memberships).toEqual(["demo"]);
    expect(left.subscriptions).not.toContain("api/general");
    expect((await board.getTask(USER, { task_id: task.id })).status).toBe("open");
    expect((await board.readProject("api")).members).toEqual(["rev-1"]);

    // The roster: identity, reach, availability, and the citizen's own profile.
    const members = await board.listMembers();
    expect(members.map((m) => m.name).toSorted()).toEqual(["desk", "eng-1", "rev-1", "user"]);
    const desk = members.find((m) => m.name === "desk");
    expect(desk).toMatchObject({ role: "concierge", resident: true, memberships: [] });
    expect(desk?.profile).toContain("# Profile");
    const eng = members.find((m) => m.name === "eng-1");
    expect(eng).toMatchObject({ memberships: ["demo"], claimsHeld: 0, tasksDone: 0 });
    const demoTask = await board.createTask(USER, { project: "demo", title: "d" });
    await board.claimTask(ENG, { task_id: demoTask.id });
    expect((await board.listMembers()).find((m) => m.name === "eng-1")?.claimsHeld).toBe(1);
    await board.advanceTask(ENG, { task_id: demoTask.id });
    const after = (await board.listMembers()).find((m) => m.name === "eng-1");
    expect(after).toMatchObject({ claimsHeld: 0, tasksDone: 1 });

    // The roster carries the configured model and the model the last turn reported.
    await board.addAgent(USER, { name: "eng-3", role: "engineer", cli: "codex", model: "gpt-5" });
    expect((await board.listMembers()).find((m) => m.name === "eng-3")).toMatchObject({
      model: "gpt-5",
    });
    const turn = {
      agent: "eng-1",
      project: "demo",
      runner: "server",
      cli: "claude" as const,
      session: "s",
      trigger: { kind: "manual" as const, fromUser: true, reason: "dev" },
      startedAt: "2026-09-28T10:05:00.000Z",
      endedAt: "2026-09-28T10:06:00.000Z",
      exitReason: "completed" as const,
      status: null,
      error: null,
      usage: null,
      costUsd: 0.2,
      toolCalls: 1,
      model: "claude-opus-5-5",
    };
    await board.beginTurn(turn);
    await board.finishTurn(turn);
    expect((await board.listMembers()).find((m) => m.name === "eng-1")).toMatchObject({
      lastModel: "claude-opus-5-5",
    });
    const completedEvent = (await board.readEvents(null)).findLast(
      (event) => event.type === "turn.completed",
    );
    expect(completedEvent?.payload["model"]).toBe("claude-opus-5-5");

    // Every post by the user wakes the front desk, so every one reaches its digest, even in a
    // thread it takes no part in; the thread's participants read it as usual, and nobody else.
    const topic = await board.openThread(ENG, { channel: "demo/dev", title: "flaky test" });
    const aside = await board.postMessage(USER, {
      body: "is this still failing?",
      thread_id: topic.id,
    });
    expect((await board.readDigest(DESK, { advance: false })).messages.map((m) => m.id)).toContain(
      aside.id,
    );
    expect((await board.readDigest(ENG, { advance: false })).messages.map((m) => m.id)).toContain(
      aside.id,
    );
    expect(
      (await board.readDigest(REV, { advance: false })).messages.map((m) => m.id),
    ).not.toContain(aside.id);

    // Society-scope wakes are for roles that may work outside projects.
    await expect(
      board.requestWake(USER, { agent: "desk", project: "society", reason: "dev" }),
    ).resolves.toMatchObject({ type: "wake.requested" });
    await expect(
      board.requestWake(USER, { agent: "eng-1", project: "society", reason: "dev" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // Turn tokens can be extended for a resident session and revoked when it closes.
    const token = board.issueTurnToken("desk", "concierge", 1_000);
    expect(board.extendTurnToken(token, 60_000)).toBe(true);
    clock = new Date(clock.getTime() + 30_000);
    expect(board.resolveToken(token)).toEqual(DESK);
    board.revokeTurnToken(token);
    expect(board.resolveToken(token)).toBeNull();
  });

  it("shares knowledge and skills: write_knowledge, skill promotion, and search over the archive", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };

    // Project knowledge needs membership; society knowledge needs the steward or the user.
    const written = await board.writeKnowledge(ENG, {
      project: "demo",
      topic: "testing",
      body: "Run `uv run pytest -q`; fixtures live under tests/fixtures.",
    });
    expect(written).toMatchObject({ project: "demo", topic: "testing", updatedBy: "eng-1" });
    await expect(
      board.writeKnowledge(ENG, { project: null, topic: "norms", body: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await board.addProject(USER, { slug: "other" });
    await expect(
      board.writeKnowledge(ENG, { project: "other", topic: "t", body: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await board.writeKnowledge(STEW, {
      project: null,
      topic: "norms",
      body: "Summaries close threads. Silence is allowed.",
    });
    expect(await board.readSocietyNorms()).toContain("Silence is allowed");
    expect((await board.listKnowledge("demo")).map((k) => k.topic)).toEqual(["testing"]);
    expect((await board.listChannel("demo/general")).at(-1)?.body).toContain(
      "Knowledge written: testing",
    );
    await board.writeKnowledge(ENG, {
      project: "demo",
      topic: "testing",
      body: "Run `uv run pytest -q` (updated).",
    });
    expect((await board.listKnowledge("demo"))[0]?.body).toContain("(updated)");
    expect((await board.listChannel("demo/general")).at(-1)?.body).toContain("Knowledge updated");

    // A citizen's own skill and archive are searchable by that citizen only, and the roster lists its skills.
    await mkdir(board.paths.agentSkill("eng-1", "uv-setup"), { recursive: true });
    await writeFile(
      board.paths.agentSkillFile("eng-1", "uv-setup"),
      "---\nname: uv-setup\ndescription: Set up a uv project with locked dependencies\n---\n# uv setup\n\nRun uv sync --locked before the tests.\n",
      "utf8",
    );
    await writeFile(
      path.join(board.paths.agentMemory("eng-1"), "python.md"),
      "# Python\n\nThe user prefers ruff over black.\n",
      "utf8",
    );
    expect((await board.search(ENG, { query: "ruff" })).map((h) => [h.kind, h.ref])).toEqual([
      ["memory", "memory/python.md"],
    ]);
    expect(await board.search(REV, { query: "ruff" })).toEqual([]);
    expect((await board.search(ENG, { query: "locked" })).map((h) => h.ref)).toEqual([
      "skills/uv-setup",
    ]);
    expect((await board.listAgentSkills("eng-1")).map((s) => [s.name, s.summary])).toEqual([
      ["uv-setup", "Set up a uv project with locked dependencies"],
    ]);
    const turn = {
      agent: "eng-1",
      project: "demo",
      runner: "server",
      cli: "claude" as const,
      session: "s",
      trigger: { kind: "reflection" as const, fromUser: false, reason: "scheduled" },
      startedAt: "2026-09-28T10:05:00.000Z",
      endedAt: "2026-09-28T10:06:00.000Z",
      exitReason: "completed" as const,
      status: null,
      error: null,
      usage: null,
      costUsd: 0,
      toolCalls: 0,
      model: null,
    };
    await board.beginTurn(turn);
    await board.finishTurn(turn);
    expect((await board.listMembers()).find((m) => m.name === "eng-1")?.skills).toEqual([
      "uv-setup",
    ]);

    // Promotion: a skill proposal the steward approves lands under the society's skills, for everyone.
    const proposal = await board.propose(ENG, {
      kind: "skill",
      charter: {
        name: "uv-setup",
        summary: "Set up a uv project with locked dependencies",
        body: "Run uv sync --locked before the tests.",
      },
      rationale: "Every Python project here needs it.",
    });
    await board.approve(STEW, { proposal_id: proposal.id });
    expect((await board.readProposal(proposal.id)).status).toBe("provisioned");
    expect((await board.listSocietySkills()).map((s) => [s.name, s.scope])).toEqual([
      ["uv-setup", "society"],
    ]);
    // The announcement posts quote the summary, so search for a phrase only the body carries.
    expect((await board.search(REV, { query: "uv sync" })).map((h) => h.ref)).toEqual([
      "society/skills/uv-setup",
    ]);
    expect((await board.listChannel("general")).at(-1)?.body).toContain("Skill uv-setup promoted");

    // A reflection can be requested ahead of the cadence.
    const wake = await board.requestWake(USER, {
      agent: "eng-1",
      project: "demo",
      reason: "reflect now",
      kind: "reflection",
    });
    expect(wake.payload["kind"]).toBe("reflection");
  });

  it("resolves a relative data directory, so worktree and home paths never depend on a cwd", async () => {
    const relative = path.relative(process.cwd(), dir);
    expect(path.isAbsolute(relative)).toBe(false);
    const { board } = await Board.init(relative, { name: "relative" });
    expect(board.paths.dataDir).toBe(dir);
    expect((await board.listRoles()).map((role) => role.name).toSorted()).toEqual([
      "concierge",
      "steward",
      "user",
    ]);
    expect(path.isAbsolute(board.paths.worktree("eng-1", "demo"))).toBe(true);
    expect(board.paths.repo("demo")).toBe(path.join(dir, "repos", "demo"));
    expect((await Board.open(relative)).paths.agent("eng-1")).toBe(
      path.join(dir, "agents", "eng-1"),
    );
  });

  it("counts a turn's board actions from its transcript for the metrics", async () => {
    const { board } = await society();
    const finish = async (transcript: ReturnType<typeof result>[]) => {
      const turn = await board.beginTurn(turnIn(undefined, "2026-09-28T10:00:00.000Z"));
      await board.finishTurn(
        { ...turn, endedAt: "2026-09-28T10:01:00.000Z", exitReason: "completed" },
        transcript,
      );
    };
    // A post changes the board; a read, a failed claim, and a shell command do not.
    await finish([result("mcp__board__post_message", true)]);
    await finish([
      result("Bash", true),
      result("mcp__board__get_task", true),
      result("mcp__board__claim_task", false),
    ]);
    // A turn that kept no transcript is counted apart.
    await finish([]);
    expect((await board.metrics("all")).idle).toMatchObject({
      turns: 2,
      idle: 1,
      unknown: 1,
      byAgent: [{ agent: "eng-1", role: "engineer", turns: 2, idle: 1 }],
    });
  });
});
