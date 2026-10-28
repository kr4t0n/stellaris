import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IMAGE_LIMIT_BYTES, MEMBER_VERBS, VERB_DESCRIPTIONS, type Ulid } from "@stellaris/shared";
import { execa } from "execa";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Board, BoardError, SYSTEM_ACTOR, type Actor, type TurnInFlight } from "./index.js";

const USER: Actor = { name: "user", role: "user" };
const ENG: Actor = { name: "eng-1", role: "engineer" };
const REV: Actor = { name: "rev-1", role: "reviewer" };

/** A turn record of eng-1 in demo, in a thread's conversation or at home. */
/** A tool's result as a turn's transcript keeps it. */
const result = (name: string, ok: boolean) => ({
  ts: "2026-09-28T10:00:30.000Z",
  event: { type: "tool_result" as const, name, ok },
});

/** A skill's SKILL.md in a citizen's home, committed as a runner's push after a turn leaves it. */
async function homeSkill(board: Board, agent: string, name: string, text: string): Promise<void> {
  await mkdir(board.paths.agentSkill(agent, name), { recursive: true });
  await writeFile(board.paths.agentSkillFile(agent, name), text, "utf8");
  const home = board.paths.agent(agent);
  await execa("git", ["add", "--all"], { cwd: home });
  await execa(
    "git",
    ["-c", `user.name=${agent}`, "-c", "user.email=e@x", "commit", "-qm", "turn"],
    {
      cwd: home,
    },
  );
}

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

