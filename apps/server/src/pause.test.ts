import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { Scheduler } from "@stellaris/scheduler";
import { ZERO_USAGE, type AgentBackend } from "@stellaris/runner-core";
import { CliQuotaSchema, type CliKind, type CliQuota } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestSociety, TURN_START_WAIT, type TestSociety } from "./testing/harness.js";
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
    await expect.poll(() => ran, TURN_START_WAIT).toEqual(["eng-2@far"]);
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

describe("holding a CLI while its limit lasts", () => {
  let dir: string;
  let society: TestSociety | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-limit-test-"));
  });

  afterEach(async () => {
    await society?.stop();
    society = null;
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A society on one clock with `engineers` citizens on Claude (eng-1, eng-2, …) and rev-1 on Codex
   * in a project living on pod, and a scheduler over its hub that runs `concurrency` turns at once.
   * Every turn says who ran it; Claude's quota reads answer as `read` says, and a Claude turn is
   * refused for the plan's limit, reporting it with no reset, while `refusing` says so.
   */
  async function limitedSociety(
    options: {
      read?: () => Promise<CliQuota>;
      engineers?: number;
      concurrency?: number;
      refusing?: () => boolean;
    } = {},
  ) {
    const { read, refusing } = options;
    let clock = Date.parse("2026-11-04T08:00:00.000Z");
    const now = (): Date => new Date(clock);
    const { board, userToken } = await Board.init(dir, { name: "limits" }, { now });
    await addWorkRoles(board);
    await board.addProject(USER, { slug: "lab" });
    const engineers = Array.from({ length: options.engineers ?? 1 }, (_, i) => `eng-${i + 1}`);
    for (const name of engineers) {
      await board.addAgent(USER, { name, role: "engineer", cli: "claude", memberships: ["lab"] });
    }
    await board.addAgent(USER, {
      name: "rev-1",
      role: "reviewer",
      cli: "codex",
      memberships: ["lab"],
    });
    const ran: string[] = [];
    const backend = (kind: CliKind): AgentBackend => ({
      kind,
      newSession: () => Promise.resolve(`session-${ran.length}`),
      runTurn: (request) => {
        ran.push(`${request.spec.agent}@${request.spec.runner}`);
        if (kind === "claude" && refusing?.() === true) {
          return Promise.resolve({
            events: [],
            finalText: "",
            usage: ZERO_USAGE,
            costUsd: 0,
            status: null,
            exitReason: "error",
            error: "usage limit reached: You've hit your limit",
            quota: CliQuotaSchema.parse({
              observedAt: now().toISOString(),
              source: "turn",
              status: "limited",
            }),
          });
        }
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
      ...(kind === "claude" && read !== undefined ? { readQuota: read } : {}),
    });
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({ claude: backend("claude"), codex: backend("codex") }),
      now,
      hubNow: now,
    });
    await board.placeProject("lab", "pod");
    const scheduler = new Scheduler({
      board,
      runner: society.hub,
      now,
      timings: { debounceMs: 0, userDebounceMs: 0, heartbeatMs: 24 * 3_600_000 },
      concurrency: options.concurrency ?? 4,
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };
    await settle();
    expect(ran.toSorted()).toEqual([...engineers, "rev-1"].map((name) => `${name}@pod`));
    ran.length = 0;
    return {
      board,
      app: society.app,
      userToken,
      scheduler,
      settle,
      ran,
      now,
      advance: (ms: number): void => {
        clock += ms;
      },
      wake: (agent: string): Promise<unknown> =>
        board.requestWake(USER, { agent, project: "lab", reason: "work" }),
      limit: (limitedUntil: string | null): Promise<unknown> =>
        board.recordQuota(
          "pod",
          "claude",
          CliQuotaSchema.parse({
            observedAt: now().toISOString(),
            source: "turn",
            status: "limited",
            limitedUntil,
          }),
        ),
    };
  }

  it("starts none of a limited CLI's turns before its reset, and the kept wake at the reset with nobody acting", async () => {
    const { board, app, userToken, scheduler, settle, ran, now, advance, wake, limit } =
      await limitedSociety();
    const reset = new Date(now().getTime() + 2 * 3_600_000);
    await limit(reset.toISOString());
    await wake("eng-1");
    await wake("rev-1");
    await settle();
    // Codex on the same runner goes on; Claude's turn waits.
    expect(ran).toEqual(["rev-1@pod"]);

    // The user's pause and resume of Claude there leave the limit's hold as it was, and the limit
    // never sets or clears the user's pause.
    const post = async (route: string): Promise<number> =>
      (
        await app.request(`/api/runners/${route}`, {
          method: "POST",
          headers: { authorization: `Bearer ${userToken}` },
        })
      ).status;
    expect(await post("pod/pause/claude")).toBe(200);
    expect(await post("pod/resume/claude")).toBe(200);
    expect((await board.readRunner("pod")).pausedClis).toBeUndefined();
    advance(reset.getTime() - 1 - now().getTime());
    await settle();
    expect(ran).toEqual(["rev-1@pod"]);

    // At the reset the next pass sends the kept wake, as the wake it was.
    advance(1);
    await settle();
    expect(ran).toEqual(["rev-1@pod", "eng-1@pod"]);
    const latest = await board.readLatestTurn("eng-1", "lab");
    expect(latest?.trigger).toMatchObject({ kind: "manual", reason: "work" });
    const failed = (await board.readEvents(null, 1000)).filter(
      (event) => event.type === "turn.failed",
    );
    expect(failed).toEqual([]);
    await scheduler.stop();
  });

  it("holds a limit with no reset for half an hour, reading the quota once while a turn waits", async () => {
    // The first read fails; the next names a reset two hours on; the last finds the limit gone.
    const answers: Array<() => CliQuota> = [
      () => {
        throw new Error("the usage endpoint did not answer");
      },
    ];
    const reads: string[] = [];
    const { board, scheduler, settle, ran, now, advance, wake, limit } = await limitedSociety({
      read: () => {
        reads.push(now().toISOString());
        const answer = answers.shift();
        return answer === undefined
          ? Promise.reject(new Error("no answer"))
          : Promise.resolve().then(answer);
      },
    });
    const started = now().getTime();
    await limit(null);
    await wake("eng-1");
    await settle();
    expect(ran).toEqual([]);
    await expect.poll(() => reads.length).toBe(1);

    // The failed read changes nothing, and none is asked again within the half hour.
    advance(30 * 60_000 - 1);
    await settle();
    await settle();
    expect(ran).toEqual([]);
    expect(reads).toHaveLength(1);

    // Half an hour after the report the turn goes, and its report would say what it met.
    advance(1);
    await settle();
    expect(ran).toEqual(["eng-1@pod"]);

    // Limited again with no reset: the read names one two hours on, which holds the turn past the
    // half hour.
    const reset = new Date(now().getTime() + 2 * 3_600_000).toISOString();
    answers.push(() =>
      CliQuotaSchema.parse({
        observedAt: now().toISOString(),
        source: "read",
        status: "limited",
        limitedUntil: reset,
      }),
    );
    await limit(null);
    await wake("eng-1");
    await settle();
    await expect.poll(() => reads.length).toBe(2);
    await expect
      .poll(async () => (await board.readRunner("pod")).quotas?.claude?.limitedUntil)
      .toBe(reset);
    advance(31 * 60_000);
    await settle();
    expect(ran).toEqual(["eng-1@pod"]);
    expect(reads).toHaveLength(2);

    // Limited once more with no reset, a read that finds the limit gone lifts the hold at once.
    answers.push(() =>
      CliQuotaSchema.parse({ observedAt: now().toISOString(), source: "read", status: "allowed" }),
    );
    advance(Date.parse(reset) - now().getTime());
    await limit(null);
    await settle();
    await expect.poll(() => reads.length).toBe(3);
    await expect
      .poll(async () => (await board.readRunner("pod")).quotas?.claude?.status)
      .toBe("allowed");
    await settle();
    expect(ran).toEqual(["eng-1@pod", "eng-1@pod"]);
    expect(reads.map((at) => Date.parse(at) - started)).toEqual([
      0,
      30 * 60_000,
      30 * 60_000 + 2 * 3_600_000,
    ]);

    // While the user's pause holds Claude there too, nothing is read; resumed, a waiting turn's
    // limit is read again, the half hour since the last read being over.
    answers.push(() =>
      CliQuotaSchema.parse({ observedAt: now().toISOString(), source: "read", status: "allowed" }),
    );
    await board.setRunnerPaused(USER, "pod", { paused: true, cli: "claude" });
    advance(31 * 60_000);
    await limit(null);
    await wake("eng-1");
    await settle();
    await settle();
    expect(reads).toHaveLength(3);
    await board.setRunnerPaused(USER, "pod", { paused: false, cli: "claude" });
    await settle();
    await expect.poll(() => reads.length).toBe(4);
    await expect
      .poll(async () => (await board.readRunner("pod")).quotas?.claude?.status)
      .toBe("allowed");
    await settle();
    expect(ran).toEqual(["eng-1@pod", "eng-1@pod", "eng-1@pod"]);
    await scheduler.stop();
  });

  it("lets one turn try a limit with no reset once its half hour is over, and the rest go by what it met", async () => {
    // Four citizens wait on Claude, with nothing capping the turns at once, as on a server and a
    // runner left at their defaults.
    let refusing = false;
    const { board, scheduler, settle, ran, advance, wake, limit } = await limitedSociety({
      engineers: 4,
      concurrency: Number.POSITIVE_INFINITY,
      refusing: () => refusing,
    });
    refusing = true;
    const refused = async (): Promise<number> =>
      (await board.readEvents(null, 2000)).filter((event) => event.type === "turn.failed").length;
    await limit(null);
    for (const name of ["eng-1", "eng-2", "eng-3", "eng-4"]) {
      await wake(name);
    }
    await settle();
    expect(ran).toEqual([]);

    // At the half hour one turn goes; the limit refuses it and holds the rest another half hour.
    advance(30 * 60_000);
    await settle();
    await settle();
    expect(ran).toHaveLength(1);
    expect(await refused()).toBe(1);
    advance(30 * 60_000 - 1);
    await settle();
    expect(ran).toHaveLength(1);

    // At the next half hour one turn tries again, and once it has run the other two go together.
    // The refused turn's wake, a manual one, went with it, as any failed turn's does.
    refusing = false;
    advance(1);
    await settle();
    expect(ran).toHaveLength(2);
    await settle();
    expect(ran.toSorted()).toEqual(
      ["eng-1", "eng-2", "eng-3", "eng-4"].map((name) => `${name}@pod`),
    );
    expect(await refused()).toBe(1);
    await scheduler.stop();
  });
});

