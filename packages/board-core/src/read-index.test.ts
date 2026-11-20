import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MEMBER_VERBS, type Ulid } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Board, type Actor } from "./index.js";

const USER: Actor = { name: "user", role: "user" };
const ENG: Actor = { name: "eng-1", role: "engineer" };
const REV: Actor = { name: "rev-1", role: "reviewer" };
// A message file is `<id>-<author>.md`, so `rev-a`'s files end in `-a.md` too.
const A: Actor = { name: "a", role: "engineer" };
const REV_A: Actor = { name: "rev-a", role: "reviewer" };
const MISSING = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/** Every message file under a folder, at any depth. */
async function messageFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const folder = entry.parentPath;
    if (entry.isFile() && /\/(channels\/[^/]+|threads\/[0-9A-Z]{26})$/.test(folder)) {
      found.push(path.join(folder, entry.name));
    }
  }
  return found;
}

/** A read's answer, or how it failed, so a refusal compares as one too. */
async function settled<T>(read: Promise<T>): Promise<T | { refused: string }> {
  try {
    return await read;
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Every read the read index answers, over every thread, channel, task, and conversation the board
 * has: with the index seeded these come from it, and from a board that never seeds from the files,
 * which is what each must equal.
 */
async function reads(board: Board, ids: { threads: Ulid[]; tasks: Ulid[] }) {
  const society = await board.society();
  const refs = [
    ...society.channels,
    ...society.archivedChannels.map((each) => each.name),
    ...(await board.listProjects()).flatMap((project) =>
      [...project.channels, ...project.archivedChannels.map((each) => each.name)].map(
        (name) => `${project.slug}/${name}`,
      ),
    ),
  ];
  const channels: Record<string, unknown> = {};
  for (const ref of refs) {
    for (const limit of [1, 2, 200, 0]) {
      channels[`${ref}:${limit}`] = await settled(board.listChannel(ref, limit));
    }
  }
  const threads: Record<string, unknown> = {};
  const everyId: Ulid[] = [];
  for (const id of [...ids.threads, MISSING]) {
    const messages = await settled(board.listThread(id));
    if (Array.isArray(messages)) {
      everyId.push(...messages.map((message) => message.id));
    }
    threads[id] = { record: await settled(board.readThread(id)), messages };
  }
  const tasks: Record<string, unknown> = {};
  for (const id of [...ids.tasks, MISSING]) {
    tasks[id] = await settled(board.findTask(id).then(({ project, task }) => ({ project, task })));
  }
  const mentioned: Record<string, boolean> = {};
  for (const author of ["eng-1", "rev-1", "user"]) {
    for (const name of ["user", "eng-1"]) {
      for (const since of ["2026-09-28T10:00:00.000Z", "2026-09-28T10:30:00.000Z"]) {
        mentioned[`${author}>${name}@${since}`] = await board.hasMentioned(author, name, since);
      }
    }
  }
  const digests: Record<string, unknown> = {};
  for (const actor of [ENG, REV, A, REV_A]) {
    const conversations: Actor[] = [
      actor,
      { ...actor, scope: "lab" },
      { ...actor, scope: "society" },
      { ...actor, scope: "lab", channel: "dev" },
      { ...actor, scope: "society", place: "lab" },
      ...ids.threads.map((thread) => ({ ...actor, scope: "lab", thread })),
    ];
    for (const conversation of conversations) {
      const key = [
        conversation.scope,
        conversation.thread,
        conversation.channel,
        conversation.place,
      ]
        .filter((part) => part !== undefined)
        .join("/");
      digests[`${actor.name}:${key}`] = await settled(
        board.readDigest(conversation, { advance: false }),
      );
    }
    digests[`${actor.name}:unread`] = await settled(board.unreadByConversation(actor));
    digests[`${actor.name}:recent`] = await settled(
      board.readRecentlyRead({ ...actor, scope: "lab" }, { since: new Date(0), limit: 50 }),
    );
  }
  return {
    channels,
    threads,
    tasks,
    listThreads: await board.listThreads(),
    listRequests: await board.listRequests(),
    listChannels: await board.listChannels(),
    findMessages: await board.findMessages([...everyId.toReversed(), MISSING, ...everyId]),
    mentioned,
    digests,
  };
}

describe("the read index", () => {
  let dir: string;
  let clock: Date;
  const now = (): Date => clock;
  const tick = () => {
    clock = new Date(clock.getTime() + 60_000);
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-"));
    clock = new Date("2026-09-28T10:00:00.000Z");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A society with a project of two channels, four members, two named so that one's ends the
   * other's, posts by members and the user in the society's and the project's channels, mentions of
   * the user and of a member, a topic, and a task with its thread; the ids of its threads and tasks,
   * which the steps add to.
   */
  async function society() {
    const { board } = await Board.init(dir, { name: "test society" }, { now, leaseMs: 60_000 });
    await board.addProject(USER, { slug: "lab", channels: ["general", "dev"] });
    for (const role of ["engineer", "reviewer"]) {
      await board.setRoleCharter(USER, {
        name: role,
        purpose: `The ${role} of the test society.`,
        verbs: [...MEMBER_VERBS],
        wakeTriggers: ["heartbeat"],
      });
    }
    for (const actor of [ENG, REV, A, REV_A]) {
      await board.addAgent(USER, {
        name: actor.name,
        role: actor.role,
        cli: "claude",
        memberships: ["lab"],
      });
    }
    await board.postMessage(ENG, { channel: "lab/general", body: "@user which runner?" });
    tick();
    await board.postMessage(REV, { channel: "lab/dev", body: "@eng-1 look at this" });
    await board.postMessage(USER, { channel: "general", body: "Hello, @eng-1." });
    await board.postMessage(REV, { channel: "general", body: "@user a question for you" });
    const topic = await board.openThread(ENG, { channel: "lab/dev", title: "Which runner?" });
    await board.postMessage(ENG, { thread_id: topic.id, body: "@user pick one" });
    await board.postMessage(REV, { thread_id: topic.id, body: "@eng-1 the second" });
    await board.postMessage(REV_A, { thread_id: topic.id, body: "Or the third." });
    await board.postMessage(ENG, { thread_id: topic.id, body: "The second it is." });
    tick();
    const task = await board.createTask(USER, {
      project: "lab",
      title: "Ship it",
      stages: [{ name: "Build" }, { name: "Check" }],
    });
    await board.postMessage(ENG, { thread_id: task.id, body: "@user started" });
    return {
      board,
      topic: topic.id,
      task: task.id,
      ids: { threads: [topic.id, task.id], tasks: [task.id] },
    };
  }

  it("answers every read as the files do, from its seed and after every kind of write", async () => {
    const { board, task, ids } = await society();
    await board.indexReads();
    const files = await Board.open(dir, { now });
    const same = async (step: string) => {
      // The step names itself in a failure's diff.
      expect({ step, reads: await reads(board, ids) }).toEqual({
        step,
        reads: await reads(files, ids),
      });
    };
    await same("seeded");

    await board.postMessage(REV, { channel: "lab/general", body: "@user and another" });
    await same("a post asking the user");
    await board.postMessage(USER, { channel: "lab/general", body: "Answered." });
    await same("the user's answer");
    // Turns read their digests, so each conversation's next digest starts at a cursor.
    for (const actor of [ENG, REV]) {
      await board.readDigest({ ...actor, scope: "lab" }, { advance: true });
      await board.readDigest({ ...actor, scope: "lab", thread: task }, { advance: true });
      await board.readDigest({ ...actor, scope: "lab", channel: "dev" }, { advance: true });
    }
    await board.postMessage(USER, { thread_id: task, body: "@eng-1 @rev-1 after your turns" });
    await board.postMessage(USER, { channel: "lab/dev", body: "@eng-1 and here" });
    await board.postMessage(REV, { channel: "lab/general", body: "@eng-1 and at home" });
    await same("turns read their digests, and more posts came");
    const topic = await board.openThread(REV, { channel: "lab/general", title: "Late" });
    ids.threads.push(topic.id);
    await same("a thread opened");
    await board.postMessage(USER, { thread_id: topic.id, body: "@eng-1 over to you" });
    await board.closeThread(REV, { thread_id: topic.id, summary: "Done." });
    await same("a thread closed");

    await board.claimTask(ENG, { task_id: task });
    await same("a task claimed");
    await board.advanceTask(ENG, { task_id: task, note: "Built, @user." });
    await same("a task advanced");
    await board.claimTask(REV, { task_id: task });
    await board.updateTask(REV, { task_id: task, stage: "s1", note: "Not yet." });
    await same("a task sent back");
    const done = await board.createTask(USER, { project: "lab", title: "Small" });
    ids.tasks.push(done.id);
    ids.threads.push(done.id);
    await board.claimTask(ENG, { task_id: done.id });
    await board.advanceTask(ENG, { task_id: done.id, note: "Done." });
    await same("a task finished");

    const proposal = await board.propose(ENG, {
      kind: "channel",
      charter: { project: "lab", name: "rel", purpose: "Releases." },
    });
    ids.threads.push(proposal.id);
    await board.postMessage(ENG, { thread_id: proposal.id, body: "@user for the release" });
    await same("a proposal opened");
    await board.approve(USER, { proposal_id: proposal.id });
    await same("a proposal decided");

    const rel = await board.openThread(ENG, { channel: "lab/rel", title: "Cut it" });
    ids.threads.push(rel.id);
    await board.postMessage(ENG, { channel: "lab/rel", body: "@user tagged" });
    await board.archiveChannel(USER, { channel: "lab/rel", reason: "Released." });
    await same("a channel archived, its open thread closed");

    await board.updateTask(USER, { task_id: task, status: "abandoned" });
    await same("a task abandoned");
    await board.archiveProject(USER, { project: "lab", reason: "Finished." });
    await same("a project archived");

    // A board that seeds from the files the writes left holds what this one built from them.
    const again = await Board.open(dir, { now });
    await again.indexReads();
    expect(await reads(again, ids)).toEqual(await reads(board, ids));
  });

  it("counts a citizen in a thread by its own name, never by one that ends in it", async () => {
    const { board, topic } = await society();
    // rev-a posted in the topic and `a` never did, so only rev-a is in it.
    const inTopic = async (actor: Actor) =>
      (await board.unreadByConversation(actor)).some((each) => each.thread === topic);
    const close = (actor: Actor) =>
      settled(board.closeThread(actor, { thread_id: topic, summary: "Settled." }));
    // From the files, as before the seed and in the admin CLI, and then from the index.
    for (const step of ["files", "index"]) {
      expect({ step, a: await inTopic(A), revA: await inTopic(REV_A) }).toEqual({
        step,
        a: false,
        revA: true,
      });
      expect({ step, closed: await close(A) }).toEqual({
        step,
        closed: {
          refused:
            "only the thread's participants, the user, the steward, or the concierge may close it",
        },
      });
      await board.indexReads();
    }
  });

  it("takes the writes made while it is seeded, each once", async () => {
    const { board, topic, task, ids } = await society();
    const seeded = board.indexReads();
    await Promise.all([
      seeded,
      // A post to the topic after it closed is refused, as it would be without the seed.
      ...Array.from({ length: 20 }, (_, n) =>
        board
          .postMessage(n % 2 === 0 ? REV : USER, {
            ...(n % 3 === 0 ? { channel: "lab/general" } : { thread_id: topic }),
            body: `@user meanwhile ${n}`,
          })
          .catch(() => null),
      ),
      board.closeThread(ENG, { thread_id: topic, summary: "Closed meanwhile." }).catch(() => null),
      (async () => {
        const made = await board.createTask(USER, { project: "lab", title: "Meanwhile" });
        ids.tasks.push(made.id);
        ids.threads.push(made.id);
      })(),
      board.claimTask(ENG, { task_id: task }),
    ]);
    expect(await reads(board, ids)).toEqual(await reads(await Board.open(dir, { now }), ids));
  });

  it("reads no message file once seeded, so one changed by hand shows only after a new seed", async () => {
    const { board, topic, ids } = await society();
    await board.indexReads();
    const before = await reads(board, ids);
    const removed = await messageFiles(board.paths.board);
    expect(removed.length).toBeGreaterThan(5);
    await Promise.all(removed.map((file) => rm(file)));
    expect(await reads(board, ids)).toEqual(before);
    // A board seeded afresh from the files reads them as they are now.
    const after = await Board.open(dir, { now });
    await after.indexReads();
    expect(await after.listThread(topic)).toEqual([]);
  });

  it("refuses a write to a thread whose file is gone, whatever the index holds", async () => {
    const { board, task } = await society();
    await board.indexReads();
    await board.claimTask(ENG, { task_id: task });
    await rm(board.paths.threadFile(board.paths.threadsOf("lab/general"), task));
    await expect(board.advanceTask(ENG, { task_id: task, note: "Shipped." })).rejects.toMatchObject(
      {
        code: "INVALID_STATE",
        message: `task ${task} has no open thread`,
      },
    );
  });

  it("never moves a cursor past a message written while a seeded digest was read", async () => {
    const { board } = await society();
    await board.indexReads();
    const reader = { ...ENG, scope: "lab" };
    const posted: string[] = [];
    const delivered = new Set<string>();
    for (let round = 0; round < 20; round += 1) {
      const [digest, ...posts] = await Promise.all([
        board.readDigest(reader, { advance: true }),
        board.postMessage(USER, { channel: "lab/general", body: `@eng-1 general ${round}` }),
        board.postMessage(REV, { channel: "lab/general", body: `@eng-1 again ${round}` }),
      ]);
      posted.push(...posts.map((post) => post.id));
      for (const message of digest.messages) {
        delivered.add(message.id);
      }
    }
    for (const message of (await board.readDigest(reader, { advance: true })).messages) {
      delivered.add(message.id);
    }
    expect(posted.filter((id) => !delivered.has(id))).toEqual([]);
  });
});