/** The refusal of ending a conversation under `who`'s turn there. */
function cut(who: string): object {
  return {
    code: "INVALID_STATE",
    message: expect.stringContaining(`while ${who} is in a turn there`),
  };
}

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
    expect((await board.society()).channels).toEqual(["general", "governance", "asks"]);
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

  it("signs the user in for a while, across a restart, until signed out or expired", async () => {
    const { board, userToken } = await society();
    const first = await board.signIn("kr4t0n", 60_000);
    const avatar = "https://avatars.githubusercontent.com/u/1001?v=4";
    const second = await board.signIn("kr4t0n", 120_000, avatar);
    expect(board.resolveToken(first)).toEqual(USER);
    expect(board.signInOf(first)).toEqual({ login: "kr4t0n", avatarUrl: undefined });
    expect(board.signInOf(userToken)).toBeNull();
    // The board keeps only hashes of sign-ins, as of every other token.
    const stored = await readFile(path.join(board.paths.state(), "sign-ins.json"), "utf8");
    expect(stored).not.toContain(first);

    expect(await board.signOut(first)).toBe(true);
    expect(await board.signOut(first)).toBe(false);
    expect(await board.signOut(userToken)).toBe(false);
    expect(board.resolveToken(first)).toBeNull();
    expect(board.resolveToken(userToken)).toEqual(USER);

    const reopened = await Board.open(dir, { now });
    expect(reopened.resolveToken(second)).toEqual(USER);
    expect(reopened.signInOf(second)).toEqual({ login: "kr4t0n", avatarUrl: avatar });
    clock = new Date(clock.getTime() + 120_000);
    expect(reopened.resolveToken(second)).toBeNull();
    expect(reopened.signInOf(second)).toBeNull();
    const types = (await reopened.readEvents(null)).map((event) => event.type);
    expect(types.filter((type) => type.startsWith("user.signed"))).toEqual([
      "user.signed_in",
      "user.signed_in",
      "user.signed_out",
    ]);
  });

  it("rotates the user token: the old one stops working, the new one lasts", async () => {
    const { board, userToken } = await society();
    const rotated = await board.rotateUserToken();
    expect(board.resolveToken(userToken)).toBeNull();
    expect(board.resolveToken(rotated)).toEqual(USER);
    const reopened = await Board.open(dir);
    expect(reopened.resolveToken(userToken)).toBeNull();
    expect(reopened.resolveToken(rotated)).toEqual(USER);
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
      { scope: "demo", thread: task.id, channel: null, place: null, count: 1 },
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

    // A society channel is filed where a mention there wakes eng-1: outside any project.
    expect(await ids("demo")).toEqual([inDemo.id]);
    expect(await ids("lab")).toEqual([inLab.id]);
    expect(await ids("society")).toEqual([inSociety.id]);
    expect(await ids()).toEqual([inDemo.id, inLab.id, inSociety.id]);

    // A turn in lab moves lab's cursor alone, and a turn that read earlier but ends later cannot
    // rewind demo's.
    await board.setDigestCursor("eng-1", "lab", inLab.id);
    expect(await ids("lab")).toEqual([]);
    expect(await ids("demo")).toEqual([inDemo.id]);
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

  it("carries news to a work role's next general conversation, in a project or outside, once", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const task = await board.createTask(USER, { project: "demo", title: "build" });
    const ids = async (scope: string, thread?: string): Promise<string[]> =>
      (
        await board.readDigest(
          { ...ENG, scope, ...(thread === undefined ? {} : { thread }) },
          { advance: false },
        )
      ).messages.map((m) => m.id);

    // News in general, which eng-1 follows: whichever general conversation reads first gets it,
    // and a task's thread never does.
    const news = await board.postMessage(REV, { channel: "general", body: "the build is green" });
    expect(await ids("demo")).toEqual([news.id]);
    expect(await ids("society")).toEqual([news.id]);
    expect(await ids("demo", task.id)).toEqual([]);
    // It is read once: a turn in demo read it, so the turn outside projects does not again.
    await board.setDigestCursor("eng-1", "demo", news.id);
    expect(await ids("society")).toEqual([]);

    // A question in general is no news: it goes where it was asked, outside projects, alone.
    const asked = await board.postMessage(USER, { channel: "general", body: "@eng-1 a question" });
    const later = await board.postMessage(REV, { channel: "general", body: "and the docs too" });
    expect(await ids("society")).toEqual([asked.id, later.id]);
    expect(await ids("demo")).toEqual([later.id]);
    await board.setDigestCursor("eng-1", "society", later.id);
    expect(await ids("demo")).toEqual([]);

    // News wakes no work role; a society role reads it in its own scope, where its heartbeat looks:
    // rev-1's three posts, and the user's, which the front desk reads wherever it is.
    await board.postMessage(REV, { channel: "general", body: "one more thing" });
    expect(await board.unreadByConversation(ENG)).toEqual([]);
    expect(await board.unreadByConversation({ name: "desk", role: "concierge" })).toEqual([
      { scope: "society", thread: null, channel: null, place: null, count: 4 },
    ]);
  });

  it("scans a digest without holding up a post, and counts nothing written during the scan", async () => {
    const { board } = await society();
    for (let n = 0; n < 500; n += 1) {
      await board.postMessage(REV, { channel: "demo/general", body: `note ${n}` });
    }
    let scanned = false;
    const scan = board.unreadByConversation(ENG).then((counts) => {
      scanned = true;
      return counts;
    });
    await board.postMessage(REV, { channel: "demo/general", body: "meanwhile" });
    // The post did not wait for the heartbeat's scan of five hundred messages.
    expect(scanned).toBe(false);
    // The scan took its mark before the post, so it counts the five hundred alone; the next sees it.
    expect(await scan).toEqual([
      { scope: "demo", thread: null, channel: null, place: null, count: 500 },
    ]);
    expect(await board.unreadByConversation(ENG)).toEqual([
      { scope: "demo", thread: null, channel: null, place: null, count: 501 },
    ]);
  });

  it("never moves a cursor past a message written while its digest was read", async () => {
    const { board } = await society();
    const posted: string[] = [];
    const delivered = new Set<string>();
    for (let round = 0; round < 20; round += 1) {
      const [digest, ...posts] = await Promise.all([
        board.readDigest(ENG, { advance: true }),
        board.postMessage(USER, { channel: "demo/dev", body: `@eng-1 dev ${round}` }),
        board.postMessage(USER, { channel: "demo/general", body: `@eng-1 general ${round}` }),
      ]);
      posted.push(...posts.map((post) => post.id));
      for (const message of digest.messages) {
        delivered.add(message.id);
      }
    }
    for (const message of (await board.readDigest(ENG, { advance: true })).messages) {
      delivered.add(message.id);
    }
    expect(posted.filter((id) => !delivered.has(id))).toEqual([]);
  });

  it("names on a stage only a citizen who could hold it", async () => {
    const { board } = await society();
    await board.addProject(USER, { slug: "lab" });
    await board.addAgent(USER, {
      name: "eng-2",
      role: "engineer",
      cli: "claude",
      memberships: ["lab"],
    });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const refused = { code: "INVALID_STATE" };
    // A member, a role, nobody, and the user, who may hold any stage, are all fine.
    const task = await board.createTask(USER, {
      project: "demo",
      title: "t",
      stages: [
        { name: "build", agent: "eng-1" },
        { name: "review", role: "reviewer" },
        { name: "polish" },
        { name: "sign off", agent: "user" },
      ],
    });
    // A citizen of another project could never claim it, nor could a society role.
    for (const agent of ["eng-2", "desk"]) {
      await expect(
        board.createTask(USER, { project: "demo", title: "u", stages: [{ name: "build", agent }] }),
      ).rejects.toMatchObject(refused);
      await expect(
        board.planTask(USER, {
          task_id: task.id,
          stages: [
            { id: "s1", name: "build", agent: "eng-1" },
            { name: "extra", agent },
          ],
        }),
      ).rejects.toMatchObject(refused);
    }
    // Once added to the project, it may be named.
    await board.joinProject(USER, { project: "demo", agent: "eng-2" });
    await board.planTask(USER, {
      task_id: task.id,
      stages: [
        { id: "s1", name: "build", agent: "eng-1" },
        { name: "extra", agent: "eng-2" },
      ],
    });
  });

  it("keeps society roles out of every project, by every path", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const DESK = { name: "desk", role: "concierge" };
    const refused = { code: "INVALID_STATE" };
    // Joining itself, or being moved by the user.
    await expect(board.joinProject(DESK, { project: "demo" })).rejects.toMatchObject(refused);
    await expect(board.joinProject(USER, { project: "demo", agent: "desk" })).rejects.toMatchObject(
      refused,
    );
    // Added, directly or by a member proposal, with a project.
    await expect(
      board.addAgent(USER, { name: "stew", role: "steward", cli: "claude", memberships: ["demo"] }),
    ).rejects.toMatchObject(refused);
    await expect(
      board.propose(DESK, {
        kind: "member",
        charter: { name: "stew", role: "steward", cli: "claude", memberships: ["demo"] },
      }),
    ).rejects.toMatchObject(refused);
    // A work role whose member is in a project cannot become a society role.
    await expect(
      board.setRoleCharter(USER, {
        name: "engineer",
        purpose: "Builds.",
        verbs: [...MEMBER_VERBS],
        societyScope: true,
      }),
    ).rejects.toMatchObject(refused);
    // It still moves others: staffing a project is how the front desk routes work.
    await board.addAgent(USER, { name: "eng-2", role: "engineer", cli: "claude" });
    await board.joinProject(DESK, { project: "demo", agent: "eng-2" });
    expect((await board.readAgent("eng-2")).memberships).toEqual(["demo"]);
    expect((await board.readAgent("desk")).memberships).toEqual([]);
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
      { scope: "demo", thread: null, channel: null, place: null, count: 1 },
      { scope: "demo", thread: task.id, channel: null, place: null, count: 1 },
      { scope: "demo", thread: topic.id, channel: null, place: null, count: 1 },
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
    await board.writeSession("eng-1", "demo", "claude", "home-session", "pod");
    await board.writeSession("eng-1", "demo", "claude", "task-session", "pod", task.id);
    expect(await board.readSessions("eng-1", "demo")).toEqual({
      claude: "home-session",
      runner: "pod",
    });
    expect(await board.readSessions("eng-1", "demo", task.id)).toEqual({
      claude: "task-session",
      runner: "pod",
    });
    // Two turns in one scope at once: each pairs its start with its own end.
    clock = new Date("2026-09-28T10:01:00.000Z");
    const home = await board.beginTurn(turnIn(undefined, clock.toISOString()));
    clock = new Date("2026-09-28T10:02:00.000Z");
    const inThread = await board.beginTurn(turnIn(task.id, clock.toISOString()));
    const usage = {
      inputTokens: 12,
      outputTokens: 340,
      cacheReadTokens: 56_000,
      cacheWriteTokens: 780,
    };
    await board.finishTurn({
      ...inThread,
      endedAt: "2026-09-28T10:04:00.000Z",
      exitReason: "completed",
      usage,
    });
    await board.finishTurn({
      ...home,
      endedAt: "2026-09-28T10:03:00.000Z",
      exitReason: "completed",
    });
    expect((await board.readLastTurn("eng-1", "demo"))?.session).toBe("home-session");
    expect((await board.readLastTurn("eng-1", "demo", task.id))?.session).toBe("task-session");
    expect((await board.readLatestTurn("eng-1", "demo"))?.thread).toBe(task.id);
    // The history carries the tokens a turn reported, and none for a turn that reported none.
    expect(
      (await board.listTurns("eng-1")).map((entry) => [entry.thread, entry.startedAt, entry.usage]),
    ).toEqual([
      [task.id, "2026-09-28T10:02:00.000Z", usage],
      [undefined, "2026-09-28T10:01:00.000Z", undefined],
    ]);
    // The roster's line names the conversation of the citizen's latest turn beside its scope.
    const outcome = async () =>
      (await board.listMembers()).find((m) => m.name === "eng-1")?.lastTurnOutcome;
    expect(await outcome()).toBe(`manual on demo in thread ${task.id}: completed`);
    const elsewhere = [
      ["10:05", { channel: "dev" }, "manual on demo in #dev: completed"],
      [
        "10:06",
        { project: "society", place: "lab" },
        "manual on society in lab's channels: completed",
      ],
      ["10:07", {}, "manual on demo: completed"],
    ] as const;
    for (const [at, where, line] of elsewhere) {
      const turn = await board.beginTurn({
        ...turnIn(undefined, `2026-09-28T${at}:00.000Z`),
        ...where,
      });
      await board.finishTurn({
        ...turn,
        endedAt: `2026-09-28T${at}:30.000Z`,
        exitReason: "completed",
      });
      expect(await outcome()).toBe(line);
    }
  });

  it("counts a closed thread's posts toward no heartbeat, while its conversation still reads them", async () => {
    const { board } = await society();
    const task = await board.createTask(USER, {
      project: "demo",
      title: "build",
      stages: [{ name: "build", agent: "eng-1" }],
    });
    const topic = await board.openThread(ENG, { channel: "demo/dev", title: "which library?" });
    const open = await board.openThread(ENG, { channel: "demo/dev", title: "and the date?" });
    // A front desk, in no project, takes part in the task's thread from the society scope.
    const FRONT: Actor = { name: "concierge-1", role: "concierge" };
    await board.addAgent(USER, { name: FRONT.name, role: FRONT.role, cli: "claude" });
    await board.postMessage(FRONT, { thread_id: task.id, body: "who takes this?" });
    const inTask = await board.postMessage(REV, { thread_id: task.id, body: "the spec" });
    await board.postMessage(REV, { thread_id: topic.id, body: "try zod" });
    await board.postMessage(REV, { thread_id: open.id, body: "next week" });
    await board.postMessage(REV, { thread_id: open.id, body: "or the week after" });
    const stillOpen = { scope: "demo", thread: open.id, channel: null, place: null, count: 2 };
    expect(await board.unreadByConversation(ENG)).toEqual([
      { scope: "demo", thread: task.id, channel: null, place: null, count: 2 },
      { scope: "demo", thread: topic.id, channel: null, place: null, count: 1 },
      stillOpen,
    ]);
    expect(await board.unreadByConversation(FRONT)).toEqual([
      { scope: "society", thread: task.id, channel: null, place: null, count: 1 },
    ]);

    // A task's thread closes with its task, a topic's when someone closes it; only the thread
    // still open asks for a turn, in a project and outside it.
    await board.updateTask(USER, { task_id: task.id, status: "abandoned" });
    await board.closeThread(REV, { thread_id: topic.id, summary: "zod it is." });
    expect(await board.unreadByConversation(ENG)).toEqual([stillOpen]);
    expect(await board.unreadByConversation(FRONT)).toEqual([]);
    // A wake queued before the close still runs there and reads what it missed.
    expect(
      (
        await board.readDigest({ ...ENG, scope: "demo", thread: task.id }, { advance: false })
      ).messages.map((m) => m.id),
    ).toContain(inTask.id);
  });

  it("files a channel's posts beside general in a conversation of its own, until it is archived", async () => {
    const { board } = await society();
    await board.subscribe(ENG, { channel: "demo/dev" });
    const inGeneral = await board.postMessage(REV, {
      channel: "demo/general",
      body: "@eng-1 a general question",
    });
    const inDev = await board.postMessage(REV, { channel: "demo/dev", body: "the release plan" });
    const asked = await board.postMessage(REV, { channel: "demo/dev", body: "@eng-1 the date?" });
    const ids = async (channel?: string): Promise<Ulid[]> =>
      (
        await board.readDigest(
          { ...ENG, scope: "demo", ...(channel === undefined ? {} : { channel }) },
          { advance: false },
        )
      ).messages.map((m) => m.id);

    // General's posts are the home conversation's; each other channel's are its own.
    expect(await ids()).toEqual([inGeneral.id]);
    expect(await ids("dev")).toEqual([inDev.id, asked.id]);
    // The society's news is a general conversation's to read, never a channel's.
    const news = await board.postMessage(REV, { channel: "general", body: "the build is green" });
    expect(await ids("dev")).toEqual([inDev.id, asked.id]);
    expect(await ids()).toEqual([inGeneral.id, news.id]);
    expect(await board.unreadByConversation(ENG)).toEqual([
      { scope: "demo", thread: null, channel: null, place: null, count: 1 },
      { scope: "demo", thread: null, channel: "dev", place: null, count: 2 },
    ]);

    // A channel token reads its channel, and its turn moves that conversation's cursor alone.
    const actor = board.resolveToken(
      board.issueTurnToken("eng-1", "engineer", 60_000, "demo", "#dev"),
    );
    expect(actor).toEqual({ ...ENG, scope: "demo", channel: "dev" });
    await board.setDigestCursor("eng-1", "demo", inDev.id, "#dev");
    expect(await ids("dev")).toEqual([asked.id]);
    expect(await ids()).toEqual([inGeneral.id, news.id]);

    // Sessions and last turns are kept beside the home's, and count toward the scope's latest.
    await board.writeSession("eng-1", "demo", "claude", "dev-session", "pod", "#dev");
    expect(await board.readSessions("eng-1", "demo", "#dev")).toEqual({
      claude: "dev-session",
      runner: "pod",
    });
    expect(await board.readSessions("eng-1", "demo")).toEqual({});
    const turn = await board.beginTurn({
      ...turnIn(undefined, "2026-09-28T10:01:00.000Z"),
      channel: "dev",
      session: "dev-session",
    });
    await board.finishTurn({
      ...turn,
      endedAt: "2026-09-28T10:02:00.000Z",
      exitReason: "completed",
    });
    expect((await board.readLastTurn("eng-1", "demo", "#dev"))?.session).toBe("dev-session");
    expect(await board.readLastTurn("eng-1", "demo")).toBeNull();
    expect((await board.readLatestTurn("eng-1", "demo"))?.channel).toBe("dev");
    expect((await board.listTurns("eng-1")).map((entry) => entry.channel)).toEqual(["dev"]);

    // Archived, the channel's conversation has ended: what it left unread is the home's.
    await board.archiveChannel(USER, { channel: "demo/dev", reason: "shipped" });
    expect(await ids("dev")).toEqual([]);
    expect(await ids()).toContain(asked.id);
    expect(await board.channelOpen("demo/dev")).toBe(false);
    expect(await board.channelOpen("demo/general")).toBe(true);
  });

  it("files a project's channels in a conversation of their own for a citizen outside it, until it is archived", async () => {
    const { board } = await society();
    await board.addProject(USER, { slug: "lab", channels: ["general", "dev"] });
    // The front desk, a society role, reads every post by the user, in every project's channels.
    await board.addAgent(USER, { name: "concierge-1", role: "concierge", cli: "claude" });
    const FRONT: Actor = { name: "concierge-1", role: "concierge" };
    const demoGeneral = await board.postMessage(USER, { channel: "demo/general", body: "demo?" });
    const demoDev = await board.postMessage(USER, { channel: "demo/dev", body: "demo's dev?" });
    const labDev = await board.postMessage(USER, { channel: "lab/dev", body: "lab's dev?" });
    const inSociety = await board.postMessage(USER, { channel: "general", body: "the society?" });
    const topic = await board.openThread(REV, { channel: "lab/general", title: "the logo" });
    const inTopic = await board.postMessage(USER, { thread_id: topic.id, body: "which logo?" });
    const ids = async (actor: Actor, where: { place?: string; thread?: Ulid } = {}) =>
      (
        await board.readDigest({ ...actor, scope: "society", ...where }, { advance: false })
      ).messages.map((m) => m.id);

    // Each project's channels, general and workstreams alike, are one conversation; no project's
    // posts reach another's, the society's home, or a thread.
    expect(await ids(FRONT, { place: "demo" })).toEqual([demoGeneral.id, demoDev.id]);
    expect(await ids(FRONT, { place: "lab" })).toEqual([labDev.id]);
    expect(await ids(FRONT)).toEqual([inSociety.id]);
    expect(await ids(FRONT, { thread: topic.id })).toEqual([inTopic.id]);
    expect(await board.unreadByConversation(FRONT)).toEqual(
      expect.arrayContaining([
        { scope: "society", thread: null, channel: null, place: null, count: 1 },
        { scope: "society", thread: null, channel: null, place: "demo", count: 2 },
        { scope: "society", thread: null, channel: null, place: "lab", count: 1 },
        { scope: "society", thread: topic.id, channel: null, place: null, count: 1 },
      ]),
    );

    // A citizen mentioned in a project it is not in reads that project's post there, and the news
    // of the society's channels it follows only in a general conversation.
    const news = await board.postMessage(REV, { channel: "general", body: "the build is green" });
    const asked = await board.postMessage(REV, { channel: "lab/general", body: "@eng-1 a look?" });
    expect(await ids(ENG, { place: "lab" })).toEqual([asked.id]);
    expect(await ids(ENG)).toEqual([inSociety.id, news.id]);

    // The conversation's token reads it, and its turn moves its cursor alone.
    const actor = board.resolveToken(
      board.issueTurnToken("concierge-1", "concierge", 60_000, "society", "~demo"),
    );
    expect(actor).toEqual({ ...FRONT, scope: "society", place: "demo" });
    await board.setDigestCursor("concierge-1", "society", demoGeneral.id, "~demo");
    expect(await ids(FRONT, { place: "demo" })).toEqual([demoDev.id]);
    expect(await ids(FRONT, { place: "lab" })).toEqual([labDev.id]);
    expect(await ids(FRONT)).toEqual([inSociety.id, news.id]);

    // Sessions and last turns are kept beside the home's, and count toward the scope's latest.
    await board.writeSession("concierge-1", "society", "claude", "lab-session", "runner-1", "~lab");
    expect(await board.readSessions("concierge-1", "society", "~lab")).toEqual({
      claude: "lab-session",
      runner: "runner-1",
    });
    expect(await board.readSessions("concierge-1", "society")).toEqual({});
    await expect(
      stat(
        path.join(
          dir,
          "agents",
          "concierge-1",
          "projects",
          "society",
          "places",
          "lab",
          "sessions.json",
        ),
      ),
    ).resolves.toBeDefined();
    const turn = await board.beginTurn({
      ...turnIn(undefined, "2026-09-28T10:01:00.000Z"),
      agent: "concierge-1",
      project: "society",
      place: "lab",
      session: "lab-session",
    });
    await board.finishTurn({
      ...turn,
      endedAt: "2026-09-28T10:02:00.000Z",
      exitReason: "completed",
    });
    expect((await board.readLastTurn("concierge-1", "society", "~lab"))?.session).toBe(
      "lab-session",
    );
    expect(await board.readLastTurn("concierge-1", "society")).toBeNull();
    expect((await board.readLatestTurn("concierge-1", "society"))?.place).toBe("lab");
    expect((await board.listTurns("concierge-1")).map((entry) => entry.place)).toEqual(["lab"]);

    // A cron set from that conversation fires there, and the archive ends it.
    const cron = await board.createCron(
      { ...FRONT, scope: "society", place: "lab" },
      { title: "Check lab", note: "Read lab's channels.", cron: "*/30 * * * *" },
    );
    expect(cron).toMatchObject({ agent: "concierge-1", scope: "society", place: "lab" });
    expect(cron.channel).toBeUndefined();

    // Archived, the project's conversation has ended: what it left unread is the home's.
    expect(await board.conversationEnded({ kind: "place", project: "lab" })).toBe(false);
    await board.closeThread(REV, { thread_id: topic.id, summary: "The round one." });
    await board.archiveProject(USER, { project: "lab", reason: "done" });
    expect(await board.conversationEnded({ kind: "place", project: "lab" })).toBe(true);
    expect((await board.readCron(cron.id)).ended?.reason).toBe("project lab was archived");
    expect(await ids(FRONT, { place: "lab" })).toEqual([]);
    // The board's notice of the archive, in the society's general, is the home's too.
    const home = await ids(FRONT);
    expect(home).toEqual(expect.arrayContaining([labDev.id, inSociety.id, news.id]));
    expect(home).not.toContain(demoDev.id);
    expect(await ids(FRONT, { place: "demo" })).toEqual([demoDev.id]);
  });

  it("refuses to archive a project under a turn in a citizen's conversation of its channels", async () => {
    const { board } = await society();
    await board.addProject(USER, { slug: "lab" });
    let inFlight: TurnInFlight[] = [{ agent: "concierge-1", scope: "society", place: "lab" }];
    board.watchTurns(() => inFlight);
    await expect(
      board.archiveProject(USER, { project: "lab", reason: "done" }),
    ).rejects.toMatchObject(cut("concierge-1"));
    // A turn in the conversation of another project's channels is no cut.
    inFlight = [{ agent: "concierge-1", scope: "society", place: "demo" }];
    await board.archiveProject(USER, { project: "lab", reason: "done" });
  });

  it("lets only the user move a project, never while a task lands or a turn runs there, and records where it went", async () => {
    const { board } = await society();
    await board.addRunner(USER, "pod");
    await board.addRunner(USER, "lab-box");
    await expect(board.prepareProjectMove(USER, "demo", "pod")).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("its first turn places it"),
    });
    await board.placeProject("demo", "pod");
    const planners: Actor[] = [
      ENG,
      { name: "stew", role: "steward" },
      { name: "concierge-1", role: "concierge" },
    ];
    for (const actor of planners) {
      await expect(board.prepareProjectMove(actor, "demo", "lab-box")).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        board.recordProjectMove(actor, { slug: "demo", from: "pod", to: "lab-box", carried: 1 }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(board.prepareProjectMove(USER, "demo", "pod")).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("already lives on pod"),
    });
    await expect(board.prepareProjectMove(USER, "demo", "elsewhere")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // A task in play moves with its branch; the checks name it, for what the new runner must offer.
    const inPlay = await board.createTask(USER, {
      project: "demo",
      title: "train",
      required_capabilities: ["gpu"],
    });
    const prepared = await board.prepareProjectMove(USER, "demo", "lab-box");
    expect(prepared.project.runner).toBe("pod");
    expect(prepared.inPlay.map((task) => [task.id, task.requiredCapabilities])).toEqual([
      [inPlay.id, ["gpu"]],
    ]);

    // A turn in any of the project's conversations refuses it, as an archive is refused.
    let inFlight: TurnInFlight[] = [{ agent: "eng-1", scope: "demo", thread: inPlay.id }];
    board.watchTurns(() => inFlight);
    await expect(board.prepareProjectMove(USER, "demo", "lab-box")).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("project demo cannot be moved while eng-1 is in a turn"),
    });
    inFlight = [{ agent: "concierge-1", scope: "society", place: "demo" }];
    await expect(board.prepareProjectMove(USER, "demo", "lab-box")).rejects.toMatchObject(
      cut("concierge-1"),
    );
    inFlight = [];

    // A task landing lands on the old runner, so the move waits until it has.
    await board.configureProject(USER, { project: "demo", on_done: "merge" });
    const landing = await board.createTask(USER, { project: "demo", title: "land" });
    await board.claimTask(ENG, { task_id: landing.id });
    await board.advanceTask(ENG, { task_id: landing.id });
    await expect(board.prepareProjectMove(USER, "demo", "lab-box")).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining(`land on pod (${landing.id})`),
    });
    await board.finishCompletion(SYSTEM_ACTOR, { taskId: landing.id, ok: true, detail: "merged" });
    await board.prepareProjectMove(USER, "demo", "lab-box");

    // Recorded, the project's later turns go to the new runner, and the log says from where.
    const moved = await board.recordProjectMove(USER, {
      slug: "demo",
      from: "pod",
      to: "lab-box",
      carried: 3,
    });
    expect(moved.runner).toBe("lab-box");
    expect((await board.readProject("demo")).runner).toBe("lab-box");
    expect(await board.placeProject("demo", "pod")).toBe("lab-box");
    const logged = (await board.readEvents(null)).filter((event) => event.type === "project.moved");
    expect(logged.map((event) => [event.actor, event.payload])).toEqual([
      ["user", { slug: "demo", from: "pod", to: "lab-box", carried: 3 }],
    ]);
    // A record of a move from where the project no longer lives no longer applies.
    await expect(
      board.recordProjectMove(USER, { slug: "demo", from: "pod", to: "lab-box", carried: 3 }),
    ).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("no longer lives on pod"),
    });
  });

  it("keeps a move's repository outside the projection, and removes what a crash left as the board opens", async () => {
    const { board } = await society();
    const id = await board.openMoveRepo();
    const repository = path.join(board.moveRepos, `${id}.git`);
    expect(path.relative(board.paths.board, repository).startsWith("..")).toBe(true);
    expect(
      (await execa("git", ["rev-parse", "--is-bare-repository"], { cwd: repository })).stdout,
    ).toBe("true");
    expect(
      (await execa("git", ["config", "receive.fsckObjects"], { cwd: repository })).stdout,
    ).toBe("true");
    expect(Object.keys(await board.boardManifest()).filter((file) => file.includes(id))).toEqual(
      [],
    );
    await board.dropMoveRepo(id);
    await expect(stat(repository)).rejects.toMatchObject({ code: "ENOENT" });

    // A move never outlives the server's process.
    const left = await board.openMoveRepo();
    await Board.open(dir, { now });
    await expect(stat(path.join(board.moveRepos, `${left}.git`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to end a conversation under another citizen's turn, but not under the caller's own", async () => {
    const { board } = await society();
    let inFlight: TurnInFlight[] = [];
    board.watchTurns(() => inFlight);

    // A topic thread closes from inside its closer's own turn there, never under another's.
    const topic = await board.openThread(ENG, { channel: "demo/dev", title: "which library?" });
    await board.postMessage(REV, { thread_id: topic.id, body: "zod" });
    inFlight = [{ agent: "rev-1", scope: "demo", thread: topic.id }];
    await expect(
      board.closeThread(ENG, { thread_id: topic.id, summary: "Zod." }),
    ).rejects.toMatchObject(cut("rev-1"));
    await board.closeThread(
      { ...REV, scope: "demo", thread: topic.id },
      {
        thread_id: topic.id,
        summary: "Zod.",
      },
    );

    // A channel's archive waits for turns in its conversation and in the threads it closes.
    const open = await board.openThread(ENG, { channel: "demo/dev", title: "release date?" });
    inFlight = [{ agent: "eng-1", scope: "demo", channel: "dev" }];
    await expect(
      board.archiveChannel(USER, { channel: "demo/dev", reason: "shipped" }),
    ).rejects.toMatchObject(cut("eng-1"));
    inFlight = [{ agent: "rev-1", scope: "demo", thread: open.id }];
    await expect(
      board.archiveChannel(USER, { channel: "demo/dev", reason: "shipped" }),
    ).rejects.toMatchObject(cut("rev-1"));
    inFlight = [{ agent: "rev-1", scope: "demo" }];
    await board.archiveChannel(USER, { channel: "demo/dev", reason: "shipped" });

    // A task ends by its holder's last advance from its own turn, and is abandoned under no turn.
    const task = await board.createTask(USER, {
      project: "demo",
      title: "build",
      stages: [{ name: "build", agent: "eng-1" }],
    });
    await board.claimTask(ENG, { task_id: task.id });
    inFlight = [{ agent: "rev-1", scope: "demo", thread: task.id }];
    await expect(board.advanceTask(ENG, { task_id: task.id })).rejects.toMatchObject(cut("rev-1"));
    inFlight = [{ agent: "eng-1", scope: "demo", thread: task.id }];
    await board.advanceTask({ ...ENG, scope: "demo", thread: task.id }, { task_id: task.id });
    expect((await board.findTask(task.id)).task.status).toBe("done");
    const dropped = await board.createTask(USER, { project: "demo", title: "drop" });
    inFlight = [{ agent: "eng-1", scope: "demo", thread: dropped.id }];
    await expect(
      board.updateTask(USER, { task_id: dropped.id, status: "abandoned" }),
    ).rejects.toMatchObject(cut("eng-1"));
    inFlight = [];
    await board.updateTask(USER, { task_id: dropped.id, status: "abandoned" });

    // A proposal is decided under no turn in its thread, and a project archived under none in it.
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const archive = await board.propose(
      { name: "stew", role: "steward" },
      {
        kind: "archive",
        charter: { project: "demo", reason: "Its work is done." },
        rationale: "Nothing is left in play.",
      },
    );
    inFlight = [{ agent: "stew", scope: "society", thread: archive.id }];
    await expect(board.approve(USER, { proposal_id: archive.id })).rejects.toMatchObject(
      cut("stew"),
    );
    inFlight = [{ agent: "eng-1", scope: "demo" }];
    await expect(board.approve(USER, { proposal_id: archive.id })).rejects.toMatchObject(
      cut("eng-1"),
    );
    await expect(
      board.archiveProject(USER, { project: "demo", reason: "done" }),
    ).rejects.toMatchObject(cut("eng-1"));
    inFlight = [];
    await board.approve(USER, { proposal_id: archive.id });
    expect((await board.readProject("demo")).archived).toMatchObject({ by: "user" });
  });

  it("gives a workspace left with work on no branch a closing turn at most three times", async () => {
    const { board } = await society();
    const topic = await board.openThread(ENG, { channel: "demo/dev", title: "which library?" });
    const record = (): Promise<boolean> =>
      board.recordLeftovers({
        agent: "eng-1",
        scope: "demo",
        conversation: { kind: "thread", id: topic.id },
      });
    expect([await record(), await record(), await record(), await record()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    // Another citizen's workspace in the same conversation counts on its own.
    expect(
      await board.recordLeftovers({
        agent: "rev-1",
        scope: "demo",
        conversation: { kind: "thread", id: topic.id },
      }),
    ).toBe(true);
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

  it("lets the user set a citizen's reasoning effort and clear it back to the model's default", async () => {
    const { board } = await society();
    const set = await board.setAgentEffort(USER, "eng-1", "xhigh");
    expect(set.effort).toBe("xhigh");
    expect((await board.listMembers()).find((m) => m.name === "eng-1")?.effort).toBe("xhigh");
    // The model stays as it was; each setting is its own.
    expect(set.model).toBeUndefined();
    const cleared = await board.setAgentEffort(USER, "eng-1", null);
    expect(cleared.effort).toBeUndefined();
    expect((await board.readAgent("eng-1")).effort).toBeUndefined();

    const events = (await board.readEvents(null)).filter((e) => e.type === "agent.configured");
    expect(events.map((e) => e.payload)).toEqual([
      { agent: "eng-1", effort: "xhigh", previous: null },
      { agent: "eng-1", effort: null, previous: "xhigh" },
    ]);

    await expect(
      board.setAgentEffort({ name: "stew", role: "steward" }, "eng-1", "high"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(board.setAgentEffort(USER, "eng-1", "very high")).rejects.toThrow(
      /one lowercase word/,
    );
    await expect(board.setAgentEffort(USER, "eng-1", "High")).rejects.toThrow(/one lowercase word/);
    await expect(board.setAgentEffort(USER, "user", "high")).rejects.toMatchObject({
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
    // Only the stage's holder or a planner sends the work back, as update_task's description says.
    await expect(board.updateTask(RES, { task_id: task.id, stage: "s2" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining(
        "only the holder of the current stage, the user, the steward, or the concierge",
      ),
    });
    expect(VERB_DESCRIPTIONS.update_task).toContain(
      "the current stage's holder, the user, the steward, or the concierge; anyone else asks the concierge",
    );
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

  it("records what blocks a task, never the task itself, with the blockers before and after", async () => {
    const { board } = await society();
    const first = await board.createTask(USER, { project: "demo", title: "first" });
    const second = await board.createTask(USER, { project: "demo", title: "second" });
    await expect(
      board.updateTask(USER, { task_id: second.id, blocked_by: [second.id] }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(
      (await board.updateTask(USER, { task_id: second.id, blocked_by: [first.id] })).blockedBy,
    ).toEqual([first.id]);
    await board.updateTask(USER, { task_id: second.id, blocked_by: [] });
    await board.updateTask(USER, { task_id: second.id, note: "no change to its blockers" });
    const updates = (await board.readEvents(null)).filter((event) => event.type === "task.updated");
    expect(
      updates.map((event) => [event.payload["blockedBy"], event.payload["previousBlockedBy"]]),
    ).toEqual([
      [[first.id], []],
      [[], [first.id]],
      [undefined, undefined],
    ]);
  });

  it("renames a project's display name and leaves its slug and completion effect alone", async () => {
    const { board } = await society();
    const before = await board.readProject("demo");
    const renamed = await board.configureProject(USER, { project: "demo", name: "  Demo work  " });
    expect(renamed).toMatchObject({ slug: "demo", name: "Demo work", onDone: before.onDone });
    expect((await board.readProject("demo")).name).toBe("Demo work");
    const configured = (await board.readEvents(null)).filter(
      (event) => event.type === "project.configured",
    );
    expect(configured.map((event) => event.payload)).toEqual([
      {
        slug: "demo",
        onDone: before.onDone,
        name: "Demo work",
        defaultBranch: before.defaultBranch,
        previousName: before.name,
      },
    ]);

    // Something must change, the name must say something, and the verb is the planners' alone.
    await expect(board.configureProject(USER, { project: "demo" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(board.configureProject(USER, { project: "demo", name: "   " })).rejects.toThrow(
      /expected string to have >=1 characters/,
    );
    await expect(
      board.configureProject(ENG, { project: "demo", name: "Mine" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("moves a project to another default branch, never into the board's own namespaces", async () => {
    const { board } = await society();
    const moved = await board.configureProject(USER, { project: "demo", default_branch: "trunk" });
    expect(moved).toMatchObject({ slug: "demo", defaultBranch: "trunk" });
    const configured = (await board.readEvents(null)).filter(
      (event) => event.type === "project.configured",
    );
    expect(configured.at(-1)?.payload).toMatchObject({
      defaultBranch: "trunk",
      previousDefaultBranch: "main",
    });
    for (const [refused, why] of [
      ["task/01M4D03FTQRBZ6JCCS1QNWDZ4Q", /the board's own branches/],
      ["agent/eng-1", /the board's own branches/],
      ["a..b", /not a branch name git takes/],
      ["x/", /not a branch name git takes/],
      ["y.lock", /not a branch name git takes/],
    ] as const) {
      await expect(
        board.configureProject(USER, { project: "demo", default_branch: refused }),
      ).rejects.toThrow(why);
    }
    expect((await board.readProject("demo")).defaultBranch).toBe("trunk");
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

  it.each(["approved", "rejected"] as const)(
    "refuses to decide a proposal whose thread is gone before writing anything (%s)",
    async (outcome) => {
      const { board } = await society();
      const decisions = async () => (await readdir(board.paths.decisions()).catch(() => [])).length;
      const proposal = await board.propose(ENG, {
        kind: "channel",
        charter: { project: "demo", name: "rel", purpose: "Releases." },
      });
      await rm(board.paths.threadFile(board.paths.threadsOf("governance"), proposal.id));
      const before = await decisions();
      const decided =
        outcome === "approved"
          ? board.approve(USER, { proposal_id: proposal.id })
          : board.reject(USER, { proposal_id: proposal.id, reason: "Not now." });
      await expect(decided).rejects.toMatchObject({
        code: "INVALID_STATE",
        message: `proposal ${proposal.id} has no open thread`,
      });
      expect((await board.readProposal(proposal.id)).status).toBe("proposed");
      expect(await decisions()).toBe(before);
      expect((await board.readProject("demo")).channels).not.toContain("rel");
    },
  );

  it("refuses a task's note whose thread is gone before the task moves", async () => {
    const { board } = await society();
    const task = await board.createTask(USER, { project: "demo", title: "ship it" });
    await board.claimTask(ENG, { task_id: task.id });
    await rm(board.paths.threadFile(board.paths.threadsOf("demo/general"), task.id));
    await expect(
      board.advanceTask(ENG, { task_id: task.id, note: "Shipped." }),
    ).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: `task ${task.id} has no open thread`,
    });
    expect((await board.listTasks("demo")).find((each) => each.id === task.id)).toMatchObject({
      status: "claimed",
      stage: "s1",
      claimedBy: "eng-1",
    });
  });

  it("opens threads on a channel and on a proposal, each reaching only its participants", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };
    const ids = async (actor: Actor): Promise<Ulid[]> =>
      (await board.readDigest(actor)).messages.map((m) => m.id);

    // A topic on a channel: the thread records its channel, and every message carries it.
    await expect(board.openThread(ENG, { channel: "demo/general", title: "" })).rejects.toThrow(
      /title/,
    );
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
    // How a codebase behaves goes in the repo's own documents; project knowledge is about the place.
    expect(await board.readAgentRoleBody("eng-2")).toContain(
      "about how this codebase behaves, it goes in the repo's AGENTS.md or README; about this project as a place",
    );
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
    // The notice is the board's, and leaves the reason, free text, out of a post nobody wrote.
    const notice = (await board.listChannel("general")).at(-1);
    expect(notice).toMatchObject({ author: "board" });
    expect(notice?.body.trim()).toBe(
      "Citizen eng-1 (engineer) is retired by user. Released 1 claimed task(s) back to open.",
    );
    expect((await board.readProposal(retirement.id)).provision).toMatchObject({
      agent: "eng-1",
      releasedTasks: [task.id],
    });
  });

  it("reallocates a role by proposal, and leaves its verbs and replicas to the user", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const DESK: Actor = { name: "desk", role: "concierge" };
    const STEW: Actor = { name: "stew", role: "steward" };
    const before = await board.readRole("engineer");
    const reallocate = (role: string, changes: Record<string, unknown>, description = "why") =>
      board.propose(DESK, { kind: "reallocation", charter: { role, changes, description } });

    // A change of something a reallocation may change, in a role that exists, never the user's.
    await expect(reallocate("engineer", {})).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(reallocate("engineer", { purpose: "Ships." })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(reallocate("nobody", { backlogThreshold: 5 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(reallocate("user", { backlogThreshold: 5 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      reallocate("engineer", { backlogThreshold: before.backlogThreshold }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // A threshold and wakes the steward may decide; everything else in the charter stays.
    const tune = await reallocate(
      "engineer",
      { backlogThreshold: 5, wakeTriggers: ["heartbeat", "user_post"] },
      "Engineers should hear the user.",
    );
    expect((await board.listThread(tune.id)).at(0)?.body).toContain(
      "reallocation of role engineer (backlog threshold 5, wakes on heartbeat, user_post): Engineers should hear the user.",
    );
    await board.approve(STEW, { proposal_id: tune.id });
    expect(await board.readRole("engineer")).toEqual({
      ...before,
      backlogThreshold: 5,
      wakeTriggers: ["heartbeat", "user_post"],
    });
    const tuned = await board.readProposal(tune.id);
    expect(tuned.status).toBe("provisioned");
    expect(tuned.provision).toEqual({
      role: "engineer",
      changed: [
        `backlogThreshold ${before.backlogThreshold} → 5`,
        "wakeTriggers heartbeat → heartbeat, user_post",
      ],
    });
    expect((await board.listThread(tune.id)).at(-1)?.body).toContain(
      `Provisioned: role engineer, changed backlogThreshold ${before.backlogThreshold} → 5`,
    );

    // Verbs are a tool grant and replicas are members the scheduler adds, so the user decides.
    const verbs = [...before.verbs.filter((verb) => verb !== "search"), "create_channel"];
    const grant = await reallocate("engineer", { maxReplicas: 3, verbs });
    await expect(board.approve(STEW, { proposal_id: grant.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await board.approve(USER, { proposal_id: grant.id });
    expect(await board.readRole("engineer")).toMatchObject({ maxReplicas: 3, verbs });
    expect((await board.readProposal(grant.id)).provision?.["changed"]).toEqual([
      `maxReplicas ${before.maxReplicas} → 3`,
      "verbs +create_channel −search",
    ]);
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
      () => board.writeKnowledge(USER, { project: "demo", topic: "notes", body: "x", revision: 0 }),
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
    await board.addRunner(USER, "pod");
    const runner = await board.markRunner("pod", { status: "connected", clis: ["claude"] });
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

    // Any citizen may be woken outside projects; inside one, only where it is a member.
    for (const agent of ["desk", "eng-1"]) {
      await expect(
        board.requestWake(USER, { agent, project: "society", reason: "dev" }),
      ).resolves.toMatchObject({ type: "wake.requested" });
    }
    await expect(
      board.requestWake(USER, { agent: "desk", project: "demo", reason: "dev" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // Turn tokens can be extended for a resident session and revoked when it closes.
    const token = board.issueTurnToken("desk", "concierge", 1_000);
    expect(board.extendTurnToken(token, 60_000)).toBe(true);
    clock = new Date(clock.getTime() + 30_000);
    expect(board.resolveToken(token)).toEqual(DESK);
    board.revokeTurnToken(token);
    expect(board.resolveToken(token)).toBeNull();
  });

  it("removes a knowledge topic for whoever may write it, and sets its text aside", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };
    await board.writeKnowledge(STEW, {
      project: null,
      topic: "old-norm",
      body: "A superseded rule.",
      revision: 0,
    });
    await board.writeKnowledge(ENG, {
      project: "demo",
      topic: "testing",
      body: "Run the tests.",
      revision: 0,
    });

    // Removing is curated as writing is; nothing removes a topic that is not there.
    await expect(
      board.removeKnowledge(ENG, { project: null, topic: "old-norm" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      board.removeKnowledge(STEW, { project: null, topic: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const removed = await board.removeKnowledge(STEW, { project: null, topic: "old-norm" });
    expect(removed).toMatchObject({ topic: "old-norm", project: null, removedBy: "stew" });
    expect(await board.listKnowledge(null)).toEqual([]);
    expect(await board.search(STEW, { query: "superseded" })).toEqual([]);
    expect((await board.listChannel("general")).at(-1)).toMatchObject({
      body: expect.stringContaining("Knowledge removed: old-norm"),
      notice: { kind: "knowledge", action: "removed", topic: "old-norm", project: null },
    });
    // The text waits outside the projection for a restore by hand.
    const aside = board.paths.removedKnowledge("society");
    const [kept] = await readdir(aside);
    expect(kept).toMatch(/^old-norm\..+\.md$/);
    expect(await readFile(path.join(aside, kept ?? ""), "utf8")).toContain("A superseded rule.");

    await board.removeKnowledge(ENG, { project: "demo", topic: "testing" });
    expect(await board.listKnowledge("demo")).toEqual([]);
    const events = (await board.readEvents(null)).filter((e) => e.type === "knowledge.removed");
    expect(events.map((e) => [e.actor, e.payload])).toEqual([
      ["stew", { topic: "old-norm", project: null }],
      ["eng-1", { topic: "testing", project: "demo" }],
    ]);
  });

  it("removes a society skill for the steward and the user alone, and sets its text aside", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };
    for (const name of ["uv-setup", "old-plan"]) {
      await homeSkill(board, "eng-1", name, `Steps for ${name}.\n`);
      const proposal = await board.propose(ENG, {
        kind: "skill",
        charter: { name, summary: `The ${name} procedure` },
      });
      await board.approve(STEW, { proposal_id: proposal.id });
    }
    const skillHits = async () =>
      (await board.search(REV, { query: "Steps for uv-setup" })).map((hit) => hit.ref);
    expect(await skillHits()).toContain("society/skills/uv-setup");

    // A work role lacks the verb, and a charter that grants it does not make a curator.
    await expect(
      board.removeSkill(ENG, { name: "uv-setup", reason: "Unused." }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await board.setRoleCharter(USER, {
      name: "reviewer",
      purpose: "Reviews.",
      verbs: [...MEMBER_VERBS, "remove_skill"],
    });
    await expect(
      board.removeSkill(REV, { name: "uv-setup", reason: "Unused." }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      board.removeSkill(STEW, { name: "missing", reason: "Unused." }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(board.removeSkill(STEW, { name: "uv-setup", reason: "  " })).rejects.toThrow(
      /too small/i,
    );

    const removed = await board.removeSkill(STEW, {
      name: "uv-setup",
      reason: "Superseded by @eng-1's uv-project.",
    });
    expect(removed).toMatchObject({
      name: "uv-setup",
      reason: "Superseded by @eng-1's uv-project.",
      removedBy: "stew",
    });
    expect((await board.listSocietySkills()).map((skill) => skill.name)).toEqual(["old-plan"]);
    expect(await skillHits()).not.toContain("society/skills/uv-setup");
    // The board's notice quotes the reason with its mentions as plain names, so it wakes nobody.
    expect((await board.listChannel("general")).at(-1)).toMatchObject({
      author: "board",
      body: expect.stringContaining(
        "Skill uv-setup removed from the society by stew: Superseded by eng-1's uv-project.",
      ),
      mentions: [],
    });
    // The text waits outside the projection for a restore by hand.
    const aside = board.paths.removedSkills();
    const [kept] = await readdir(aside);
    expect(kept).toMatch(/^uv-setup\..+$/);
    expect(await readFile(path.join(aside, kept ?? "", "SKILL.md"), "utf8")).toContain(
      "Steps for uv-setup.",
    );

    await board.removeSkill(USER, { name: "old-plan", reason: "No longer used" });
    expect(await board.listSocietySkills()).toEqual([]);
    const events = (await board.readEvents(null)).filter((e) => e.type === "skill.removed");
    expect(events.map((e) => [e.actor, e.payload])).toEqual([
      ["stew", { name: "uv-setup", reason: "Superseded by @eng-1's uv-project." }],
      ["user", { name: "old-plan", reason: "No longer used" }],
    ]);

    // A steward charter from before the verb gains it with the seed's other verbs on open.
    const steward = await board.readRole("steward");
    await board.setRoleCharter(USER, {
      ...steward,
      verbs: steward.verbs.filter((verb) => verb !== "remove_skill"),
    });
    expect((await (await Board.open(dir, { now })).readRole("steward")).verbs).toContain(
      "remove_skill",
    );
  });

  it("lands a ghpr task through the pull request linked to it, on its project's GitHub repository", async () => {
    const { board } = await society();
    // Pull requests are merged on GitHub, so a project without a remote there cannot take ghpr.
    await expect(board.addProject(USER, { slug: "nowhere", onDone: "ghpr" })).rejects.toMatchObject(
      { code: "VALIDATION" },
    );
    await expect(
      board.configureProject(USER, { project: "demo", on_done: "ghpr" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const local = await board.createTask(USER, { project: "demo", title: "Stays local" });
    await expect(
      board.planTask(USER, {
        task_id: local.id,
        stages: [{ id: "s1", name: "work" }],
        on_done: "ghpr",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await board.addProject(USER, { slug: "hub", repo: "git@github.com:Acme/Demo.git" });
    await board.joinProject(USER, { project: "hub", agent: "eng-1" });
    // The desk's verb: tasks filed from now on land through their pull requests.
    expect(await board.configureProject(USER, { project: "hub", on_done: "ghpr" })).toMatchObject({
      onDone: "ghpr",
    });
    const task = await board.createTask(USER, {
      project: "hub",
      title: "Ship it",
      stages: [{ name: "work", agent: "eng-1" }],
    });
    expect(task.onDone).toBe("ghpr");
    await board.claimTask(ENG, { task_id: task.id });

    // The last stage waits for a pull request, which must be on the project's own repository.
    await expect(board.advanceTask(ENG, { task_id: task.id })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expect(
      board.updateTask(ENG, {
        task_id: task.id,
        pull_request: { url: "https://github.com/acme/other/pull/3" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      board.updateTask(
        { name: "rev-1", role: "reviewer" },
        {
          task_id: task.id,
          pull_request: { url: "https://github.com/acme/demo/pull/17" },
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const linked = await board.updateTask(ENG, {
      task_id: task.id,
      pull_request: {
        url: "https://github.com/acme/demo/pull/17",
        merge_subject: "feat: ship it",
        merge_body: "Ships it.\n\nCo-Authored-By: eng-1 <eng-1@x>",
      },
    });
    expect(linked.pullRequest).toMatchObject({
      number: 17,
      subject: "feat: ship it",
      body: "Ships it.\n\nCo-Authored-By: eng-1 <eng-1@x>",
      linkedBy: "eng-1",
    });
    expect((await board.readEvents(null)).at(-1)?.payload).toMatchObject({
      pullRequest: "https://github.com/acme/demo/pull/17",
    });

    // Finished, it waits for the board to merge, and its pull request no longer changes.
    expect(await board.advanceTask(ENG, { task_id: task.id })).toMatchObject({ completing: true });
    await expect(
      board.updateTask(ENG, { task_id: task.id, pull_request: null }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    const done = await board.finishCompletion(SYSTEM_ACTOR, {
      taskId: task.id,
      ok: true,
      detail: "merged pull request #17 (https://github.com/acme/demo/pull/17) into main as abc1234",
    });
    expect(done.status).toBe("done");
    const thread = await board.listThread(task.id);
    expect(thread.at(-1)).toMatchObject({
      step: { action: "landed" },
      body: expect.stringContaining("merged pull request #17"),
    });
  });

  it("updates a project's dashboard for its members and the user, one revision at a time", async () => {
    const { board } = await society();
    const begun = await board.readDashboard("demo");
    expect(begun).toMatchObject({ project: "demo", revision: 0 });
    expect(begun.updatedBy).toBeUndefined();
    expect(begun.body).toContain("update_dashboard");

    // Only the project's members and the user; the steward holds the verb but joins no project.
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    await board.addAgent(USER, { name: "eng-9", role: "engineer", cli: "claude" });
    for (const outsider of [
      { name: "stew", role: "steward" },
      { name: "eng-9", role: "engineer" },
    ]) {
      await expect(
        board.updateDashboard(outsider, { project: "demo", body: "# Mine", revision: 0 }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }

    const first = await board.updateDashboard(ENG, {
      project: "demo",
      body: "# Demo\n\n| build | green |",
      revision: 0,
    });
    expect(first).toMatchObject({
      revision: 1,
      updatedBy: "eng-1",
      updatedAt: now().toISOString(),
    });

    // A writer that read revision 0 learns what changed since, text included, and writes nothing.
    const stale = await board
      .updateDashboard(
        { name: "rev-1", role: "reviewer" },
        {
          project: "demo",
          body: "# Demo\n\nReview pending.",
          revision: 0,
        },
      )
      .catch((error: unknown) => error);
    expect(stale).toMatchObject({ code: "INVALID_STATE" });
    expect(String(stale)).toContain("revision 1, updated by eng-1");
    expect(String(stale)).toContain("| build | green |");

    // The user is no member of demo, which it joined on its own record, and may still update it.
    expect((await board.readProject("demo")).members).not.toContain("user");
    await board.updateDashboard(USER, { project: "demo", body: "# Demo\n\nShipped.", revision: 1 });
    expect(await board.readDashboard("demo")).toMatchObject({
      revision: 2,
      updatedBy: "user",
      body: "# Demo\n\nShipped.\n",
    });
    expect(await readFile(board.paths.dashboard("demo"), "utf8")).toContain("revision: 2");
    const events = (await board.readEvents(null)).filter((e) => e.type === "dashboard.updated");
    expect(events.map((e) => [e.actor, e.payload])).toEqual([
      ["eng-1", { project: "demo", revision: 1 }],
      ["user", { project: "demo", revision: 2 }],
    ]);

    await board.archiveProject(USER, { project: "demo", reason: "done" });
    await expect(
      board.updateDashboard(USER, { project: "demo", body: "# Late", revision: 2 }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
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
      revision: 0,
    });
    expect(written).toMatchObject({ project: "demo", topic: "testing", updatedBy: "eng-1" });
    await expect(
      board.writeKnowledge(ENG, { project: null, topic: "norms", body: "x", revision: 0 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await board.addProject(USER, { slug: "other" });
    await expect(
      board.writeKnowledge(ENG, { project: "other", topic: "t", body: "x", revision: 0 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await board.writeKnowledge(STEW, {
      project: null,
      topic: "norms",
      body: "Summaries close threads. Silence is allowed.",
      revision: 0,
    });
    expect(await board.readSocietyNorms()).toContain("Silence is allowed");
    expect((await board.listKnowledge("demo")).map((k) => k.topic)).toEqual(["testing"]);
    expect((await board.listChannel("demo/general")).at(-1)).toMatchObject({
      author: "eng-1",
      body: expect.stringContaining("Knowledge written: testing"),
      notice: { kind: "knowledge", action: "written", topic: "testing", project: "demo" },
    });
    expect((await board.listChannel("general")).at(-1)?.notice).toEqual({
      kind: "knowledge",
      action: "written",
      topic: "norms",
      project: null,
    });
    await board.writeKnowledge(ENG, {
      project: "demo",
      topic: "testing",
      body: "Run `uv run pytest -q` (updated).",
      revision: 1,
    });
    expect((await board.listKnowledge("demo"))[0]?.body).toContain("(updated)");
    expect((await board.listChannel("demo/general")).at(-1)).toMatchObject({
      body: expect.stringContaining("Knowledge updated"),
      notice: { action: "updated", topic: "testing" },
    });

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
    await homeSkill(
      board,
      "eng-1",
      "uv-setup",
      "---\nname: uv-setup\ndescription: Set up a uv project with locked dependencies\n---\n# uv setup\n\nRun uv sync --locked before the tests.\n",
    );
    const proposal = await board.propose(ENG, {
      kind: "skill",
      charter: { name: "uv-setup", summary: "Set up a uv project with locked dependencies" },
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
    // The board announces it, so the decider's name on it wakes nobody as theirs.
    expect((await board.listChannel("general")).at(-1)).toMatchObject({
      author: "board",
      body: expect.stringContaining("Skill uv-setup promoted"),
    });

    // A reflection can be requested ahead of the cadence.
    const wake = await board.requestWake(USER, {
      agent: "eng-1",
      project: "demo",
      reason: "reflect now",
      kind: "reflection",
    });
    expect(wake.payload["kind"]).toBe("reflection");
  });

  it("takes a proposed skill's folder from its proposer's home when the turn that proposed it ends, and publishes it", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };
    let inFlight: TurnInFlight[] = [];
    board.watchTurns(() => inFlight);
    const home = board.paths.agent("eng-1");
    const skill = board.paths.agentSkill("eng-1", "uv-setup");
    // What a runner's push leaves in the home: the turn's files, committed.
    const commitHome = async (): Promise<void> => {
      await execa("git", ["add", "--all"], { cwd: home });
      await execa(
        "git",
        ["-c", "user.name=eng-1", "-c", "user.email=e@x", "commit", "-qm", "turn"],
        {
          cwd: home,
        },
      );
    };
    const write = async (file: string, text: string, mode = 0o644): Promise<void> => {
      await mkdir(path.dirname(path.join(skill, file)), { recursive: true });
      await writeFile(path.join(skill, file), text, { mode });
      await chmod(path.join(skill, file), mode);
    };
    const inTurn: Actor = { ...ENG, scope: "demo", thread: undefined };
    const turnEnd = { agent: "eng-1", project: "demo" };

    // Proposed from a turn whose files the board has not seen yet: nothing is taken until it ends,
    // and approval waits for that turn.
    await write(
      "SKILL.md",
      "---\nname: uv-setup\ndescription: Set up uv\n---\n# uv setup\n\nRun scripts/check.sh.\n",
    );
    await write("scripts/check.sh", "#!/bin/sh\nuv sync --locked\n", 0o755);
    await write("references/flags.md", "# Flags\n\n--locked\n");
    await write("SKILL.md.conflict-01J", "an edit to reconcile\n");
    const proposal = await board.propose(inTurn, {
      kind: "skill",
      charter: { name: "uv-setup", summary: "Set up a uv project" },
      rationale: "Every Python project here needs it.",
    });
    expect(proposal.skillFiles).toBeUndefined();
    inFlight = [{ agent: "eng-1", scope: "demo" }];
    await expect(board.approve(STEW, { proposal_id: proposal.id })).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("until eng-1's turn that proposed it ends"),
    });

    // The runner pushes the home before it reports, so the turn's end finds the folder there. A
    // turn in another conversation of the citizen's takes nothing.
    await commitHome();
    inFlight = [];
    await board.takeSkillFiles({ ...turnEnd, thread: ulid() });
    expect((await board.readProposal(proposal.id)).skillFiles).toBeUndefined();
    await board.takeSkillFiles(turnEnd);
    const taken = (await board.readProposal(proposal.id)).skillFiles;
    expect(taken?.files).toEqual([
      { path: "SKILL.md", size: expect.any(Number), executable: false },
      { path: "references/flags.md", size: 18, executable: false },
      { path: "scripts/check.sh", size: 27, executable: true },
    ]);
    expect(taken?.commit).toMatch(/^[0-9a-f]{40}$/);
    const events = (await board.readEvents(null)).map((event) => event.type);
    expect(events).toContain("proposal.files_taken");
    // Deciders read it in the projection, and the interface through the board.
    const staged = path.join(board.paths.board, "society", "proposals", proposal.id);
    expect((await stat(path.join(staged, "scripts", "check.sh"))).mode & 0o777).toBe(0o755);
    expect(await board.readSkillFiles(proposal.id)).toContainEqual({
      path: "references/flags.md",
      size: 18,
      executable: false,
      text: "# Flags\n\n--locked\n",
      truncated: false,
    });
    // What the citizen changes after is not what was reviewed, and does not reach approval.
    await write("scripts/check.sh", "#!/bin/sh\nrm -rf /\n", 0o755);
    await commitHome();

    await board.approve(STEW, { proposal_id: proposal.id });
    const published = board.paths.societySkill("uv-setup");
    expect(await readFile(path.join(published, "scripts", "check.sh"), "utf8")).toBe(
      "#!/bin/sh\nuv sync --locked\n",
    );
    expect((await stat(path.join(published, "scripts", "check.sh"))).mode & 0o777).toBe(0o755);
    expect(await readFile(path.join(published, "references", "flags.md"), "utf8")).toContain(
      "--locked",
    );
    expect(await readdir(published)).toEqual(["SKILL.md", "references", "scripts"]);
    const manual = await readFile(board.paths.societySkillFile("uv-setup"), "utf8");
    expect(manual).toContain("description: Set up a uv project");
    expect(manual).toContain(`commit: ${taken?.commit}`);
    expect(manual).toContain("# uv setup\n\nRun scripts/check.sh.");
    expect((await board.listSocietySkills()).map((s) => [s.name, s.summary])).toEqual([
      ["uv-setup", "Set up a uv project"],
    ]);
    // The skill's view reads the folder as it is published, frontmatter and all.
    const files = await board.readSocietySkillFiles("uv-setup");
    expect(files.map((file) => [file.path, file.executable])).toEqual([
      ["SKILL.md", false],
      ["references/flags.md", false],
      ["scripts/check.sh", true],
    ]);
    expect(files[0]?.text).toContain("description: Set up a uv project");
    expect(files[2]?.text).toBe("#!/bin/sh\nuv sync --locked\n");
    await expect(board.readSocietySkillFiles("uv-project")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "the society has no skill uv-project",
    });
    await expect(board.readSocietySkillFiles("../uv-setup")).rejects.toThrow(
      "expected 1-32 lowercase letters",
    );

    // A replacement is the whole skill: a file the new version dropped goes with the old one.
    await rm(path.join(skill, "references"), { recursive: true });
    await commitHome();
    const again = await board.propose(inTurn, {
      kind: "skill",
      charter: { name: "uv-setup", summary: "Set up a uv project, checked" },
      rationale: "The references moved into the steps.",
    });
    await board.takeSkillFiles(turnEnd);
    await board.approve(STEW, { proposal_id: again.id });
    expect(await readdir(published)).toEqual(["SKILL.md", "scripts"]);

    // A folder the home does not hold when the turn ends is the board's to reject, with the reason,
    // which wakes the proposer.
    const missing = await board.propose(inTurn, {
      kind: "skill",
      charter: { name: "never-written", summary: "Something @rev-1 would use" },
      rationale: "x",
    });
    await board.takeSkillFiles(turnEnd);
    expect(await board.readProposal(missing.id)).toMatchObject({
      status: "rejected",
      decidedBy: "board",
      reason: expect.stringContaining("no skills/never-written/SKILL.md in eng-1's home"),
    });
    const decided = (await board.readEvents(null)).findLast((e) => e.type === "proposal.decided");
    expect(decided).toMatchObject({ actor: "board", payload: { proposedBy: "eng-1" } });
    // The board quotes the summary, whose mention would otherwise wake rev-1 as the board's.
    expect((await board.listThread(missing.id)).at(-1)).toMatchObject({
      author: "board",
      body: expect.stringContaining("Something rev-1 would use"),
      mentions: [],
    });

    // Outside a turn there is nothing more to wait for: the folder is taken at once, or refused.
    await expect(
      board.propose(ENG, {
        kind: "skill",
        charter: { name: "never-written", summary: "Something" },
        rationale: "x",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("no skills/") });
    const direct = await board.propose(ENG, {
      kind: "skill",
      charter: { name: "uv-setup", summary: "Set up a uv project" },
      rationale: "x",
    });
    expect(direct.skillFiles?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/check.sh",
    ]);
  });

  it("finds messages by id wherever they were posted, and leaves out ids that name none", async () => {
    const { board } = await society();
    const inProject = await board.postMessage(ENG, { channel: "demo/general", body: "plan" });
    const inSociety = await board.postMessage(USER, { channel: "general", body: "hello" });
    const topic = await board.openThread(ENG, { channel: "demo/dev", title: "which library?" });
    const inThread = await board.postMessage(REV, { thread_id: topic.id, body: "zod" });
    const found = await board.findMessages([inThread.id, ulid(), inSociety.id, inProject.id]);
    expect(found.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: inProject.id, author: "eng-1", channel: "demo/general", ts: inProject.ts },
      { id: inSociety.id, author: "user", channel: "general", ts: inSociety.ts },
      { id: inThread.id, author: "rev-1", channel: "demo/dev", thread: topic.id, ts: inThread.ts },
    ]);
    expect(await board.findMessages([ulid()])).toEqual([]);
  });

  it("counts a mention only outside code, which is where the interface shows it as one", async () => {
    const { board } = await society();
    const cases: [string, string, string[]][] = [
      ["a code span", "Run `@eng-1 --fix` first.", []],
      ["a double-backtick span", "Write ``a ` and @eng-1`` as one span.", []],
      ["a backtick fence", "```ts\n// @eng-1\n```", []],
      ["a tilde fence", "~~~\n@eng-1\n~~~", []],
      ["an indented block", "Run:\n\n    npx @eng-1/cli\n\nthen stop.", []],
      ["a lone backtick", "A lone ` opens no span, @eng-1.", ["eng-1"]],
      ["an unclosed fence", "Log:\n\n```\n@eng-1\n\nstill code, @rev-1", []],
      ["right next to a code span", "`npm test`@eng-1, then @rev-1`x`", ["eng-1", "rev-1"]],
      ["in code and in text", "`@eng-1` means you, @eng-1.", ["eng-1"]],
      [
        "prose around code",
        "# @eng-1\n\n- `x` @rev-1\n\n> **@ops-1** and *@qa-1*",
        ["eng-1", "ops-1", "qa-1", "rev-1"],
      ],
      ["a fence in a quote", "> ```\n> @eng-1\n> ```\n\n@rev-1", ["rev-1"]],
      ["an indented line in a paragraph", "Not code:\n    @eng-1", ["eng-1"]],
      [
        "a link and HTML, as before",
        "[@eng-1](https://x.y/@rev-1) <!-- @ops-1 --> <b>@qa-1</b>",
        ["eng-1", "ops-1", "qa-1", "rev-1"],
      ],
      ["a leading byte order mark", "\uFEFF@eng-10`npm test` please", ["eng-10"]],
      // Thousands of list items nested on one line take micromark seconds to parse.
      ["a post too slow to parse", `${"- ".repeat(4096)}\`@eng-1\` @rev-1`, ["eng-1", "rev-1"]],
    ];
    for (const [what, body, mentions] of cases) {
      const message = await board.postMessage(ENG, { channel: "demo/general", body });
      expect.soft(message.mentions, what).toEqual(mentions);
    }
    // The scheduler wakes whoever the posting event names.
    const posted = (await board.readEvents(null)).filter((e) => e.type === "message.posted");
    expect(posted.slice(-cases.length).map((e) => e.payload["mentions"])).toEqual(
      cases.map(([, , mentions]) => mentions),
    );
  });

  it("takes a skill from its proposer's home alone, never from text in its charter", async () => {
    const { board } = await society();
    await expect(
      board.propose(ENG, {
        kind: "skill",
        charter: { name: "texted", summary: "Something", body: "# Texted\n\nSteps.\n" },
        rationale: "x",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("no skills/texted/SKILL.md in eng-1's home"),
    });
  });

  it("refuses to approve a skill whose folder its proposer's home does not give", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };
    const inTurn: Actor = { ...ENG, scope: "demo" };
    const proposal = await board.propose(inTurn, {
      kind: "skill",
      charter: { name: "broken", summary: "Something" },
      rationale: "x",
    });
    // The turn's end was never recorded, as across a restart, and the home never got the folder.
    await expect(board.approve(STEW, { proposal_id: proposal.id })).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("no skills/broken/SKILL.md in eng-1's home; reject it"),
    });
    // A SKILL.md whose frontmatter does not parse would publish a broken skill.
    const skill = board.paths.agentSkill("eng-1", "broken");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "---\ndescription: a: b\n---\nSteps\n", "utf8");
    const home = board.paths.agent("eng-1");
    await execa("git", ["add", "--all"], { cwd: home });
    await execa("git", ["-c", "user.name=e", "-c", "user.email=e@x", "commit", "-qm", "turn"], {
      cwd: home,
    });
    await expect(board.approve(STEW, { proposal_id: proposal.id })).rejects.toMatchObject({
      message: expect.stringContaining("the frontmatter of skills/broken/SKILL.md"),
    });
    await board.reject(STEW, { proposal_id: proposal.id, reason: "fix its frontmatter" });
    expect((await board.readProposal(proposal.id)).status).toBe("rejected");
  });

  it("writes knowledge one revision at a time, and refuses a stale write with the current text", async () => {
    const { board } = await society();
    const first = await board.writeKnowledge(ENG, {
      project: "demo",
      topic: "testing",
      body: "Run the tests with uv.",
      revision: 0,
    });
    expect(first).toMatchObject({ revision: 1, updatedBy: "eng-1" });
    expect(await readFile(board.paths.projectKnowledgeFile("demo", "testing"), "utf8")).toContain(
      "revision: 1",
    );

    // A writer that took the topic for new learns it was written since, text included, and writes nothing.
    const stale = await board
      .writeKnowledge(REV, { project: "demo", topic: "testing", body: "Run nothing.", revision: 0 })
      .catch((error: unknown) => error);
    expect(stale).toMatchObject({ code: "INVALID_STATE" });
    expect(String(stale)).toContain("revision 1, updated by eng-1");
    expect(String(stale)).toContain("Run the tests with uv.");
    expect((await board.listKnowledge("demo"))[0]?.body).toBe("Run the tests with uv.\n");

    await board.writeKnowledge(REV, {
      project: "demo",
      topic: "testing",
      body: "Run the tests twice.",
      revision: 1,
    });
    expect((await board.listKnowledge("demo"))[0]).toMatchObject({
      revision: 2,
      updatedBy: "rev-1",
    });
    const events = (await board.readEvents(null)).filter((e) => e.type === "knowledge.written");
    expect(events.map((e) => [e.actor, e.payload])).toEqual([
      ["eng-1", { topic: "testing", project: "demo", replaced: false, revision: 1 }],
      ["rev-1", { topic: "testing", project: "demo", replaced: true, revision: 2 }],
    ]);

    // A removed topic has no revision to write over; written anew, it goes on from where it was
    // removed, so a write that read the removed text cannot replace the new one.
    await board.removeKnowledge(ENG, { project: "demo", topic: "testing" });
    const gone = await board
      .writeKnowledge(REV, { project: "demo", topic: "testing", body: "Back.", revision: 2 })
      .catch((error: unknown) => error);
    expect(gone).toMatchObject({ code: "INVALID_STATE" });
    expect(String(gone)).toContain("demo has no knowledge topic testing");
    await board.writeKnowledge(ENG, {
      project: "demo",
      topic: "testing",
      body: "Back.",
      revision: 0,
    });
    expect((await board.listKnowledge("demo"))[0]).toMatchObject({ revision: 3, body: "Back.\n" });
    await expect(
      board.writeKnowledge(REV, { project: "demo", topic: "testing", body: "Old.", revision: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    // A topic written before revisions reads as revision 0 and keeps its author.
    await mkdir(board.paths.societyKnowledge(), { recursive: true });
    await writeFile(
      board.paths.societyKnowledgeFile("norms"),
      "---\ntopic: norms\nproject: null\nupdatedBy: user\nupdatedAt: '2026-09-30T05:19:26.611Z'\n---\nBe brief.\n",
    );
    expect(await board.listKnowledge(null)).toEqual([
      {
        topic: "norms",
        project: null,
        revision: 0,
        updatedBy: "user",
        updatedAt: "2026-09-30T05:19:26.611Z",
        body: "Be brief.\n",
      },
    ]);
    await expect(
      board.writeKnowledge(USER, { project: null, topic: "norms", body: "Briefer.", revision: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    const norms = await board.writeKnowledge(USER, {
      project: null,
      topic: "norms",
      body: "Briefer.",
      revision: 0,
    });
    expect(norms).toMatchObject({ revision: 1, updatedBy: "user" });
  });

  it("reads a skill's index line from its description, else from its body, never from another key", async () => {
    const { board } = await society();
    await mkdir(board.paths.agentSkill("eng-1", "old-keys"), { recursive: true });
    await writeFile(
      board.paths.agentSkillFile("eng-1", "old-keys"),
      "---\nname: old-keys\nsummary: Not an index line\n---\n# Old keys\n\nRead the body.\n",
      "utf8",
    );
    expect((await board.listAgentSkills("eng-1")).map((s) => [s.name, s.summary])).toEqual([
      ["old-keys", "Read the body."],
    ]);
  });

  it("reads a citizen's skills, profile, and memory whose frontmatter does not parse", async () => {
    const { board } = await society();
    // A colon in an unquoted value, as a live front desk wrote it in a reflection.
    const broken =
      "---\nname: staff-new-area\ndescription: Staff a new project: check roles first\n---\n";
    await mkdir(board.paths.agentSkill("eng-1", "staff-new-area"), { recursive: true });
    await writeFile(
      board.paths.agentSkillFile("eng-1", "staff-new-area"),
      `${broken}\n# Staffing\n\nPropose the role, then the member.\n`,
      "utf8",
    );
    await writeFile(
      board.paths.agentProfile("eng-1"),
      `${broken}\n# Profile\n\nI build.\n`,
      "utf8",
    );
    await writeFile(
      board.paths.agentMemoryCore("eng-1"),
      `${broken}\n# Core\n\nKeep it short.\n`,
      "utf8",
    );

    // Every read says so, not only the first: gray-matter's cache once turned the second into empty frontmatter.
    for (let read = 0; read < 2; read += 1) {
      expect(await board.listAgentSkills("eng-1")).toMatchObject([
        {
          name: "staff-new-area",
          summary: expect.stringMatching(
            /^its frontmatter does not parse \(.+\), so fix the file$/,
          ),
        },
      ]);
    }
    expect(await board.readMemoryCore("eng-1")).toContain("description: Staff a new project");
    expect(await board.readMemoryCore("eng-1")).toContain("Keep it short.");

    // The roster is rebuilt at a turn's end, which an unreadable skill once failed halfway.
    const turn = turnIn(undefined, "2026-09-28T10:05:00.000Z");
    await board.beginTurn(turn);
    await board.finishTurn({
      ...turn,
      endedAt: "2026-09-28T10:06:00.000Z",
      exitReason: "completed",
    });
    const member = (await board.listMembers()).find((m) => m.name === "eng-1");
    expect(member?.skills).toEqual(["staff-new-area"]);
    expect(member?.profile).toContain("I build.");
    expect((await board.readEvents(null)).at(-1)?.type).toBe("turn.completed");
  });

  it("opens a channel for a workstream, files its tasks there, and archives it once they are done", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };

    // The planners open channels; a work role proposes one instead.
    await expect(
      board.createChannel(ENG, { project: "demo", name: "release-1", purpose: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ref = await board.createChannel(STEW, {
      project: "demo",
      name: "release-1",
      purpose: "Release 0.1.0, which @eng-1 cuts",
    });
    expect(ref).toBe("demo/release-1");
    await expect(
      board.createChannel(USER, { project: "demo", name: "release-1", purpose: "again" }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    // Its opener follows it, and nobody else until they choose to: the board announces it in the
    // project's general, writing the purpose's mentions as plain names, so the notice wakes nobody.
    expect((await board.readAgent("stew")).subscriptions).toContain(ref);
    for (const name of ["eng-1", "rev-1"]) {
      expect((await board.readAgent(name)).subscriptions).not.toContain(ref);
    }
    expect((await board.listChannel("demo/general")).at(-1)).toMatchObject({
      author: "board",
      body: "Channel demo/release-1 opened by stew: Release 0.1.0, which eng-1 cuts. Subscribe to it to follow its posts; its tasks and mentions reach whoever they concern either way.\n",
      mentions: [],
    });
    expect((await board.listChannel(ref)).at(0)).toMatchObject({ mentions: [] });
    await board.subscribe(ENG, { channel: ref });
    await board.subscribe(REV, { channel: ref });

    // A task filed there hangs its thread there; a channel that does not exist takes none.
    const task = await board.createTask(USER, {
      project: "demo",
      title: "cut the release",
      channel: "release-1",
    });
    expect(task.channel).toBe("release-1");
    expect((await board.readThread(task.id)).channel).toBe(ref);
    expect((await board.createTask(USER, { project: "demo", title: "elsewhere" })).channel).toBe(
      "general",
    );
    await expect(
      board.createTask(USER, { project: "demo", title: "lost", channel: "release-9" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const topic = await board.openThread(REV, { channel: ref, title: "changelog wording" });

    // Archiving waits for its tasks, and never takes a channel the board itself uses.
    await expect(
      board.archiveChannel(USER, { channel: ref, reason: "shipped" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(
      board.archiveChannel(USER, { channel: "demo/general", reason: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      board.archiveChannel(USER, { channel: "governance", reason: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await board.updateTask(USER, { task_id: task.id, status: "abandoned" });
    const archived = await board.archiveChannel(STEW, { channel: ref, reason: "0.1.0 shipped" });
    expect(archived).toMatchObject({ name: "release-1", by: "stew", reason: "0.1.0 shipped" });

    // Its threads close, nobody follows it, and it takes nothing new, while its history reads.
    expect((await board.readThread(topic.id)).state).toBe("closed");
    for (const name of ["eng-1", "rev-1"]) {
      expect((await board.readAgent(name)).subscriptions).not.toContain(ref);
    }
    expect((await board.listChannels()).find((each) => each.ref === ref)).toMatchObject({
      archived: { reason: "0.1.0 shipped" },
    });
    expect((await board.listChannel(ref)).at(0)?.body).toContain("Channel demo/release-1 opened");
    await expect(board.postMessage(ENG, { channel: ref, body: "late" })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expect(
      board.createTask(USER, { project: "demo", title: "late", channel: "release-1" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(board.subscribe(ENG, { channel: ref })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expect(
      board.createChannel(USER, { project: "demo", name: "release-1", purpose: "reuse" }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    expect((await board.listChannel("demo/general")).at(-1)).toMatchObject({
      author: "board",
      body: expect.stringContaining("Channel demo/release-1 is archived by stew"),
    });
    const events = await board.readEvents(null);
    expect(events.find((event) => event.type === "channel.archived")?.payload).toMatchObject({
      channel: ref,
      threadsClosed: [topic.id],
      unsubscribed: ["eng-1", "rev-1", "stew"],
    });

    // A newcomer follows general, and joining names the project's other open channels, never the
    // archived one; a society channel is announced in the society's general.
    await board.createChannel(USER, { project: "demo", name: "release-2", purpose: "0.2.0" });
    await board.addProject(USER, { slug: "other" });
    const { agent } = await board.addAgent(USER, {
      name: "eng-2",
      role: "engineer",
      cli: "claude",
      memberships: ["other"],
    });
    expect(agent.subscriptions).not.toContain("demo/dev");
    expect((await board.readAgent("user")).subscriptions).not.toContain("demo/release-2");
    const joined = await board.joinProject(USER, { project: "demo", agent: "eng-2" });
    expect(joined.subscriptions).toContain("demo/general");
    expect(joined.otherChannels).toEqual(["demo/dev", "demo/release-2"]);

    // A channel a proposal asked for is followed by its proposer once approved.
    const proposal = await board.propose(ENG, {
      kind: "channel",
      charter: { project: "demo", name: "perf", purpose: "Performance work" },
      rationale: "Benchmarks need a place.",
    });
    await board.approve(STEW, { proposal_id: proposal.id });
    expect((await board.readAgent("eng-1")).subscriptions).toContain("demo/perf");
    expect((await board.readAgent("stew")).subscriptions).not.toContain("demo/perf");
    expect(await board.createChannel(USER, { name: "releases", purpose: "All releases" })).toBe(
      "releases",
    );
    expect((await board.listChannel("general")).at(-1)?.body).toContain(
      "Channel releases opened by user: All releases.",
    );
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
    expect(path.isAbsolute(board.paths.agent("eng-1"))).toBe(true);
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

  it("lets a citizen set a cron for itself where its turn is, and only planners one for another", async () => {
    const { board } = await society();
    // Set from a turn in demo's dev channel, a cron fires in that conversation.
    const own = await board.createCron(
      { ...ENG, scope: "demo", channel: "dev" },
      { title: "Check the deploy", note: "Read the deploy log.", cron: "*/30 * * * *" },
    );
    expect(own).toMatchObject({
      agent: "eng-1",
      scope: "demo",
      channel: "dev",
      schedule: { cron: "*/30 * * * *" },
      createdBy: "eng-1",
      since: "2026-09-28T10:00:00.000Z",
      failures: 0,
      note: "Read the deploy log.",
    });
    // Outside any turn, a cron fires at home outside projects.
    expect(
      (await board.createCron(ENG, { title: "Daily", note: "Summarize.", cron: "0 9 * * *" }))
        .scope,
    ).toBe("society");
    await expect(
      board.createCron(ENG, { title: "x", note: "x", cron: "0 9 * * *", agent: "rev-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(board.updateCron(REV, { cron_id: own.id, paused: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // The user takes no turns, so it names the citizen; a planner may wake anyone.
    await expect(
      board.createCron(USER, { title: "x", note: "x", cron: "0 9 * * *" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    const thread = await board.openThread(ENG, { channel: "demo/general", title: "Release" });
    const forRev = await board.createCron(USER, {
      title: "Weekly",
      note: "Review the week.",
      cron: "0 9 * * 1",
      timezone: "asia/shanghai",
      agent: "rev-1",
      thread_id: thread.id,
    });
    expect(forRev).toMatchObject({
      agent: "rev-1",
      scope: "demo",
      thread: thread.id,
      schedule: { cron: "0 9 * * 1", timezone: "Asia/Shanghai" },
    });
    expect((await board.listCrons()).map((cron) => cron.id)).toHaveLength(3);
    expect(
      (await board.readEvents(null)).filter((event) => event.type === "cron.created"),
    ).toHaveLength(3);
  });

  it("refuses a cron that fires too often, never, in the past, or with two schedules", async () => {
    const { board } = await society();
    const set = (input: Record<string, string>) =>
      board.createCron(ENG, { title: "t", note: "n", ...input });
    await expect(set({ cron: "*/5 * * * *" })).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("at most every 15 minutes"),
    });
    await expect(set({ cron: "0,10 9 * * *" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(set({ cron: "0 0 31 2 *" })).rejects.toMatchObject({
      message: expect.stringContaining("no time to come"),
    });
    await expect(set({ cron: "61 * * * *" })).rejects.toThrow(/five-field cron expression/);
    await expect(set({ cron: "0 9 * * *", timezone: "Mars/Olympus" })).rejects.toThrow(
      /not a time zone/,
    );
    await expect(set({ at: "2026-09-28T09:00:00Z" })).rejects.toMatchObject({
      message: expect.stringContaining("has passed"),
    });
    await expect(set({})).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(set({ cron: "0 9 * * *", at: "2026-09-29T09:00:00Z" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(set({ cron: "*/15 * * * *" })).resolves.toMatchObject({ scope: "society" });
    await expect(set({ at: "2026-09-28T10:05:00+02:00" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(set({ at: "2026-09-28T12:05:00+02:00" })).resolves.toMatchObject({
      schedule: { at: "2026-09-28T10:05:00.000Z" },
    });
  });

  it("pauses, resumes afresh, reschedules, and ends a cron, recording how its turns end", async () => {
    const { board } = await society();
    const cron = await board.createCron(
      { ...ENG, scope: "demo" },
      { title: "Hourly", note: "Check.", cron: "0 * * * *" },
    );
    clock = new Date("2026-09-28T11:00:00.000Z");
    expect((await board.updateCron(ENG, { cron_id: cron.id, paused: true })).paused).toEqual({
      at: "2026-09-28T11:00:00.000Z",
      by: "eng-1",
    });
    clock = new Date("2026-09-28T13:30:00.000Z");
    const resumed = await board.updateCron(ENG, { cron_id: cron.id, paused: false });
    expect(resumed.paused).toBeUndefined();
    expect(resumed.since).toBe("2026-09-28T13:30:00.000Z");
    const zoned = await board.updateCron(ENG, { cron_id: cron.id, timezone: "Europe/Berlin" });
    expect(zoned.schedule).toEqual({ cron: "0 * * * *", timezone: "Europe/Berlin" });
    await expect(board.updateCron(ENG, { cron_id: cron.id })).rejects.toMatchObject({
      code: "VALIDATION",
    });

    // Each turn a fire started records how it ended; failures count until one completes.
    await board.cronFired(cron.id, "2026-09-28T14:00:00.000Z");
    const run = async (exitReason: "completed" | "error" | "stopped") => {
      const turn = await board.beginTurn({
        ...turnIn(undefined, clock.toISOString()),
        crons: [cron.id],
      });
      await board.finishTurn({ ...turn, endedAt: clock.toISOString(), exitReason });
      return board.readCron(cron.id);
    };
    expect((await run("error")).failures).toBe(1);
    expect(await run("stopped")).toMatchObject({ failures: 1, lastRun: { outcome: "stopped" } });
    expect((await run("error")).failures).toBe(2);
    expect(await run("completed")).toMatchObject({
      failures: 0,
      lastRun: { outcome: "completed" },
      lastFiredAt: "2026-09-28T14:00:00.000Z",
    });

    const removed = await board.removeCron(USER, { cron_id: cron.id, reason: "done" });
    expect(removed.ended).toEqual({ at: "2026-09-28T13:30:00.000Z", by: "user", reason: "done" });
    await expect(board.updateCron(ENG, { cron_id: cron.id, paused: true })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });

    // A one-time cron ends once it fires.
    const once = await board.createCron(ENG, {
      title: "Once",
      note: "Look again.",
      at: "2026-09-28T15:00:00Z",
    });
    const fired = await board.cronFired(once.id, "2026-09-28T15:00:00.000Z");
    expect(fired?.ended).toMatchObject({ by: "board", reason: "fired once, as set" });
    // An ended cron does not fire again, though the scheduler read it before it ended.
    expect(await board.cronFired(once.id, "2026-09-28T15:00:01.000Z")).toBeNull();
  });

  it("ends a cron with the conversation it fires in", async () => {
    const { board } = await society();
    const topic = await board.openThread(ENG, { channel: "demo/general", title: "Topic" });
    const task = await board.createTask(USER, { project: "demo", title: "Build" });
    const set = (title: string, where: Record<string, string>, as: Actor = ENG) =>
      board.createCron(as, { title, note: "n", cron: "0 9 * * *", ...where });
    const inTopic = await set("topic", { thread_id: topic.id });
    const inTask = await set("task", { thread_id: task.id });
    const inChannel = await set("channel", { project: "demo", channel: "dev" });
    const atHome = await set("home", { project: "demo" });
    const revHome = await set("rev", { project: "demo" }, REV);
    const outside = await set("outside", { project: "society" });

    await board.closeThread(ENG, { thread_id: topic.id, summary: "Settled." });
    await board.updateTask(USER, { task_id: task.id, status: "abandoned" });
    await board.archiveChannel(USER, { channel: "demo/dev", reason: "shipped" });
    await board.leaveProject(USER, { project: "demo", agent: "eng-1" });
    await board.retireAgent(USER, { name: "rev-1", reason: "done" });
    const ended = new Map(
      (await board.listCrons()).map((cron) => [cron.id, cron.ended?.reason ?? null]),
    );
    expect(ended.get(inTopic.id)).toBe("its thread closed");
    expect(ended.get(inTask.id)).toBe("its thread closed: its task was abandoned");
    expect(ended.get(inChannel.id)).toBe("demo/dev was archived");
    expect(ended.get(atHome.id)).toBe("eng-1 left demo");
    expect(ended.get(revHome.id)).toBe("rev-1 was retired");
    expect(ended.get(outside.id)).toBeNull();
  });

  it("sets the society's time zone, the user's alone", async () => {
    const { board } = await society();
    expect((await board.society()).timezone).toBe("UTC");
    await expect(board.setTimezone(ENG, "Asia/Shanghai")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(board.setTimezone(USER, "Nowhere/City")).rejects.toThrow(/not a time zone/);
    expect((await board.setTimezone(USER, "asia/shanghai")).timezone).toBe("Asia/Shanghai");
    await expect((await Board.open(dir, { now })).society()).resolves.toMatchObject({
      timezone: "Asia/Shanghai",
      channels: ["general", "governance", "asks"],
    });
  });

  it("keeps an image a turn uploads outside the projection, checked again whatever its runner said", async () => {
    const { board } = await society();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const turn: Actor = { ...ENG, scope: "demo", thread: "01M4WY483E0XG4Q2ZTHAX3JBZV" };
    const upload = { path: "/tmp/shots/the board [before].png" };
    // Nothing reads files on a board without runners, and only a turn says where to read them.
    await expect(board.uploadImage(turn, upload)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const asked: Array<{ actor: Actor; file: string }> = [];
    let bytes: Uint8Array = png;
    board.readImagesWith((actor, file) => {
      asked.push({ actor, file });
      return Promise.resolve(bytes);
    });
    await expect(board.uploadImage(ENG, upload)).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("only a turn can call it"),
    });
    await expect(board.uploadImage(turn, { path: "/tmp/shots/board\0.png" })).rejects.toThrow(
      "a path with no NUL character",
    );
    await expect(board.uploadImage(USER, upload)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(asked).toEqual([]);

    const uploaded = await board.uploadImage(turn, upload);
    expect(asked).toEqual([{ actor: turn, file: upload.path }]);
    expect(uploaded).toEqual({
      id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      type: "png",
      size: png.length,
      markdown: `![the board before.png](image:${uploaded.id})`,
    });
    expect(await board.readImage(uploaded.id)).toEqual({ type: "png", bytes: png });
    // Beside the event log, never in the projection every runner mirrors.
    expect(await readdir(path.join(dir, "images"))).toEqual([uploaded.id]);
    expect(
      Object.keys(await board.boardManifest()).filter((file) => file.includes(uploaded.id)),
    ).toEqual([]);
    const event = (await board.readEvents(null)).find((each) => each.type === "image.uploaded");
    expect(event).toMatchObject({
      actor: "eng-1",
      payload: { id: uploaded.id, type: "png", size: png.length },
    });

    // The board takes no runner's word for what an image is.
    bytes = Buffer.from("<svg><script>alert(1)</script></svg>");
    await expect(board.uploadImage(turn, upload)).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("is not a PNG, JPEG, GIF, or WebP image"),
    });
    bytes = Buffer.concat([png, Buffer.alloc(IMAGE_LIMIT_BYTES - png.length + 1)]);
    await expect(board.uploadImage(turn, upload)).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining(`is ${IMAGE_LIMIT_BYTES + 1} bytes, over the 8388608`),
    });
    bytes = bytes.subarray(0, IMAGE_LIMIT_BYTES);
    const largest = await board.uploadImage(turn, upload);
    expect((await board.readImage(largest.id)).bytes).toHaveLength(IMAGE_LIMIT_BYTES);
    // A runner's refusal reaches the citizen as it was given.
    board.readImagesWith(() =>
      Promise.reject(new BoardError("FORBIDDEN", "/etc/passwd is outside your worktree")),
    );
    await expect(board.uploadImage(turn, { path: "/etc/passwd" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "/etc/passwd is outside your worktree",
    });
    expect((await readdir(path.join(dir, "images"))).toSorted()).toEqual([uploaded.id, largest.id]);

    await expect(board.readImage("01M4WY483E0XG4Q2ZTHAX3JBZW")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // A file in the images folder that is no image, as one put there by hand, is not served.
    await writeFile(path.join(dir, "images", "01M4WY483E0XG4Q2ZTHAX3JBZW"), "<svg/>");
    await expect(board.readImage("01M4WY483E0XG4Q2ZTHAX3JBZW")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "image 01M4WY483E0XG4Q2ZTHAX3JBZW is not an image the board shows",
    });
    board.readImagesWith(() => Promise.resolve(png));
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: ["post_message"],
    });
    await expect(board.uploadImage(turn, upload)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "role engineer may not upload_image",
    });
  });
});
