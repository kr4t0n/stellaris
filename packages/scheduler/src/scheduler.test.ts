import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Board, SYSTEM_ACTOR, type Actor } from "@stellaris/board-core";
import {
  MEMBER_VERBS,
  sessionKey,
  type Name,
  type TurnDispatch,
  type TurnRecord,
  type Ulid,
} from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Scheduler, type SteerOutcome, type TurnAssignment, type TurnRunner } from "./scheduler.js";

const run = promisify(execFile);

const USER: Actor = { name: "user", role: "user" };
const ENG: Actor = { name: "eng-1", role: "engineer" };
const REV: Actor = { name: "rev-1", role: "reviewer" };

class FakeRunner implements TurnRunner {
  readonly dispatches: TurnDispatch[] = [];
  readonly completions: Array<{ project: Name; taskId: Ulid }> = [];
  private releases: Array<() => void> = [];
  hold = false;

  /** With a board, turns are recorded like the real runner does, on the injected clock. */
  constructor(
    private readonly board: Board | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Runners that are away: a turn waits until one is back. */
  away = false;

  /** Conversations a steer was asked for, as session keys, and what each ask answers. */
  readonly steered: string[] = [];
  steerOutcome: SteerOutcome = "sent";

  async steer(conversation: { agent: Name; project: Name; thread?: Ulid }): Promise<SteerOutcome> {
    this.steered.push(sessionKey(conversation.agent, conversation.project, conversation.thread));
    return this.steerOutcome;
  }

  async assign(): Promise<TurnAssignment | null> {
    return this.away ? null : { runner: "test" };
  }

  async runTurn(dispatch: TurnDispatch): Promise<TurnRecord> {
    this.dispatches.push(dispatch);
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.releases.push(resolve);
      });
    }
    const record: TurnRecord = {
      agent: dispatch.agent,
      project: dispatch.project,
      runner: "test",
      cli: "claude",
      session: "s",
      trigger: dispatch.trigger,
      startedAt: this.now().toISOString(),
      endedAt: this.now().toISOString(),
      exitReason: "completed",
      status: null,
      error: null,
      usage: null,
      costUsd: 0,
      toolCalls: 0,
      model: null,
    };
    if (this.board !== null) {
      await this.board.beginTurn(record);
      await this.board.finishTurn(record);
    }
    return record;
  }

  releaseHeld(): void {
    for (const release of this.releases) {
      release();
    }
    this.releases = [];
  }

  async completeTask(project: Name, taskId: Ulid): Promise<"done" | "deferred"> {
    if (this.away) {
      return "deferred";
    }
    this.completions.push({ project, taskId });
    return "done";
  }
}

/** Roles for the work itself are not seeded; the tests write them as a society would. */
async function addWorkRoles(board: Board): Promise<void> {
  await board.setRoleCharter(USER, {
    name: "engineer",
    purpose: "Builds.",
    verbs: [...MEMBER_VERBS],
    wakeTriggers: ["heartbeat"],
  });
  await board.setRoleCharter(USER, {
    name: "reviewer",
    purpose: "Checks.",
    verbs: [...MEMBER_VERBS],
    wakeTriggers: ["heartbeat"],
  });
}