describe("holding one pool of a CLI's models while its limit lasts", () => {
  let dir: string;
  let society: TestSociety | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-pool-test-"));
  });

  afterEach(async () => {
    await society?.stop();
    society = null;
    await rm(dir, { recursive: true, force: true });
  });

  /** The models the fake service meters in Antigravity's third-party pool. */
  const THIRD_PARTY_MODELS: ReadonlySet<string> = new Set(["claude-sonnet-4-6", "gpt-oss-120b"]);

  /**
   * A society on one clock from `start`, in a project on pod with `citizens`, and a scheduler over
   * its hub. Every turn says who ran it. An Antigravity turn on a third-party model is refused for
   * that pool while `refusing` says so, reporting what the adapter reports for agy's words, with
   * the pool limited until `limitedUntil` gives from the refusal's time, null for a countdown that
   * doesn't read. Antigravity's quota reads answer as `read` says.
   */
  async function poolSociety(options: {
    start: string;
    citizens: readonly { name: string; cli: CliKind; model?: string }[];
    refusing: () => boolean;
    limitedUntil: (at: Date) => string | null;
    read?: () => Promise<CliQuota>;
  }) {
    let clock = Date.parse(options.start);
    const now = (): Date => new Date(clock);
    const { board } = await Board.init(dir, { name: "pools" }, { now });
    await addWorkRoles(board);
    await board.addProject(USER, { slug: "lab" });
    for (const citizen of options.citizens) {
      await board.addAgent(USER, { ...citizen, role: "engineer", memberships: ["lab"] });
    }
    const ran: string[] = [];
    const backend = (kind: CliKind): AgentBackend => ({
      kind,
      newSession: () => Promise.resolve(`session-${ran.length}`),
      runTurn: (request) => {
        ran.push(request.spec.agent);
        if (
          kind === "antigravity" &&
          options.refusing() &&
          THIRD_PARTY_MODELS.has(request.spec.model ?? "")
        ) {
          const observedAt = now().toISOString();
          return Promise.resolve({
            events: [],
            finalText: "",
            usage: ZERO_USAGE,
            costUsd: 0,
            status: null,
            exitReason: "error",
            error:
              "usage limit reached: Third-party quota reached. Please switch to Gemini models or upgrade your subscription to increase your limits. Resets in 3h49m54s.",
            quota: CliQuotaSchema.parse({
              observedAt,
              source: "turn",
              status: "warning",
              pools: [
                { key: "3p", limited: true, limitedUntil: options.limitedUntil(now()), observedAt },
              ],
            }),
          });
        }
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
      ...(kind === "antigravity" && options.read !== undefined ? { readQuota: options.read } : {}),
    });
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({
        claude: backend("claude"),
        codex: backend("codex"),
        antigravity: backend("antigravity"),
      }),
      now,
      hubNow: now,
    });
    await board.placeProject("lab", "pod");
    const scheduler = new Scheduler({
      board,
      runner: society.hub,
      now,
      timings: { debounceMs: 0, userDebounceMs: 0, heartbeatMs: 24 * 3_600_000 },
      concurrency: 8,
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };
    // The onboarding turns go through the backend too, so `refusing` is to be set after this.
    await settle();
    expect(ran.toSorted()).toEqual(options.citizens.map(({ name }) => name).toSorted());
    ran.length = 0;
    return {
      board,
      scheduler,
      settle,
      ran,
      now,
      advance: (ms: number): void => {
        clock += ms;
      },
      wake: (agent: string): Promise<unknown> =>
        board.requestWake(USER, { agent, project: "lab", reason: "work" }),
    };
  }

  /**
   * A runner's login on 2026-11-26: a citizen's turn on a Claude model through Antigravity was
   * refused for the third-party pool's quota, and its next turn, on a Gemini model, ran. Here three
   * Antigravity citizens (one on a Claude model, one on a Gemini model, one with none set), one on
   * Claude Code with a model set, and one on Codex.
   */
  it("holds the refused pool's turns until its reset while the other pool's and other CLIs' run", async () => {
    let refusing = false;
    const citizens = [
      { name: "eng-1", cli: "antigravity", model: "claude-sonnet-4-6" },
      { name: "eng-2", cli: "antigravity", model: "gemini-4-neon" },
      { name: "eng-3", cli: "antigravity" },
      { name: "eng-4", cli: "claude", model: "opus" },
      { name: "rev-1", cli: "codex" },
    ] as const;
    const { scheduler, settle, ran, now, advance, wake } = await poolSociety({
      start: "2026-11-26T14:42:52.000Z",
      citizens,
      refusing: () => refusing,
      limitedUntil: (at) => new Date(at.getTime() + 13_794_000).toISOString(),
    });

    refusing = true;
    await wake("eng-1");
    await settle();
    expect(ran).toEqual(["eng-1"]);
    ran.length = 0;

    // Seven minutes on, as the citizen's next turn was: every turn runs but the refused pool's.
    advance(7 * 60_000);
    for (const { name } of citizens) {
      await wake(name);
    }
    await settle();
    expect(ran.toSorted()).toEqual(["eng-2", "eng-3", "eng-4", "rev-1"]);
    ran.length = 0;

    // At the reset the kept wake goes, as the wake it was.
    refusing = false;
    advance(Date.parse("2026-11-26T18:32:46.000Z") - 1 - now().getTime());
    await settle();
    expect(ran).toEqual([]);
    advance(1);
    await settle();
    expect(ran).toEqual(["eng-1"]);
    await scheduler.stop();
  });

  it("lets one turn try a pool's limit with no reset at its half hour, reading it once while a turn waits, as the other pool's run", async () => {
    let refusing = false;
    const reads: string[] = [];
    const answers: Array<() => CliQuota> = [];
    const thirdParty = ["eng-1", "eng-2"];
    const { board, scheduler, settle, ran, now, advance, wake } = await poolSociety({
      start: "2026-11-26T14:42:52.000Z",
      citizens: [
        { name: "eng-1", cli: "antigravity", model: "claude-sonnet-4-6" },
        { name: "eng-2", cli: "antigravity", model: "gpt-oss-120b" },
        { name: "eng-3", cli: "antigravity", model: "gemini-4-neon" },
      ],
      refusing: () => refusing,
      limitedUntil: () => null,
      read: () => {
        reads.push(now().toISOString());
        const answer = answers.shift();
        return answer === undefined
          ? Promise.reject(new Error("the usage read did not answer"))
          : Promise.resolve().then(answer);
      },
    });
    const started = now().getTime();

    // A refusal whose countdown doesn't read holds the third-party pool for half an hour.
    refusing = true;
    await wake("eng-1");
    await settle();
    expect(ran).toEqual(["eng-1"]);
    ran.length = 0;

    // Both third-party citizens wait, and the quota is read once while they do, the read failing;
    // the Gemini citizen runs.
    for (const name of ["eng-1", "eng-2", "eng-3"]) {
      await wake(name);
    }
    await settle();
    expect(ran).toEqual(["eng-3"]);
    await expect.poll(() => reads.length).toBe(1);
    advance(30 * 60_000 - 1);
    await settle();
    await settle();
    expect(ran).toEqual(["eng-3"]);
    expect(reads).toHaveLength(1);
    ran.length = 0;

    // At the half hour, with all three woken for one pass, one third-party turn tries the limit and
    // the Gemini turn runs beside it. The limit refuses the try, which holds the other another half
    // hour, and that wait asks for the next read, which fails too.
    advance(1);
    await wake("eng-3");
    await settle();
    expect(ran).toHaveLength(2);
    expect(ran).toContain("eng-3");
    const tried = ran.find((name) => thirdParty.includes(name));
    expect(tried).toBeDefined();
    ran.length = 0;
    await settle();
    await expect.poll(() => reads.length).toBe(2);
    advance(30 * 60_000 - 1);
    await settle();
    expect(ran).toEqual([]);
    expect(reads).toHaveLength(2);

    // At the next half hour, the refused try's citizen woken again, one of the two tries and is
    // refused; the wait then asks for a read, which finds the pool clear and lifts the hold at once.
    advance(1);
    await wake(tried ?? "");
    await settle();
    expect(ran).toHaveLength(1);
    refusing = false;
    answers.push(() => {
      const observedAt = now().toISOString();
      return CliQuotaSchema.parse({
        observedAt,
        source: "read",
        status: "allowed",
        pools: [
          { key: "gemini", limited: false, observedAt },
          { key: "3p", limited: false, observedAt },
        ],
      });
    });
    await settle();
    await expect.poll(() => reads.length).toBe(3);
    await expect
      .poll(
        async () =>
          (await board.readRunner("pod")).quotas?.antigravity?.pools?.find(
            (pool) => pool.key === "3p",
          )?.limited,
      )
      .toBe(false);
    await settle();
    expect(ran.toSorted()).toEqual(thirdParty);
    expect(reads.map((at) => Date.parse(at) - started)).toEqual([0, 30 * 60_000, 60 * 60_000]);
    await scheduler.stop();
  });
});
