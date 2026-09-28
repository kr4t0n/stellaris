import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board, type Actor } from "@stellaris/board-core";
import type { Name, TurnDispatch, TurnRecord, Ulid } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Scheduler, type TurnRunner } from "./scheduler.js";

const OWNER: Actor = { name: "owner", role: "owner" };
const ENG: Actor = { name: "eng-1", role: "engineer" };
const REV: Actor = { name: "rev-1", role: "reviewer" };

class FakeRunner implements TurnRunner {
  readonly dispatches: TurnDispatch[] = [];
  readonly merges: Array<{ project: Name; taskId: Ulid }> = [];
  private release: (() => void) | null = null;
  hold = false;

  async runTurn(dispatch: TurnDispatch): Promise<TurnRecord> {
    this.dispatches.push(dispatch);
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return {
      agent: dispatch.agent,
      project: dispatch.project,
      runner: "local",
      cli: "claude",
      session: "s",
      trigger: dispatch.trigger,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitReason: "completed",
      status: null,
      error: null,
      usage: null,
      costUsd: 0,
      toolCalls: 0,
    };
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

  async function setup(options: { concurrency?: number } = {}) {
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
    const runner = new FakeRunner();
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

  it("manual wakes go through the same dispatch", async () => {
    const { board, runner, scheduler } = await setup();
    await board.requestWake(OWNER, { agent: "rev-1", project: "demo", reason: "dev" });
    await scheduler.tick();
    await scheduler.drain();
    expect(runner.dispatches.map((d) => [d.agent, d.trigger.kind, d.priority])).toEqual([
      ["rev-1", "manual", 2],
    ]);
  });
});
