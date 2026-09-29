import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board, type Actor } from "@stellaris/board-core";
import type { Name, TurnDispatch, TurnRecord, Ulid } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Scheduler, type TurnRunner } from "./scheduler.js";

const OWNER: Actor = { name: "owner", role: "owner" };
const ENG: Actor = { name: "eng-1", role: "engineer" };
const REV: Actor = { name: "rev-1", role: "reviewer" };

class FakeRunner implements TurnRunner {
  readonly dispatches: TurnDispatch[] = [];
  readonly merges: Array<{ project: Name; taskId: Ulid }> = [];
  private release: (() => void) | null = null;
  hold = false;

  /** With a board, turns are recorded like the real runner does, on the injected clock. */
  constructor(
    private readonly board: Board | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runTurn(dispatch: TurnDispatch): Promise<TurnRecord> {
    this.dispatches.push(dispatch);
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    const record: TurnRecord = {
      agent: dispatch.agent,
      project: dispatch.project,
      runner: "local",
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
    this.release?.();
    this.release = null;
  }

  async mergeTask(project: Name, taskId: Ulid): Promise<void> {
    this.merges.push({ project, taskId });
  }
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
    await board.addProject(OWNER, { slug: "demo" });
    await board.addAgent(OWNER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    await board.addAgent(OWNER, {
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
        ownerDebounceMs: 0,
        heartbeatMs: 10_000,
        unclaimedTaskMs: 5_000,
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
    await board.addProject(OWNER, { slug: "demo" });
    await board.addAgent(OWNER, {
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

  it("dispatches owner mentions immediately and debounces agent mentions", async () => {
    const { board, runner, scheduler } = await setup();
    await board.postMessage(OWNER, { channel: "demo/general", body: "@eng-1 please start" });
    await scheduler.tick();
    await scheduler.drain();
    expect(
      runner.dispatches.map((d) => [d.agent, d.trigger.kind, d.trigger.fromOwner, d.priority]),
    ).toEqual([["eng-1", "mention", true, 2]]);

    await board.postMessage(ENG, { channel: "demo/general", body: "@rev-1 could you look?" });
    await scheduler.tick();
    expect(runner.dispatches).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(1);
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.at(-1)?.agent).toBe("rev-1");
    expect(runner.dispatches.at(-1)?.trigger.fromOwner).toBe(false);
  });

  it("holds dispatches while paused and releases them on resume", async () => {
    const { board, runner, scheduler } = await setup();
    await board.setPaused(OWNER, true);
    await board.postMessage(OWNER, { channel: "demo/general", body: "@eng-1 wait" });
    await scheduler.tick();
    expect(runner.dispatches).toHaveLength(0);
    expect(scheduler.pendingCount).toBe(1);
    await board.setPaused(OWNER, false);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toHaveLength(1);
  });

  it("respects the concurrency cap and never runs one pair twice at once", async () => {
    const { board, runner, scheduler } = await setup({ concurrency: 1 });
    runner.hold = true;
    await board.postMessage(OWNER, { channel: "demo/general", body: "@eng-1 and @rev-1 go" });
    await scheduler.tick();
    expect(scheduler.runningCount).toBe(1);
    expect(scheduler.pendingCount).toBe(1);
    await board.postMessage(OWNER, { channel: "demo/general", body: "@eng-1 again" });
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

  it("wakes reviewers on submission, merges and wakes the claimer on approval", async () => {
    const { board, runner, scheduler } = await setup();
    const task = await board.createTask(OWNER, { project: "demo", title: "t" });
    await board.claimTask(ENG, { task_id: task.id });
    await board.updateTask(ENG, { task_id: task.id, status: "in_review" });
    await scheduler.tick();
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind, d.trigger.taskId])).toEqual([
      ["rev-1", "claim_event", task.id],
    ]);
    await board.updateTask(REV, { task_id: task.id, status: "done" });
    await scheduler.tick();
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.merges).toEqual([{ project: "demo", taskId: task.id }]);
    expect(runner.dispatches.at(-1)?.agent).toBe("eng-1");
    expect(runner.dispatches.at(-1)?.trigger.reason).toBe("task approved");
  });

  it("wakes engineers once for a task left unclaimed past the threshold", async () => {
    const { board, runner, scheduler } = await setup();
    await board.createTask(OWNER, { project: "demo", title: "nobody took me" });
    await scheduler.tick();
    expect(scheduler.pendingCount).toBe(0);
    advance(5_000);
    await scheduler.tick();
    advance(1_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([
      ["eng-1", "unclaimed_task"],
    ]);
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toHaveLength(1);
  });

  it("wakes on heartbeat only when there is something to read or hold", async () => {
    const { board, runner, scheduler } = await setup();
    advance(10_000);
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toHaveLength(0);
    await board.postMessage(OWNER, { channel: "demo/dev", body: "no mention, just news" });
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

  it("schedules a reflection turn per cadence, only after new work, in the scope of that work", async () => {
    const { board, runner, scheduler } = await setup({
      timings: { reflectionMs: 60_000, heartbeatMs: 3_600_000, unclaimedTaskMs: 3_600_000 },
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
    await board.requestWake(OWNER, { agent: "eng-1", project: "demo", reason: "work" });
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
    // A reflection requested ahead of the cadence dispatches at once, at owner priority, and restarts the clock.
    await board.requestWake(OWNER, {
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
    // A role that does not reflect never gets one: the owner's charter says so, and it has no CLI anyway.
    const state = await board.readState(
      "scheduler",
      z.object({ lastReflection: z.record(z.string(), z.string()) }),
      { lastReflection: {} },
    );
    expect(Object.keys(state.lastReflection).toSorted()).toEqual(["eng-1", "rev-1"]);
  });

  it("manual wakes go through the same dispatch", async () => {
    const { board, runner, scheduler } = await setup();
    await board.requestWake(OWNER, { agent: "rev-1", project: "demo", reason: "dev" });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind, d.priority])).toEqual([
      ["rev-1", "manual", 2],
    ]);
  });

  it("publishes a backlog signal and wakes the steward on it, once per condition", async () => {
    const { board, runner, scheduler } = await setup({
      timings: { unclaimedTaskMs: 3_600_000, heartbeatMs: 3_600_000 },
    });
    await board.addAgent(OWNER, {
      name: "stew-1",
      role: "steward",
      cli: "claude",
      memberships: ["demo"],
    });
    await scheduler.tick();
    await scheduler.drain(); // stew-1 onboarding
    runner.dispatches.length = 0;
    for (const title of ["a", "b", "c"]) {
      await board.createTask(OWNER, { project: "demo", title });
    }
    // The operations pass runs on its own cadence: nothing until the interval elapses.
    await scheduler.tick();
    expect((await board.listSignals()).map((s) => s.signal.kind)).toEqual([]);
    advance(5 * 60_000);
    await scheduler.tick();
    const signals = await board.listSignals();
    expect(signals.map((s) => [s.signal.kind, s.signal.key])).toEqual([
      ["backlog", "backlog:demo:engineer"],
    ]);
    expect(signals[0]?.signal.value).toBe(3);
    expect((await board.listChannel("ops")).at(-1)?.body).toContain("**backlog** demo: 3 open");
    // The signal event wakes the steward after the debounce; the engineer is not charted for it.
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual(["stew-1/demo"]);
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
      await board.updateTask(OWNER, { task_id: task.id, status: "abandoned" });
    }
    advance(5 * 60_000);
    await scheduler.tick();
    await board.createTask(OWNER, { project: "demo", title: "d" });
    await board.createTask(OWNER, { project: "demo", title: "e" });
    await board.createTask(OWNER, { project: "demo", title: "f" });
    advance(5 * 60_000);
    await scheduler.tick();
    expect((await board.listSignals()).map((s) => s.signal.kind)).toEqual(["backlog", "backlog"]);
  });

  it("signals role gaps, churn, unclosed threads, idle members, and missing capabilities", async () => {
    const { board, runner, scheduler } = await setup();
    await board.retireAgent(OWNER, { name: "rev-1", reason: "test" });
    const task = await board.createTask(OWNER, {
      project: "demo",
      title: "needs gpu",
      required_capabilities: ["gpu"],
    });
    await board.claimTask(ENG, { task_id: task.id });
    await board.releaseTask(ENG, { task_id: task.id });
    await board.claimTask(ENG, { task_id: task.id });
    await board.releaseTask(ENG, { task_id: task.id });
    await board.claimTask(ENG, { task_id: task.id });
    await board.updateTask(ENG, { task_id: task.id, status: "in_review" });
    const closed = await board.createTask(OWNER, { project: "demo", title: "done but open" });
    await board.openThread(ENG, { task_id: closed.id });
    await board.claimTask(ENG, { task_id: closed.id });
    await board.updateTask(ENG, { task_id: closed.id, status: "abandoned" });
    advance(3 * 24 * 3_600_000 + 5 * 60_000);
    await scheduler.tick();
    await scheduler.drain();
    const kinds = (await board.listSignals()).map((s) => [s.signal.kind, s.signal.key]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ["role_gap", "role_gap:demo:reviewer"],
        ["churn", `churn:${task.id}`],
        ["stale_thread", `stale_thread:${closed.id}`],
        ["blocked_capability", `blocked_capability:${task.id}`],
        ["idle_member", "idle_member:eng-1"],
      ]),
    );
    expect(kinds.map(([kind]) => kind)).not.toContain("backlog");
    // No steward is charted for signals here, so nobody woke on them; the retired reviewer never will.
    expect(runner.dispatches.map((d) => d.trigger.kind)).not.toContain("ops_event");
    expect(runner.dispatches.map((d) => d.agent)).not.toContain("rev-1");
    expect(scheduler.pendingCount).toBe(0);
  });

  it("scales a role within its replica cap when the backlog per member reaches the threshold", async () => {
    const { board, runner, scheduler } = await setup({
      timings: { unclaimedTaskMs: 3_600_000, heartbeatMs: 3_600_000 },
    });
    for (const title of ["a", "b", "c"]) {
      await board.createTask(OWNER, { project: "demo", title });
    }
    advance(5 * 60_000);
    await scheduler.tick();
    expect((await board.listAgents()).map((a) => a.name)).not.toContain("eng-2");

    await board.setRoleCharter(OWNER, {
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
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([
      ["eng-2", "onboarding"],
    ]);
    // The cap holds: three tasks over two engineers is under the threshold, and two is the cap anyway.
    for (const title of ["d", "e", "f", "g"]) {
      await board.createTask(OWNER, { project: "demo", title });
    }
    advance(3_600_000 + 5 * 60_000);
    await scheduler.tick();
    expect((await board.listAgents()).map((a) => a.name)).not.toContain("eng-3");
  });

  it("wakes the front desk on every owner post, in the society scope until it joins a project", async () => {
    const { board, runner, scheduler } = await setup({
      timings: { unclaimedTaskMs: 3_600_000, heartbeatMs: 3_600_000 },
    });
    await board.addAgent(OWNER, { name: "desk", role: "concierge", cli: "claude" });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toEqual([]); // no membership, so no onboarding turn yet

    // An owner post without a mention wakes only the concierge, at owner priority, at once.
    await board.postMessage(OWNER, {
      channel: "demo/general",
      body: "can someone add a health check?",
    });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.project, d.trigger.kind, d.priority])).toEqual([
      ["desk", "society", "owner_post", 2],
    ]);
    expect(runner.dispatches[0]?.trigger.reason).toBe("the owner posted in demo/general");

    // A citizen's post does not; the owner's mention wakes both the citizen and the desk.
    runner.dispatches.length = 0;
    await board.postMessage(ENG, { channel: "demo/general", body: "on it" });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches).toEqual([]);
    await board.postMessage(OWNER, { channel: "demo/general", body: "@rev-1 please review" });
    await scheduler.tick();
    await scheduler.drain();
    expect(
      runner.dispatches
        .map((d) => `${d.agent}:${d.trigger.kind}`)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["desk:owner_post", "rev-1:mention"]);

    // Joining a project fires an onboarding turn there, and later posts route to that project.
    runner.dispatches.length = 0;
    await board.joinProject(OWNER, { project: "demo", agent: "desk" });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.project, d.trigger.kind])).toEqual([
      ["desk", "demo", "onboarding"],
    ]);
    runner.dispatches.length = 0;
    await board.postMessage(OWNER, { channel: "general", body: "status?" });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.project, d.trigger.kind])).toEqual([
      ["desk", "demo", "owner_post"],
    ]);
  });

  it("drops a retired member's queued turn and keeps the queue across a restart", async () => {
    const { board, runner, scheduler } = await setup();
    await board.setPaused(OWNER, true);
    await board.postMessage(OWNER, { channel: "demo/general", body: "@eng-1 and @rev-1 go" });
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual(["eng-1/demo", "rev-1/demo"]);
    await board.retireAgent(OWNER, { name: "rev-1", reason: "test" });
    await scheduler.tick();
    expect(scheduler.pendingPairs).toEqual(["eng-1/demo"]);

    const restarted = new Scheduler({
      board,
      runner,
      now,
      timings: { debounceMs: 0, ownerDebounceMs: 0 },
    });
    await board.setPaused(OWNER, false);
    await restarted.tick();
    await restarted.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind])).toEqual([["eng-1", "mention"]]);
  });
});