describe("Scheduler", () => {
  let dir: string;
  let clock: Date;
  const now = (): Date => clock;
  const advance = (ms: number): void => {
    clock = new Date(clock.getTime() + ms);
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-sched-"));
    clock = new Date("2026-09-28T10:00:00.000Z");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setup(
    options: { concurrency?: number; timings?: Record<string, number>; record?: boolean } = {},
  ) {
    const { board } = await Board.init(dir, { name: "sched" }, { now, leaseMs: 60_000 });
    // A second channel, beside the default general, which members do not follow until they choose to.
    await board.addProject(USER, { slug: "demo", channels: ["general", "dev"] });
    await addWorkRoles(board);
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    await board.addAgent(USER, {
      name: "rev-1",
      role: "reviewer",
      cli: "claude",
      memberships: ["demo"],
    });
    const runner = new FakeRunner(options.record === true ? board : null, now);
    const scheduler = new Scheduler({
      board,
      runner,
      now,
      concurrency: options.concurrency ?? 2,
      timings: {
        debounceMs: 1_000,
        userDebounceMs: 0,
        heartbeatMs: 10_000,
        waitingStageMs: 5_000,
        leaseSweepMs: 1_000,
        ...options.timings,
      },
    });
    // Run the onboarding turns from the agent.added events until nothing is queued, whatever the cap.
    for (let i = 0; i < 6; i += 1) {
      await scheduler.tick();
      await scheduler.drain();
      if (scheduler.pendingCount === 0 && scheduler.runningCount === 0) {
        break;
      }
    }
    expect(runner.dispatches.map((d) => d.trigger.kind)).toEqual(["onboarding", "onboarding"]);
    runner.dispatches.length = 0;
    return { board, runner, scheduler };
  }

  it("fires onboarding turns when agents join a project", async () => {
    const { board } = await Board.init(dir, { name: "sched" }, { now });
    await board.addProject(USER, { slug: "demo" });
    await addWorkRoles(board);
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const runner = new FakeRunner();
    const scheduler = new Scheduler({ board, runner, now, timings: { debounceMs: 0 } });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind, d.onboarding])).toEqual([
      ["eng-1", "onboarding", true],
    ]);
  });

  it("dispatches user mentions immediately and debounces agent mentions", async () => {
    const { board, runner, scheduler } = await setup();
    await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 please start" });
    await scheduler.tick();
    await scheduler.drain();
    expect(
      runner.dispatches.map((d) => [d.agent, d.trigger.kind, d.trigger.fromUser, d.priority]),
    ).toEqual([["eng-1", "mention", true, 2]]);

    await board.postMessage(ENG, { channel: "demo/general", body: "@rev-1 could you look?" });
    await scheduler.tick();
    expect(runner.dispatches).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(1);
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.at(-1)?.agent).toBe("rev-1");
    expect(runner.dispatches.at(-1)?.trigger.fromUser).toBe(false);
  });

  it("holds dispatches while paused and releases them on resume", async () => {
    const { board, runner, scheduler } = await setup();
    await board.setPaused(USER, true);
    await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 wait" });
    await scheduler.tick();
    expect(runner.dispatches).toHaveLength(0);
    expect(scheduler.pendingCount).toBe(1);
    await board.setPaused(USER, false);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toHaveLength(1);
  });

  it("keeps a turn queued while no runner can take it, and retries a landing a runner deferred", async () => {
    const { board, runner, scheduler } = await setup();
    runner.away = true;
    await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 when you can" });
    await scheduler.tick();
    await scheduler.tick();
    expect(runner.dispatches).toHaveLength(0);
    expect(scheduler.pendingPairs).toEqual(["eng-1/demo"]);
    runner.away = false;
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => d.agent)).toEqual(["eng-1"]);

    await board.configureProject(USER, { project: "demo", on_done: "merge" });
    const task = await board.createTask(USER, { project: "demo", title: "t" });
    await board.claimTask(ENG, { task_id: task.id });
    await board.advanceTask(ENG, { task_id: task.id });
    runner.away = true;
    await scheduler.tick();
    await scheduler.drain();
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.completions).toEqual([]);
    runner.away = false;
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.completions).toEqual([{ project: "demo", taskId: task.id }]);
  });

  it("respects the concurrency cap and never runs one pair twice at once", async () => {
    const { board, runner, scheduler } = await setup({ concurrency: 1 });
    runner.hold = true;
    await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 and @rev-1 go" });
    await scheduler.tick();
    expect(scheduler.runningCount).toBe(1);
    expect(scheduler.pendingCount).toBe(1);
    await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 again" });
    await scheduler.tick();
    expect(scheduler.runningPairs).toEqual(["eng-1/demo"]);
    expect(scheduler.pendingPairs).toEqual(["eng-1/demo", "rev-1/demo"]);
    runner.hold = false;
    runner.releaseHeld();
    await scheduler.drain();
    // With a cap of one, the two queued turns need one tick each.
    for (let i = 0; i < 2; i += 1) {
      await scheduler.tick();
      await scheduler.drain();
    }
    expect(runner.dispatches.map((d) => d.agent).toSorted()).toEqual(["eng-1", "eng-1", "rev-1"]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("wakes each stage's assignee, completes after the finishing turn ends, and wakes the creator", async () => {
    const { board, runner, scheduler } = await setup();
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      advance(1_000);
      await scheduler.tick();
      await scheduler.drain();
    };
    await board.configureProject(USER, { project: "demo", on_done: "merge" });
    const task = await board.createTask(ENG, {
      project: "demo",
      title: "t",
      stages: [
        { name: "build", role: "engineer" },
        { name: "review", role: "reviewer" },
      ],
    });
    await settle();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind, d.trigger.taskId])).toEqual([
      ["eng-1", "stage", task.id],
    ]);
    expect(runner.dispatches[0]?.trigger.reason).toContain('stage "build"');

    await board.claimTask(ENG, { task_id: task.id });
    await board.advanceTask(ENG, { task_id: task.id });
    await settle();
    expect(runner.dispatches.at(-1)).toMatchObject({ agent: "rev-1", trigger: { kind: "stage" } });

    // The reviewer finishes the last stage during its own turn; the merge waits for that turn.
    runner.hold = true;
    await board.postMessage(USER, { channel: "demo/general", body: "@rev-1 over to you" });
    await scheduler.tick();
    expect(scheduler.runningPairs).toEqual(["rev-1/demo"]);
    await board.claimTask(REV, { task_id: task.id });
    await board.advanceTask(REV, { task_id: task.id });
    await scheduler.tick();
    expect(runner.completions).toEqual([]);
    runner.hold = false;
    runner.releaseHeld();
    await scheduler.drain();
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.completions).toEqual([{ project: "demo", taskId: task.id }]);

    // A finished task wakes its creator.
    await board.finishCompletion(SYSTEM_ACTOR, { taskId: task.id, ok: true, detail: "merged" });
    await settle();
    expect(runner.dispatches.at(-1)).toMatchObject({
      agent: "eng-1",
      trigger: { kind: "task_done", taskId: task.id },
    });
  });

  it("drops a stage wake gone stale during the agent's own turn as soon as it does, unless another wake merged into it", async () => {
    const { board, runner, scheduler } = await setup();
    const task = await board.createTask(USER, {
      project: "demo",
      title: "t",
      stages: [
        { name: "build", role: "engineer" },
        { name: "polish", role: "engineer" },
        { name: "review", role: "reviewer" },
      ],
    });
    runner.hold = true;
    await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 go" });
    await scheduler.tick();
    expect(scheduler.runningPairs).toEqual(["eng-1/demo"]);
    // Within one turn eng-1 finishes "build", which queues a wake for "polish", then takes "polish" itself.
    await board.claimTask(ENG, { task_id: task.id });
    await board.advanceTask(ENG, { task_id: task.id });
    await scheduler.tick();
    await board.claimTask(ENG, { task_id: task.id });
    await board.advanceTask(ENG, { task_id: task.id });
    await scheduler.tick();
    // Taken and finished in the same turn: the wake for "polish" leaves the queue at once.
    expect(scheduler.pendingPairs).toEqual([sessionKey("rev-1", "demo", task.id)]);
    runner.hold = false;
    runner.releaseHeld();
    await scheduler.drain();
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([
      ["eng-1", "mention"],
      ["rev-1", "stage"],
    ]);
    expect(scheduler.pendingCount).toBe(0);

    // A mention in the task's thread merges into its stage wake and still needs its turn, stale
    // stage or not.
    runner.dispatches.length = 0;
    runner.hold = true;
    await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 one more" });
    await scheduler.tick();
    const next = await board.createTask(USER, {
      project: "demo",
      title: "u",
      stages: [{ name: "build", role: "engineer" }],
    });
    await scheduler.tick();
    await board.postMessage(REV, { thread_id: next.id, body: "@eng-1 see the new task" });
    await board.claimTask(ENG, { task_id: next.id });
    await scheduler.tick();
    runner.hold = false;
    runner.releaseHeld();
    await scheduler.drain();
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([
      ["eng-1", "mention"],
      ["eng-1", "stage"],
    ]);
  });

  it("drops a queued stage wake the moment its stage is taken in the turn it waits behind", async () => {
    const { board, runner, scheduler } = await setup();
    const task = await board.createTask(USER, {
      project: "demo",
      title: "t",
      stages: [{ name: "build", agent: "eng-1" }],
    });
    // eng-1 is already in a turn in the task's conversation when its stage comes up, as when a
    // replan makes a new stage current during the turn a mention started.
    runner.hold = true;
    await board.postMessage(USER, { thread_id: task.id, body: "@eng-1 go" });
    await scheduler.tick();
    advance(1_000);
    await scheduler.tick();
    expect(scheduler.runningPairs).toEqual([sessionKey("eng-1", "demo", task.id)]);
    await board.planTask(USER, {
      task_id: task.id,
      stages: [
        { name: "survey", agent: "eng-1" },
        { id: "s1", name: "build", agent: "eng-1" },
      ],
    });
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual([sessionKey("eng-1", "demo", task.id)]);

    // It claims the new stage there, so the wake behind its turn would never run.
    await board.claimTask({ ...ENG, scope: "demo", thread: task.id }, { task_id: task.id });
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual([]);
    runner.hold = false;
    runner.releaseHeld();
    await scheduler.drain();
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => d.trigger.kind)).toEqual(["mention"]);
  });

  it("drops the queued wakes of everyone else a stage was open to once one takes it, and keeps the holder's", async () => {
    const { board, runner, scheduler } = await setup();
    await board.addAgent(USER, {
      name: "eng-2",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    for (let i = 0; i < 3; i += 1) {
      await scheduler.tick();
      await scheduler.drain();
    }
    runner.dispatches.length = 0;
    const task = await board.createTask(USER, {
      project: "demo",
      title: "t",
      stages: [{ name: "build", role: "engineer" }],
    });
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual([
      sessionKey("eng-1", "demo", task.id),
      sessionKey("eng-2", "demo", task.id),
    ]);
    // eng-2 takes it from outside the task's conversation: its wake there is now a holder's.
    await board.claimTask({ name: "eng-2", role: "engineer" }, { task_id: task.id });
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual([sessionKey("eng-2", "demo", task.id)]);
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([["eng-2", "stage"]]);
  });

  it("drops a queued stage wake when the plan hands the stage to someone else or the task ends", async () => {
    const { board, scheduler } = await setup();
    const first = await board.createTask(USER, {
      project: "demo",
      title: "t",
      stages: [{ name: "build", agent: "eng-1" }],
    });
    const second = await board.createTask(USER, {
      project: "demo",
      title: "u",
      stages: [{ name: "build", agent: "eng-1" }],
    });
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual([
      sessionKey("eng-1", "demo", first.id),
      sessionKey("eng-1", "demo", second.id),
    ]);
    await board.planTask(USER, {
      task_id: first.id,
      stages: [{ id: "s1", name: "build", agent: "rev-1" }],
    });
    await board.updateTask(USER, { task_id: second.id, status: "abandoned" });
    await scheduler.tick();
    expect(scheduler.pendingPairs).not.toContain(sessionKey("eng-1", "demo", first.id));
    expect(scheduler.pendingPairs).not.toContain(sessionKey("eng-1", "demo", second.id));
  });

  it("steers a mention into the turn running in its conversation, and drops it once read there", async () => {
    const { board, runner, scheduler } = await setup();
    runner.hold = true;
    await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 please start" });
    await scheduler.tick();
    expect(runner.dispatches).toHaveLength(1);

    // A runner with a steer not yet taken is busy: the next pass asks again.
    runner.steerOutcome = "busy";
    const more = await board.postMessage(USER, {
      channel: "demo/general",
      body: "@eng-1 and a test",
    });
    await scheduler.tick();
    await scheduler.tick();
    expect(runner.steered).toEqual(["eng-1/demo", "eng-1/demo"]);
    runner.steerOutcome = "sent";
    await scheduler.tick();
    await scheduler.tick();
    expect(runner.steered).toHaveLength(3);

    // The turn took it, so its conversation's cursor passed it: the wake needs no turn of its own.
    await board.setDigestCursor("eng-1", "demo", more.id);
    runner.releaseHeld();
    await scheduler.drain();
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("runs a turn for a steered mention the running turn did not take, and for any other wake merged in", async () => {
    const { board, runner, scheduler } = await setup();
    runner.hold = true;
    await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 please start" });
    await scheduler.tick();
    // Accepted but never taken: the turn ends with the cursor short of the message.
    await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 and a test" });
    await scheduler.tick();
    expect(runner.steered).toEqual(["eng-1/demo"]);
    runner.releaseHeld();
    runner.hold = false;
    await scheduler.drain();
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => d.trigger.reason)).toEqual([
      "mentioned by user",
      "mentioned by user",
    ]);

    // A wake that is not about a message runs even when every message in it was read.
    runner.hold = true;
    const third = await board.postMessage(USER, {
      channel: "demo/general",
      body: "@eng-1 hold on",
    });
    await scheduler.tick();
    await board.requestWake(USER, { agent: "eng-1", project: "demo", reason: "check in" });
    await scheduler.tick();
    await board.setDigestCursor("eng-1", "demo", third.id);
    runner.releaseHeld();
    runner.hold = false;
    await scheduler.drain();
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => d.trigger.kind).slice(-2)).toEqual(["mention", "manual"]);
  });

  it("works a stage claimed outside its task's conversation in that conversation, once", async () => {
    const { board, runner, scheduler } = await setup({ record: true });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      advance(1_000);
      await scheduler.tick();
      await scheduler.drain();
    };
    const task = await board.createTask(USER, {
      project: "demo",
      title: "t",
      stages: [{ name: "build", role: "engineer" }],
    });
    await settle();
    expect(runner.dispatches.map((d) => [d.agent, d.thread?.id])).toEqual([["eng-1", task.id]]);
    runner.dispatches.length = 0;

    // That turn left the stage alone; a later home turn claims it, and the task's own
    // conversation is woken to do the work rather than waiting for a heartbeat.
    const home = { ...ENG, scope: "demo" };
    await board.claimTask(home, { task_id: task.id });
    await settle();
    expect(runner.dispatches.map((d) => [d.agent, d.thread?.id, d.trigger.kind])).toEqual([
      ["eng-1", task.id, "stage"],
    ]);
    expect(runner.dispatches[0]?.trigger.reason).toContain("is yours; its work happens here");

    // A claim made in the task's own conversation is that conversation's work already.
    runner.dispatches.length = 0;
    await board.releaseTask(home, { task_id: task.id });
    await board.claimTask({ ...home, thread: task.id }, { task_id: task.id });
    await settle();
    expect(runner.dispatches).toEqual([]);

    // A stage claimed elsewhere and finished before the wake comes up needs no turn.
    await board.releaseTask(home, { task_id: task.id });
    await board.claimTask(home, { task_id: task.id });
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual([sessionKey("eng-1", "demo", task.id)]);
    await board.advanceTask(home, { task_id: task.id });
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toEqual([]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("wakes a newcomer for a stage that waited on its role, in the task's conversation", async () => {
    const { board, runner, scheduler } = await setup({ record: true });
    await board.setRoleCharter(USER, {
      name: "researcher",
      purpose: "Researches.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    const task = await board.createTask(USER, {
      project: "demo",
      title: "survey",
      stages: [{ name: "research", role: "researcher" }],
    });
    await scheduler.tick();
    advance(1_000);
    await scheduler.tick();
    expect(scheduler.pendingCount).toBe(0);

    // Its first turn, at home, claims the stage it found and leaves the work to the task's
    // conversation, which starts once the debounce is over.
    await board.addAgent(USER, {
      name: "sage",
      role: "researcher",
      cli: "claude",
      memberships: ["demo"],
    });
    runner.hold = true;
    await scheduler.tick();
    expect(scheduler.runningPairs).toEqual(["sage/demo"]);
    expect(scheduler.pendingPairs).toEqual([sessionKey("sage", "demo", task.id)]);
    await board.claimTask(
      { name: "sage", role: "researcher", scope: "demo" },
      { task_id: task.id },
    );
    await scheduler.tick();
    runner.hold = false;
    runner.releaseHeld();
    await scheduler.drain();
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.thread?.id ?? null, d.trigger.kind])).toEqual([
      ["sage", null, "onboarding"],
      ["sage", task.id, "stage"],
    ]);
  });

  it("signals a stage left waiting past the threshold once, and wakes nobody by it", async () => {
    const { board, runner, scheduler } = await setup();
    // A stage for the user wakes no citizen, so only the timer notices it.
    const task = await board.createTask(USER, {
      project: "demo",
      title: "nobody took me",
      stages: [{ name: "decide", agent: "user" }],
    });
    await scheduler.tick();
    expect(scheduler.pendingCount).toBe(0);
    advance(5_000);
    await scheduler.tick();
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toEqual([]);
    const waiting = (await board.listSignals()).filter((s) => s.signal.kind === "waiting_stage");
    expect(waiting.map((s) => s.signal.key)).toEqual([`waiting_stage:${task.id}:s1`]);
    expect(waiting[0]?.signal.summary).toContain("for user");
  });

  it("wakes every member who may take a stage that names nobody, on entry and on heartbeat", async () => {
    const { board, runner, scheduler } = await setup();
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      advance(1_000);
      await scheduler.tick();
      await scheduler.drain();
    };
    const task = await board.createTask(USER, {
      project: "demo",
      title: "t",
      stages: [{ name: "draft" }, { name: "check", gate: true }],
    });
    await settle();
    expect(
      runner.dispatches
        .map((d) => `${d.agent}:${d.trigger.kind}`)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["eng-1:stage", "rev-1:stage"]);

    // The gate keeps the check from whoever drafted, so it wakes the other member alone.
    runner.dispatches.length = 0;
    await board.claimTask(ENG, { task_id: task.id });
    await board.advanceTask(ENG, { task_id: task.id });
    await settle();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([["rev-1", "stage"]]);

    // The wake led to no claim; the heartbeat brings back whoever may take it, and nobody else.
    runner.dispatches.length = 0;
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([
      ["rev-1", "heartbeat"],
    ]);
  });

  it("wakes on heartbeat for a stage waiting on the member's role", async () => {
    const { board, runner, scheduler } = await setup();
    await board.createTask(USER, {
      project: "demo",
      title: "check this",
      stages: [{ name: "review", role: "reviewer" }],
    });
    await scheduler.tick();
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([["rev-1", "stage"]]);
    runner.dispatches.length = 0;
    // The first wake led to no claim; the heartbeat brings the reviewer back, and nobody else.
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([
      ["rev-1", "heartbeat"],
    ]);
  });

  it("wakes on heartbeat only when there is something to read or hold", async () => {
    const { board, runner, scheduler } = await setup();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toHaveLength(0);
    // The board's own posts, a spend report for the steward and a landing announcement for the
    // project's members, are read at the next wake; they wake nobody by themselves.
    await board.publishSignal({
      kind: "turn_cost",
      key: "turn_cost:report",
      summary: "spend in the last hour: $1.20 over 4 turns",
      value: 1.2,
    });
    await board.postMessage(SYSTEM_ACTOR, {
      channel: "demo/general",
      body: "Task 01ARZ3NDEKTSV4RRFFQ69G5FAV is done: merged into main at abc123.",
    });
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toHaveLength(0);
    await board.postMessage(USER, { channel: "demo/dev", body: "no mention, just news" });
    await board.subscribe(ENG, { channel: "demo/dev" });
    await scheduler.tick();
    expect(scheduler.pendingCount).toBe(0);
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([
      ["eng-1", "heartbeat"],
    ]);
  });

  it("wakes a citizen where it was asked, and outside its projects for anything asked elsewhere", async () => {
    const { board, runner, scheduler } = await setup();
    await board.addProject(USER, { slug: "lab" });
    // A society channel, and a project the citizen is not in, each get a turn outside projects
    // rather than one in its first project, with the channel the question came from.
    await board.postMessage(USER, { channel: "general", body: "@eng-1 a general question" });
    await board.postMessage(USER, { channel: "lab/general", body: "@rev-1 a lab question" });
    await board.postMessage(USER, { channel: "demo/general", body: "@rev-1 a demo question" });
    await scheduler.tick();
    await scheduler.drain();
    expect(
      runner.dispatches
        .map((d) => `${d.agent}:${d.project}:${d.trigger.channel ?? "-"}`)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["eng-1:society:general", "rev-1:demo:demo/general", "rev-1:society:lab/general"]);
  });

  it("wakes only a role that watches the society for news outside projects", async () => {
    const { board, runner, scheduler } = await setup({ timings: { waitingStageMs: 3_600_000 } });
    await board.setRoleCharter(USER, {
      name: "lead",
      purpose: "Leads.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
      societyScope: true,
    });
    // A society role, in no project; eng-1 and rev-1 follow general too but work in demo.
    await board.addAgent(USER, { name: "lead-1", role: "lead", cli: "claude" });
    await scheduler.tick();
    // Every member follows general; a post there that mentions nobody is news, not a question.
    await board.postMessage(ENG, { channel: "general", body: "the build is green again" });
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.project, d.trigger.kind])).toEqual([
      ["lead-1", "society", "heartbeat"],
    ]);
  });

  it("wakes a heartbeat only in the scope its reasons belong to", async () => {
    const { board, runner, scheduler } = await setup();
    await board.addProject(USER, { slug: "lab" });
    await board.joinProject(USER, { project: "lab", agent: "eng-1" });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.project, d.trigger.kind])).toEqual([
      ["eng-1", "lab", "onboarding"],
    ]);
    runner.dispatches.length = 0;
    // Both heartbeats have been seen once, so the next due pass may fire them.
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toEqual([]);

    // A stage held in lab brings eng-1 back to lab, not to demo. Its one stage names nobody, so
    // it first wakes eng-1, lab's one working member.
    const task = await board.createTask(USER, { project: "lab", title: "measure" });
    await scheduler.tick();
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.project, d.trigger.kind])).toEqual([
      ["eng-1", "lab", "stage"],
    ]);
    runner.dispatches.length = 0;
    // Claimed in the task's own conversation, by that stage turn; a claim from elsewhere would
    // wake the conversation at once instead of waiting for the heartbeat.
    await board.claimTask({ ...ENG, scope: "lab", thread: task.id }, { task_id: task.id });
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.project, d.trigger.kind])).toEqual([
      ["eng-1", "lab", "heartbeat"],
    ]);
    runner.dispatches.length = 0;
    await board.updateTask(USER, { task_id: task.id, status: "abandoned" });

    // News in a society channel wakes no project heartbeat; news in demo wakes demo only.
    await board.subscribe(ENG, { channel: "general" });
    await board.postMessage(USER, { channel: "general", body: "society news" });
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toEqual([]);
    await board.subscribe(ENG, { channel: "demo/dev" });
    await board.postMessage(USER, { channel: "demo/dev", body: "demo news" });
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.project, d.trigger.kind])).toEqual([
      ["eng-1", "demo", "heartbeat"],
    ]);
  });

  it("gives each thread a session: task threads run side by side, other conversations share a lane", async () => {
    const { board, runner, scheduler } = await setup({ concurrency: 4 });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      advance(1_000);
      await scheduler.tick();
    };
    const build = [{ name: "build", role: "engineer" }];
    const first = await board.createTask(USER, { project: "demo", title: "first", stages: build });
    const second = await board.createTask(USER, {
      project: "demo",
      title: "second",
      stages: build,
    });
    runner.hold = true;
    await settle();
    // Two tasks' conversations run at once, each in its task's thread.
    expect(scheduler.runningPairs).toEqual([
      sessionKey("eng-1", "demo", first.id),
      sessionKey("eng-1", "demo", second.id),
    ]);
    expect(runner.dispatches.map((d) => d.thread)).toEqual([
      { id: first.id, task: true },
      { id: second.id, task: true },
    ]);

    // A topic thread and the channels share the scope's worktree, so they take turns.
    const topic = await board.openThread(REV, { channel: "demo/dev", title: "which library?" });
    await board.postMessage(REV, { thread_id: topic.id, body: "@eng-1 thoughts?" });
    await board.postMessage(REV, { channel: "demo/general", body: "@eng-1 hello" });
    await settle();
    expect(scheduler.runningPairs).toContain(sessionKey("eng-1", "demo", topic.id));
    expect(scheduler.pendingPairs).toEqual([sessionKey("eng-1", "demo")]);
    runner.hold = false;
    runner.releaseHeld();
    await scheduler.drain();
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.slice(2).map((d) => [d.trigger.kind, d.thread])).toEqual([
      ["mention", { id: topic.id, task: false }],
      ["mention", undefined],
    ]);
  });

  it("schedules a reflection turn per cadence, only after new work, in the scope of that work", async () => {
    const { board, runner, scheduler } = await setup({
      timings: { reflectionMs: 60_000, heartbeatMs: 3_600_000, waitingStageMs: 3_600_000 },
      record: true,
    });
    // The reflection clock starts at the scheduler's first sight; nothing happens before the cadence.
    advance(30_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toEqual([]);
    // Past the cadence, only members whose charter reflects and who have worked since take a turn;
    // the onboarding turns count as work for both.
    advance(31_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.project, d.trigger.kind, d.priority])).toEqual([
      ["eng-1", "demo", "reflection", 0],
      ["rev-1", "demo", "reflection", 0],
    ]);
    runner.dispatches.length = 0;
    // Nobody worked since: the next cadence passes in silence.
    advance(61_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toEqual([]);
    // A working turn for one member makes the next cadence wake that member alone.
    await board.requestWake(USER, { agent: "eng-1", project: "demo", reason: "work" });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => d.trigger.kind)).toEqual(["manual"]);
    runner.dispatches.length = 0;
    advance(61_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([
      ["eng-1", "reflection"],
    ]);
    runner.dispatches.length = 0;
    // A reflection requested ahead of the cadence dispatches at once, at user priority, and restarts the clock.
    await board.requestWake(USER, {
      agent: "rev-1",
      project: "demo",
      reason: "reflect now",
      kind: "reflection",
    });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind, d.priority])).toEqual([
      ["rev-1", "reflection", 0],
    ]);
    // A role that does not reflect never gets one: the user's charter says so, and it has no CLI anyway.
    const state = await board.readState(
      "scheduler",
      z.object({ lastReflection: z.record(z.string(), z.string()) }),
      { lastReflection: {} },
    );
    expect(Object.keys(state.lastReflection).toSorted()).toEqual(["eng-1", "rev-1"]);
  });

  it("lets a pass under way finish and save its cursor before it stops", async () => {
    const { board, scheduler } = await setup();
    await board.postMessage(USER, {
      channel: "demo/general",
      body: "@eng-1 a note before shutdown",
    });
    const last = (await board.readEvents(null)).at(-1)?.id;
    // The pass is under way when the stop comes, as one started by the timer would be.
    const pass = scheduler.tick();
    await scheduler.stop();
    const state = await board.readState("scheduler", z.object({ cursor: z.string().nullable() }), {
      cursor: null,
    });
    expect(state.cursor).toBe(last);
    await pass;
  });

  it("manual wakes go through the same dispatch", async () => {
    const { board, runner, scheduler } = await setup();
    await board.requestWake(USER, { agent: "rev-1", project: "demo", reason: "dev" });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind, d.priority])).toEqual([
      ["rev-1", "manual", 2],
    ]);
  });

  it("publishes a backlog signal and wakes the steward on it, once per condition", async () => {
    const { board, runner, scheduler } = await setup({
      timings: { waitingStageMs: 3_600_000, heartbeatMs: 3_600_000 },
    });
    // A society role is in no project; signals about one reach it outside projects.
    await board.addAgent(USER, { name: "stew-1", role: "steward", cli: "claude" });
    for (const title of ["a", "b", "c"]) {
      await board.createTask(USER, {
        project: "demo",
        title,
        stages: [{ name: "build", role: "engineer" }],
      });
    }
    await scheduler.tick();
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain(); // the first stages wake eng-1
    runner.dispatches.length = 0;
    // The operations pass runs on its own cadence: nothing until the interval elapses.
    expect((await board.listSignals()).map((s) => s.signal.kind)).toEqual([]);
    advance(5 * 60_000);
    await scheduler.tick();
    const signals = await board.listSignals();
    expect(signals.map((s) => [s.signal.kind, s.signal.key])).toEqual([
      ["backlog", "backlog:demo:engineer"],
    ]);
    expect(signals[0]?.signal.value).toBe(3);
    expect(scheduler.activeSignals).toEqual(["backlog:demo:engineer"]);
    expect(signals[0]?.signal.summary).toContain("demo: 3 current stage(s)");
    // The signal event wakes the steward after the debounce; the engineer is not charted for it.
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual(["stew-1/society"]);
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind, d.priority])).toEqual([
      ["stew-1", "ops_event", 0],
    ]);
    expect(runner.dispatches[0]?.trigger.reason).toContain("depth 3.0");
    // The condition persists but is not re-posted before the repeat window.
    advance(5 * 60_000);
    await scheduler.tick();
    expect(await board.listSignals()).toHaveLength(1);
    // Once the backlog clears the key is forgotten, so a recurrence posts at once.
    for (const task of await board.listTasks("demo")) {
      await board.updateTask(USER, { task_id: task.id, status: "abandoned" });
    }
    advance(5 * 60_000);
    await scheduler.tick();
    for (const title of ["d", "e", "f"]) {
      await board.createTask(USER, {
        project: "demo",
        title,
        stages: [{ name: "build", role: "engineer" }],
      });
    }
    advance(5 * 60_000);
    await scheduler.tick();
    expect((await board.listSignals()).map((s) => s.signal.kind)).toEqual(["backlog", "backlog"]);
  });

  it("signals role gaps, churn, unclosed threads, idle members, and missing capabilities", async () => {
    const { board, runner, scheduler } = await setup();
    const task = await board.createTask(USER, {
      project: "demo",
      title: "needs gpu",
      required_capabilities: ["gpu"],
      stages: [
        { name: "build", role: "engineer" },
        { name: "review", role: "reviewer", gate: true },
      ],
    });
    // Three participants, then silence: the topic has gone stale. The task's thread, as busy and
    // as quiet, is measured by its stages instead.
    const topic = await board.openThread(ENG, { channel: "demo/general", title: "gpu drivers" });
    for (const thread of [topic.id, task.id]) {
      for (const author of [ENG, REV, USER]) {
        await board.postMessage(author, { body: "hm", thread_id: thread });
      }
    }
    await board.retireAgent(USER, { name: "rev-1", reason: "test" });
    await board.claimTask(ENG, { task_id: task.id });
    await board.releaseTask(ENG, { task_id: task.id });
    await board.claimTask(ENG, { task_id: task.id });
    await board.releaseTask(ENG, { task_id: task.id });
    await board.claimTask(ENG, { task_id: task.id });
    // The review stage is now current, and its role has no active member.
    await board.advanceTask(ENG, { task_id: task.id });
    advance(3 * 24 * 3_600_000 + 5 * 60_000);
    await scheduler.tick();
    await scheduler.drain();
    const kinds = (await board.listSignals()).map((s) => [s.signal.kind, s.signal.key]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ["role_gap", "role_gap:demo:reviewer"],
        ["churn", `churn:${task.id}`],
        ["stale_thread", `stale_thread:${topic.id}`],
        ["blocked_capability", `blocked_capability:${task.id}`],
        ["idle_member", "idle_member:eng-1"],
      ]),
    );
    expect(kinds).not.toContainEqual(["stale_thread", `stale_thread:${task.id}`]);
    expect(kinds.map(([kind]) => kind)).not.toContain("backlog");
    // No steward is charted for signals here, so nobody woke on them; the retired reviewer never will.
    expect(runner.dispatches.map((d) => d.trigger.kind)).not.toContain("ops_event");
    expect(runner.dispatches.map((d) => d.agent)).not.toContain("rev-1");
    expect(scheduler.pendingCount).toBe(0);
  });

  it("signals a conflict copy left in a home past its age, without waking the steward", async () => {
    const { board, runner, scheduler } = await setup({ timings: { heartbeatMs: 3_600_000 } });
    await board.addAgent(USER, { name: "stew-1", role: "steward", cli: "claude" });
    // A runner's merge brought the copy into eng-1's home at this moment.
    const home = board.paths.agent("eng-1");
    const copy = "memory/core.md.conflict-0000ABCD";
    await writeFile(path.join(home, copy), "- three, as the lab saw it\n", "utf8");
    await run("git", ["add", "--all"], { cwd: home });
    await run(
      "git",
      ["-c", "user.name=eng-1", "-c", "user.email=eng-1@stellaris.local", "commit", "-qm", "turn"],
      { cwd: home, env: { ...process.env, GIT_COMMITTER_DATE: clock.toISOString() } },
    );
    const conflicts = async (): Promise<string[]> =>
      (await board.listSignals())
        .filter((record) => record.signal.kind === "home_conflict")
        .map((record) => record.signal.summary);

    advance(23 * 3_600_000);
    await scheduler.tick();
    expect(await conflicts()).toEqual([]);

    advance(3_600_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(await conflicts()).toEqual([
      `eng-1 (engineer) has not reconciled ${copy} in its home, the oldest copy waiting 24h`,
    ]);
    expect(scheduler.activeSignals).toContain("home_conflict:eng-1");
    advance(60_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => d.trigger.kind)).not.toContain("ops_event");

    // Reconciled: the condition clears, and nothing more is logged.
    await rm(path.join(home, copy));
    advance(5 * 60_000);
    await scheduler.tick();
    expect(scheduler.activeSignals).not.toContain("home_conflict:eng-1");
    expect(await conflicts()).toHaveLength(1);
  });

  it("measures a placed project's capabilities against its own runner", async () => {
    const { board, scheduler } = await setup();
    for (const [name, capabilities] of [
      ["gpu-box", ["gpu"]],
      ["laptop", []],
    ] as const) {
      await board.addRunner(USER, name);
      await board.markRunner(name, { status: "connected", clis: ["claude"], capabilities });
    }
    const task = await board.createTask(USER, {
      project: "demo",
      title: "needs gpu",
      required_capabilities: ["gpu"],
    });
    const blocked = async (): Promise<string[]> =>
      (await board.listSignals())
        .filter((record) => record.signal.key === `blocked_capability:${task.id}`)
        .map((record) => record.signal.summary);
    // Not placed yet: a connected runner offers it, so the project could still go there.
    await scheduler.tick();
    await scheduler.drain();
    expect(await blocked()).toEqual([]);
    // Placed on the laptop, its turns run there, and the laptop has no GPU.
    await board.placeProject("demo", "laptop");
    advance(6 * 60_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(await blocked()).toEqual([
      expect.stringContaining("which its project's runner laptop does not offer"),
    ]);
  });

  it("scales a role within its replica cap when the backlog per member reaches the threshold", async () => {
    const { board, runner, scheduler } = await setup({
      timings: { waitingStageMs: 3_600_000, heartbeatMs: 3_600_000 },
    });
    const build = [{ name: "build", role: "engineer" }];
    for (const title of ["a", "b", "c"]) {
      await board.createTask(USER, { project: "demo", title, stages: build });
    }
    advance(5 * 60_000);
    await scheduler.tick();
    expect((await board.listAgents()).map((a) => a.name)).not.toContain("eng-2");

    await board.setRoleCharter(USER, {
      ...(await board.readRole("engineer")),
      maxReplicas: 2,
      backlogThreshold: 3,
    });
    advance(5 * 60_000);
    await scheduler.tick();
    const replica = await board.readAgent("eng-2");
    expect(replica.role).toBe("engineer");
    expect(replica.memberships).toEqual(["demo"]);
    expect((await board.listSignals()).map((s) => s.signal.kind)).toEqual(["backlog", "scaled"]);
    // The replica's onboarding turn goes through the usual dispatch.
    await scheduler.tick();
    await scheduler.drain();
    expect(
      runner.dispatches.filter((d) => d.agent === "eng-2").map((d) => [d.agent, d.trigger.kind]),
    ).toEqual([["eng-2", "onboarding"]]);
    // The cap holds: three tasks over two engineers is under the threshold, and two is the cap anyway.
    for (const title of ["d", "e", "f", "g"]) {
      await board.createTask(USER, { project: "demo", title, stages: build });
    }
    advance(3_600_000 + 5 * 60_000);
    await scheduler.tick();
    expect((await board.listAgents()).map((a) => a.name)).not.toContain("eng-3");
  });

  it("wakes the front desk, a society role, on every user post, outside projects", async () => {
    const { board, runner, scheduler } = await setup({
      timings: { waitingStageMs: 3_600_000, heartbeatMs: 3_600_000 },
    });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toEqual([]); // no membership, so no onboarding turn yet

    // A user post without a mention wakes only the concierge, at user priority, at once.
    await board.postMessage(USER, {
      channel: "demo/general",
      body: "can someone add a health check?",
    });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.project, d.trigger.kind, d.priority])).toEqual([
      ["desk", "society", "user_post", 2],
    ]);
    expect(runner.dispatches[0]?.trigger.reason).toBe("the user posted in demo/general");

    // A citizen's post does not; the user's mention wakes both the citizen and the desk.
    runner.dispatches.length = 0;
    await board.postMessage(ENG, { channel: "demo/general", body: "on it" });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toEqual([]);
    await board.postMessage(USER, { channel: "demo/general", body: "@rev-1 please review" });
    await scheduler.tick();
    await scheduler.drain();
    expect(
      runner.dispatches
        .map((d) => `${d.agent}:${d.trigger.kind}`)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["desk:user_post", "rev-1:mention"]);

    // The front desk is a society role: it never joins a project, and answers every post,
    // in a society channel or a project's, outside projects.
    runner.dispatches.length = 0;
    await expect(board.joinProject(USER, { project: "demo", agent: "desk" })).rejects.toMatchObject(
      {
        code: "INVALID_STATE",
      },
    );
    await board.postMessage(USER, { channel: "general", body: "status?" });
    await scheduler.tick();
    await scheduler.drain();
    await board.postMessage(USER, { channel: "demo/general", body: "and the build?" });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.project, d.trigger.kind])).toEqual([
      ["desk", "society", "user_post"],
      ["desk", "society", "user_post"],
    ]);

    // The user's note on a step is the task's business: it wakes the stage, not the front desk.
    runner.dispatches.length = 0;
    const task = await board.createTask(USER, {
      project: "demo",
      title: "sign off",
      stages: [{ name: "draft", agent: "user" }, { name: "check" }],
    });
    await board.claimTask(USER, { task_id: task.id });
    await board.advanceTask(USER, { task_id: task.id, note: "Drafted; over to anyone." });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => d.trigger.kind)).not.toContain("user_post");
  });

  it("wakes a proposal's proposer when it is decided, and the decision wakes no front desk", async () => {
    const { board, runner, scheduler } = await setup();
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };
    const proposal = await board.propose(STEW, {
      kind: "channel",
      charter: { project: "demo", name: "ideas", purpose: "Loose ideas." },
    });
    await scheduler.tick();
    await scheduler.drain();
    runner.dispatches.length = 0;
    await board.approve(USER, { proposal_id: proposal.id, reason: "fine" });
    // The wake waits out the debounce, like a finished task's, so several decisions become one turn.
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual(["stew/society"]);
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.project, d.trigger.kind])).toEqual([
      ["stew", "society", "proposal_decided"],
    ]);
    expect(runner.dispatches[0]?.trigger.reason).toBe(
      `your channel proposal ${proposal.id} was approved by user`,
    );
  });

  it("drops a retired member's queued turn and keeps the queue across a restart", async () => {
    const { board, runner, scheduler } = await setup();
    await board.setPaused(USER, true);
    await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 and @rev-1 go" });
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual(["eng-1/demo", "rev-1/demo"]);
    await board.retireAgent(USER, { name: "rev-1", reason: "test" });
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual(["eng-1/demo"]);

    const restarted = new Scheduler({
      board,
      runner,
      now,
      timings: { debounceMs: 0, userDebounceMs: 0 },
    });
    await board.setPaused(USER, false);
    await restarted.tick();
    await restarted.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([["eng-1", "mention"]]);
  });
});
