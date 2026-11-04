import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { Scheduler } from "@stellaris/scheduler";
import { ZERO_USAGE, type AgentBackend } from "@stellaris/runner-core";
import type { CliKind } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestSociety, type TestSociety } from "./testing/harness.js";
import { addWorkRoles, USER } from "./testing/scripted-backend.js";

describe("pausing a runner, or one CLI on it", () => {
  let dir: string;
  let society: TestSociety | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-pause-test-"));
  });

  afterEach(async () => {
    await society?.stop();
    society = null;
    await rm(dir, { recursive: true, force: true });
  });

  it("holds the turns it covers in the queue while other runners and CLIs work, and runs them on resume", async () => {
    const { board, userToken } = await Board.init(dir, { name: "pauses" });
    await addWorkRoles(board);
    for (const slug of ["lab", "yard"]) {
      await board.addProject(USER, { slug });
    }
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["lab"],
    });
    await board.addAgent(USER, {
      name: "rev-1",
      role: "reviewer",
      cli: "codex",
      memberships: ["lab"],
    });
    await board.addAgent(USER, {
      name: "eng-2",
      role: "engineer",
      cli: "claude",
      memberships: ["yard"],
    });

    // Every turn says who ran it and where; one may be held open until the test lets it end.
    const ran: string[] = [];
    const gates = new Map<string, PromiseWithResolvers<void>>();
    const backend = (kind: CliKind): AgentBackend => ({
      kind,
      newSession: () => Promise.resolve(`session-${ran.length}`),
      runTurn: async (request) => {
        ran.push(`${request.spec.agent}@${request.spec.runner}`);
        await gates.get(request.spec.agent)?.promise;
        return {
          events: [],
          finalText: "done",
          usage: ZERO_USAGE,
          costUsd: 0,
          status: {
            summary: "done",
            claimsHeld: [],
            blockedOn: [],
            needsUserDecision: false,
            memoryUpdated: false,
          },
          exitReason: "completed",
        };
      },
    });
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({ claude: backend("claude"), codex: backend("codex") }),
      extraRunners: [{ name: "far", backends: () => ({ claude: backend("claude") }) }],
    });
    await board.placeProject("lab", "pod");
    await board.placeProject("yard", "far");
    const timings = { debounceMs: 0, userDebounceMs: 0, heartbeatMs: 3_600_000 };
    // Room for every citizen's turn at once, so only a pause holds one back.
    let scheduler = new Scheduler({ board, runner: society.hub, timings, concurrency: 4 });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };
    const wake = (agent: string, project: string): Promise<unknown> =>
      board.requestWake(USER, { agent, project, reason: "work" });
    await settle();
    expect(ran.toSorted()).toEqual(["eng-1@pod", "eng-2@far", "rev-1@pod"]);
    ran.length = 0;

    // The user pauses pod through the API: while eng-2's turn runs on far, pod takes nothing.
    const { app } = society;
    const post = async (route: string): Promise<Response> =>
      app.request(`/api/runners/${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${userToken}` },
      });
    expect((await post("pod/pause")).status).toBe(200);
    const far = Promise.withResolvers<void>();
    gates.set("eng-2", far);
    await wake("eng-1", "lab");
    await wake("rev-1", "lab");
    await wake("eng-2", "yard");
    await scheduler.tick();
    await expect.poll(() => ran).toEqual(["eng-2@far"]);
    for (let i = 0; i < 3; i += 1) {
      await scheduler.tick();
    }
    expect(ran).toEqual(["eng-2@far"]);
    far.resolve();
    await scheduler.drain();

    // Claude alone paused on pod: rev-1's Codex turn runs there, eng-1's Claude turn waits.
    expect((await post("pod/pause/claude")).status).toBe(200);
    expect((await post("pod/resume")).status).toBe(200);
    await settle();
    expect(ran).toEqual(["eng-2@far", "rev-1@pod"]);

    // The kept wake outlives the scheduler, and a scheduler started afresh holds it too.
    await scheduler.stop();
    scheduler = new Scheduler({ board, runner: society.hub, timings, concurrency: 4 });
    await settle();
    expect(ran).toEqual(["eng-2@far", "rev-1@pod"]);

    // Resumed, the kept wake runs, as the wake it was.
    expect((await post("pod/resume/claude")).status).toBe(200);
    await settle();
    expect(ran).toEqual(["eng-2@far", "rev-1@pod", "eng-1@pod"]);
    const latest = await board.readLatestTurn("eng-1", "lab");
    expect(latest?.trigger).toMatchObject({ kind: "manual", reason: "work" });
    // Nothing reached a runner while held, so nothing failed or was refused there.
    const failed = (await board.readEvents(null, 1000)).filter(
      (event) => event.type === "turn.failed",
    );
    expect(failed).toEqual([]);
    const refused = (await board.listSignals(1000)).filter(
      (record) => record.signal.kind === "turn_refused",
    );
    expect(refused).toEqual([]);
    await scheduler.stop();
  });

  it("keeps a citizen pinned to a runner its CLI is paused on, and places no new project there", async () => {
    const { board } = await Board.init(dir, { name: "pauses" });
    await addWorkRoles(board);
    await board.addProject(USER, { slug: "fresh" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["fresh"],
    });
    const ran: string[] = [];
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve(`session-${ran.length}`),
      runTurn: (request) => {
        ran.push(`${request.spec.agent}@${request.spec.runner}`);
        return Promise.resolve({
          events: [],
          finalText: "done",
          usage: ZERO_USAGE,
          costUsd: 0,
          status: {
            summary: "done",
            claimsHeld: [],
            blockedOn: [],
            needsUserDecision: false,
            memoryUpdated: false,
          },
          exitReason: "completed",
        });
      },
    };
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({ claude: backend }),
      extraRunners: [{ name: "far", backends: () => ({ claude: backend }) }],
    });
    for (const name of ["stew", "eng-1"]) {
      await board.setAgentRunner(USER, name, "pod");
    }
    await board.setRunnerPaused(USER, "pod", { paused: true, cli: "claude" });
    const scheduler = new Scheduler({
      board,
      runner: society.hub,
      timings: { debounceMs: 0, userDebounceMs: 0, heartbeatMs: 3_600_000 },
      concurrency: 4,
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };
    await board.requestWake(USER, { agent: "stew", project: "society", reason: "work" });
    await settle();
    // eng-1's first turn in fresh places it, on far, since its own runner takes no Claude turns.
    expect(ran).toEqual(["eng-1@far"]);
    expect((await board.readProject("fresh")).runner).toBe("far");
    // stew's work outside projects waits where it is pinned, rather than moving.
    await settle();
    expect(ran).toEqual(["eng-1@far"]);
    expect((await board.readAgent("stew")).homeRunner).toBe("pod");

    await board.setRunnerPaused(USER, "pod", { paused: false, cli: "claude" });
    await settle();
    expect(ran).toEqual(["eng-1@far", "stew@pod"]);
    await scheduler.stop();
  });

  it("is the user's alone to pause or resume, and only for a CLI there is", async () => {
    const { board, userToken } = await Board.init(dir, { name: "pauses" });
    await addWorkRoles(board);
    await board.addProject(USER, { slug: "lab" });
    const { token } = await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["lab"],
    });
    society = await startTestSociety({ board, runnerName: "pod", backends: () => ({}) });
    const { app } = society;
    const post = async (route: string, bearer: string): Promise<number> =>
      (
        await app.request(`/api/runners/${route}`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
        })
      ).status;
    for (const route of ["pod/pause", "pod/pause/claude", "pod/resume", "pod/resume/claude"]) {
      expect(await post(route, token)).toBe(403);
    }
    expect(await post("pod/pause/gemini", userToken)).toBe(400);
    expect(await post("ghost/pause", userToken)).toBe(404);
    expect((await board.readRunner("pod")).paused).toBeUndefined();
    expect((await board.readRunner("pod")).pausedClis).toBeUndefined();
  });
});
