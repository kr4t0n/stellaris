import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import {
  ZERO_USAGE,
  type AgentBackend,
  type ResidentSession,
  type TurnResult,
} from "@stellaris/runner-core";
import {
  HOME_FILE_LIMIT_BYTES,
  MEMBER_VERBS,
  RUNNER_PROTOCOL,
  type AgentEvent,
} from "@stellaris/shared";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestSociety, type TestSociety } from "./testing/harness.js";

const USER = { name: "user", role: "user" } as const;

function completed(summary: string, memoryUpdated = false): TurnResult {
  return {
    events: [],
    finalText: summary,
    usage: ZERO_USAGE,
    costUsd: 0.01,
    status: { summary, claimsHeld: [], blockedOn: [], needsUserDecision: false, memoryUpdated },
    exitReason: "completed",
  };
}

/** A backend that hosts resident sessions and counts what the runner does with them. */
class ResidentBackend implements AgentBackend {
  readonly kind = "claude" as const;
  readonly starts: string[] = [];
  readonly models: Array<string | undefined> = [];
  readonly closes: string[] = [];
  readonly prompts: string[] = [];
  readonly coldTurns: string[] = [];
  memoryUpdatedNext = false;

  newSession(): Promise<string> {
    return Promise.resolve("session-1");
  }

  runTurn(): Promise<TurnResult> {
    this.coldTurns.push("cold");
    return Promise.resolve(completed("cold turn"));
  }

  startResident(
    spec: { agent: string; model?: string | undefined },
    start: { session: string },
  ): Promise<ResidentSession> {
    this.starts.push(`${spec.agent}:${start.session}`);
    this.models.push(spec.model);
    const session: ResidentSession = {
      session: start.session,
      runTurn: (prompt: string, onEvent?: (event: AgentEvent) => void): Promise<TurnResult> => {
        this.prompts.push(prompt);
        onEvent?.({ type: "text", delta: "hi" });
        const result = completed(`warm turn ${this.prompts.length}`, this.memoryUpdatedNext);
        this.memoryUpdatedNext = false;
        return Promise.resolve({ ...result, events: [{ type: "text", delta: "hi" }] });
      },
      close: (): Promise<void> => {
        this.closes.push(`${spec.agent}:${start.session}`);
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
  }
}

/** A cold backend whose session reports a running total, as the Claude SDK does on resume. */
class TotalingBackend implements AgentBackend {
  readonly kind = "claude" as const;
  readonly startedFrom: number[] = [];
  private total = 0;

  newSession(): Promise<string> {
    return Promise.resolve("session-1");
  }

  runTurn(request: { costSoFarUsd?: number | undefined }): Promise<TurnResult> {
    this.startedFrom.push(request.costSoFarUsd ?? 0);
    this.total += 0.25;
    const sessionCostUsd = this.total;
    return Promise.resolve({
      ...completed("cold turn"),
      costUsd: sessionCostUsd - (request.costSoFarUsd ?? 0),
      sessionCostUsd,
    });
  }
}

/** Commits what a test wrote into a home on the board's side, as an earlier turn's push would have. */
async function commitHome(board: Board, agent: string, message: string): Promise<void> {
  await execa(
    "git",
    [
      "-c",
      `user.name=${agent}`,
      "-c",
      `user.email=${agent}@x`,
      "commit",
      "--quiet",
      "-am",
      message,
    ],
    { cwd: board.paths.agent(agent) },
  );
}

const deskPost = {
  agent: "desk",
  project: "society",
  trigger: { kind: "user_post" as const, fromUser: true, reason: "posted" },
  priority: 2,
};

describe("turns on a runner over the runner protocol", () => {
  let dir: string;
  let society: TestSociety | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-runner-test-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await society?.stop();
    society = null;
    await rm(dir, { recursive: true, force: true });
  });

  async function start(
    board: Board,
    backend: AgentBackend,
    options: { turnTimeoutMs?: number | null; residentIdleMs?: number } = {},
  ): Promise<TestSociety> {
    society = await startTestSociety({ board, backends: () => ({ claude: backend }), ...options });
    return society;
  }

  it("runs a turn without a time limit, renewing its leases while it runs", async () => {
    let clock = new Date("2026-09-29T10:00:00.000Z");
    const { board } = await Board.init(dir, { name: "long" }, { now: () => clock });
    await board.addProject(USER, { slug: "demo" });
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const ENG = { name: "eng-1", role: "engineer" };
    const task = await board.createTask(USER, { project: "demo", title: "long" });
    const seen: Array<{ timeoutMs: number | null; live: boolean }> = [];
    let token = "";
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        token = request.mcp.token;
        seen.push({
          timeoutMs: request.limits.timeoutMs,
          live: board.resolveToken(token) !== null,
        });
        await board.claimTask(ENG, { task_id: task.id });
        const first = (await board.getTask(USER, { task_id: task.id })).leaseExpiresAt;
        // Forty minutes in, past a thirty-minute lease: the renewal keeps the claim.
        clock = new Date(clock.getTime() + 40 * 60_000);
        vi.advanceTimersByTime(10 * 60_000);
        await vi.waitFor(async () => {
          const now = await board.getTask(USER, { task_id: task.id });
          expect(now.leaseExpiresAt).not.toBe(first);
        });
        return completed("long turn");
      },
    };
    const { run } = await start(board, backend, { turnTimeoutMs: null });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await run({
      agent: "eng-1",
      project: "demo",
      trigger: { kind: "manual", fromUser: false, reason: "test" },
      priority: 1,
    });
    vi.useRealTimers();
    expect(seen).toEqual([{ timeoutMs: null, live: true }]);
    expect(board.resolveToken(token)).toBeNull();
    expect((await board.getTask(USER, { task_id: task.id })).status).toBe("claimed");
  });

  it("gives a citizen's conversations each their own digest, stages, worktree, and token", async () => {
    const { board } = await Board.init(dir, { name: "scopes" });
    for (const slug of ["demo", "lab"]) {
      await board.addProject(USER, { slug });
    }
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo", "lab"],
    });
    const demoTask = await board.createTask(USER, { project: "demo", title: "demo build" });
    await board.claimTask({ name: "eng-1", role: "engineer" }, { task_id: demoTask.id });
    await board.postMessage(USER, { thread_id: demoTask.id, body: "@eng-1 the task's spec" });
    await board.postMessage(USER, { channel: "demo/general", body: "@eng-1 the demo handover" });
    await board.postMessage(USER, { channel: "lab/general", body: "@eng-1 the lab question" });

    const seen = new Map<string, { prompt: string; cwd: string; branch: string }>();
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        const actor = board.resolveToken(request.mcp.token);
        const head = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: request.spec.cwd,
        });
        seen.set(`${actor?.scope}/${actor?.thread ?? "home"}`, {
          prompt: request.prompt,
          cwd: request.spec.cwd,
          branch: head.stdout.trim(),
        });
        return completed("done");
      },
    };
    const { run, runner } = await start(board, backend);
    const turn = (project: string, thread?: string) =>
      run({
        agent: "eng-1",
        project,
        ...(thread === undefined ? {} : { thread: { id: thread, task: true } }),
        trigger: { kind: "mention", fromUser: true, reason: "mentioned by user" },
        priority: 2,
      });
    // All at once, as the scheduler runs a citizen's conversations.
    await Promise.all([turn("demo"), turn("demo", demoTask.id), turn("lab")]);

    const demo = seen.get("demo/home");
    const task = seen.get(`demo/${demoTask.id}`);
    const lab = seen.get("lab/home");
    expect(demo?.prompt).toContain("the demo handover");
    expect(demo?.prompt).not.toContain("the lab question");
    expect(demo?.prompt).not.toContain("the task's spec");
    expect(demo?.prompt).not.toContain("Stages you hold");
    expect(demo?.branch).toBe("agent/eng-1");
    // The task's conversation holds its stage, runs in a worktree of its own on the task's branch,
    // and is shown its thread so far.
    expect(task?.prompt).toContain(`${demoTask.id} "demo build": work (yours, 1 of 1)`);
    expect(task?.prompt).toContain("## The thread so far (1)");
    expect(task?.prompt).toContain("the task's spec");
    expect(task?.prompt).not.toContain("the demo handover");
    expect(task?.cwd).toBe(runner.paths.taskWorktree("eng-1", demoTask.id));
    expect(task?.branch).toBe(`task/${demoTask.id}`);
    expect(lab?.prompt).toContain("the lab question");
    expect(lab?.prompt).not.toContain("the demo handover");
    // After the turn the task's worktree lets its branch go for the next holder.
    const after = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: task?.cwd ?? "",
    });
    expect(after.stdout.trim()).toBe("HEAD");
    // Each turn moved its own conversation's cursor: every digest is read now.
    for (const [scope, thread] of [
      ["demo", undefined],
      ["demo", demoTask.id],
      ["lab", undefined],
    ] as const) {
      const digest = await board.readDigest(
        { name: "eng-1", role: "engineer", scope, ...(thread === undefined ? {} : { thread }) },
        { advance: false },
      );
      expect(digest.messages).toEqual([]);
    }
    expect(await board.readSessions("eng-1", "demo", demoTask.id)).toEqual({
      claude: "session-1",
      runner: "pod",
    });
    // Both projects were placed on the runner that took their first turns.
    expect((await board.listProjects()).map((project) => project.runner)).toEqual(["pod", "pod"]);
  });

  it("lists the signals logged since a reader's last turn in its prompt, and none again", async () => {
    const { board } = await Board.init(dir, { name: "signals" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const prompts: string[] = [];
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: (request) => {
        prompts.push(request.prompt);
        return Promise.resolve(completed("read the signals"));
      },
    };
    const { run } = await start(board, backend);
    const dispatch = {
      agent: "stew",
      project: "society",
      trigger: { kind: "ops_event" as const, from: "board", fromUser: false, reason: "a role gap" },
      priority: 0,
    };
    await board.publishSignal({
      kind: "role_gap",
      key: "role_gap:lab:referee",
      summary: "a stage waits on the referee role, which nobody fills",
      value: 1,
    });
    await run(dispatch);
    await run(dispatch);
    expect(prompts[0]).toContain("role_gap: a stage waits on the referee role, which nobody fills");
    expect(prompts[1]).toContain("## Operations signals\n\nNone since your last turn here.");
  });

  it("asks the user in a thread of its own when a turn needs a decision and mentioned nobody", async () => {
    const { board } = await Board.init(dir, { name: "asks" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    let mention = false;
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async () => {
        if (mention) {
          await board.postMessage(
            { name: "stew", role: "steward" },
            { channel: "general", body: "@user which project should this go in?" },
          );
        }
        const base = completed("which project should the survey go in?");
        return {
          ...base,
          status: base.status === null ? null : { ...base.status, needsUserDecision: true },
        };
      },
    };
    const { run } = await start(board, backend);
    const dispatch = {
      agent: "stew",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
      priority: 1,
    };
    await run(dispatch);
    const threads = await board.listThreads();
    expect(threads).toEqual([
      expect.objectContaining({
        channel: "general",
        openedBy: "stew",
        title: "stew asks for a decision: which project should the survey go in?",
      }),
    ]);
    expect((await board.listThread(threads[0]?.id ?? "")).at(0)?.body.trim()).toBe(
      "@user which project should the survey go in?",
    );
    expect(await board.listRequests()).toHaveLength(1);
    // A turn that asked the user itself gets no second question.
    mention = true;
    await run(dispatch);
    expect(await board.listThreads()).toHaveLength(1);
    expect(await board.listRequests()).toHaveLength(2);
  });

  it("hands a resumed session the running total its last turn reported", async () => {
    const { board } = await Board.init(dir, { name: "totals" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const backend = new TotalingBackend();
    const { run } = await start(board, backend);
    const dispatch = {
      agent: "stew",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: false, reason: "test" },
      priority: 1,
    };
    await run(dispatch);
    const second = await run(dispatch);
    expect(backend.startedFrom).toEqual([0, 0.25]);
    expect(second).toMatchObject({ costUsd: 0.25, sessionCostUsd: 0.5 });
    // A record from before the running total was kept held it as the turn's cost.
    const { sessionCostUsd: _total, ...legacy } = second;
    await board.finishTurn({ ...legacy, costUsd: 0.5 });
    await run(dispatch);
    expect(backend.startedFrom).toEqual([0, 0.25, 0.5]);
  });

  it("starts a warm session afresh when the citizen's model changes", async () => {
    const { board } = await Board.init(dir, { name: "resident" });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const backend = new ResidentBackend();
    const { run } = await start(board, backend);
    await run(deskPost);
    await run(deskPost);
    expect(backend.models).toEqual([undefined]);

    await board.setAgentModel(USER, "desk", "sonnet");
    await run(deskPost);
    expect(backend.closes).toEqual(["desk:session-1"]);
    expect(backend.models).toEqual([undefined, "sonnet"]);
    await run(deskPost);
    expect(backend.models).toHaveLength(2);
  });

  it("keeps a resident role's session warm across turns, recycles it when memory changed, and lets it idle out", async () => {
    const { board } = await Board.init(dir, { name: "resident" });
    await board.addProject(USER, { slug: "demo" });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const backend = new ResidentBackend();
    // Long enough to outlast the home's commit and push between two turns, short enough to wait out.
    const { run, hub, runner } = await start(board, backend, { residentIdleMs: 1_000 });

    // Two turns, one session and one token: the society scope needs no repository, and the
    // roster rides in the prompt.
    const first = await run(deskPost);
    expect(first.exitReason).toBe("completed");
    expect(first.project).toBe("society");
    expect(backend.starts).toEqual(["desk:session-1"]);
    expect(backend.prompts[0]).toContain("## The society");
    expect(backend.prompts[0]).toContain("- eng-1: engineer on claude");
    expect(hub.residentPairs).toEqual(["desk/society"]);
    await run(deskPost);
    expect(backend.starts).toHaveLength(1);
    expect(backend.prompts).toHaveLength(2);
    expect(backend.coldTurns).toEqual([]);
    expect((await board.readLastTurn("desk", "society"))?.status?.summary).toBe("warm turn 2");

    // A turn that updated memory makes the next one start fresh, since the instructions carry it.
    backend.memoryUpdatedNext = true;
    await run(deskPost);
    expect(backend.closes).toEqual(["desk:session-1"]);
    expect(hub.residentPairs).toEqual([]);
    await run(deskPost);
    expect(backend.starts).toHaveLength(2);

    // Idle sessions go cold on their own.
    await vi.waitFor(() => expect(hub.residentPairs).toEqual([]), { timeout: 3_000 });
    expect(backend.closes).toHaveLength(2);
    await run(deskPost);
    expect(hub.residentPairs).toEqual(["desk/society"]);

    // Non-resident roles still take cold turns, and an engineer cannot use the society scope.
    await run({
      agent: "eng-1",
      project: "demo",
      trigger: { kind: "manual" as const, fromUser: true, reason: "dev" },
      priority: 2,
    });
    expect(backend.coldTurns).toEqual(["cold"]);
    const refused = await run({ ...deskPost, agent: "eng-1" });
    expect(refused.exitReason).toBe("error");
    expect(refused.error).toContain("society-scope");

    // Stopping the runner lets whatever is warm go.
    await runner.stop();
    expect(backend.closes).toHaveLength(3);
    expect(hub.residentPairs).toEqual([]);
  });

  it("brings an agent's own files back to the board after a turn, and never the board's records", async () => {
    const { board } = await Board.init(dir, { name: "homes" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    await writeFile(path.join(board.paths.agent("stew"), "profile.md"), "Watches.\n", "utf8");
    await commitHome(board, "stew", "an earlier turn wrote the profile");
    let pulled = "";
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        const home = request.spec.configHome;
        pulled = await readFile(path.join(home, "profile.md"), "utf8");
        await writeFile(path.join(home, "memory", "core.md"), "- A lesson.\n", "utf8");
        await writeFile(path.join(home, "notes.md"), "scratch\n", "utf8");
        await writeFile(path.join(home, "agent.json"), "{}", "utf8");
        await writeFile(path.join(home, "role.md"), "# rewritten\n", "utf8");
        return completed("learned something");
      },
    };
    const { run } = await start(board, backend);
    await run({
      agent: "stew",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
      priority: 1,
    });
    expect(pulled).toBe("Watches.\n");
    const home = board.paths.agent("stew");
    expect(await board.readMemoryCore("stew")).toBe("- A lesson.\n");
    expect(await readFile(path.join(home, "notes.md"), "utf8")).toBe("scratch\n");
    expect((await board.readAgent("stew")).name).toBe("stew");
    expect(await readFile(path.join(home, "role.md"), "utf8")).not.toContain("rewritten");
    // The turn is a commit in the citizen's home, by the citizen.
    const log = await execa("git", ["log", "-1", "--format=%an %s"], { cwd: home });
    expect(log.stdout).toMatch(/^stew turn [0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("works outside projects in a scratch folder, and keeps byproducts and oversized files out of the home", async () => {
    const { board } = await Board.init(dir, { name: "scratch" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    let cwd = "";
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        cwd = request.spec.cwd;
        const home = request.spec.configHome;
        await writeFile(path.join(cwd, "download.html"), "<html></html>", "utf8");
        await mkdir(path.join(home, "skills", "chart", "node_modules"), { recursive: true });
        await writeFile(path.join(home, "skills", "chart", "SKILL.md"), "# Chart\n", "utf8");
        await writeFile(path.join(home, "skills", "chart", "node_modules", "x.js"), "1", "utf8");
        await writeFile(
          path.join(home, "memory", "paper.pdf"),
          Buffer.alloc(HOME_FILE_LIMIT_BYTES + 1),
        );
        await writeFile(path.join(home, "memory", "core.md"), "- Kept.\n", "utf8");
        return completed("worked in scratch");
      },
    };
    const { run, runner } = await start(board, backend);
    const turn = await run({
      agent: "stew",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
      priority: 1,
    });
    expect(turn.exitReason).toBe("completed");
    expect(cwd).toBe(path.join(runner.paths.agent("stew"), "scratch"));
    // Memory and the skill reach the board; the scratch folder, a tool's byproducts, and the
    // oversized file stay on the runner.
    const home = board.paths.agent("stew");
    expect(await board.readMemoryCore("stew")).toBe("- Kept.\n");
    const tracked = (await execa("git", ["ls-files"], { cwd: home })).stdout.split("\n");
    expect(tracked).toContain("skills/chart/SKILL.md");
    expect(tracked.filter((file) => /scratch|node_modules|paper\.pdf/.test(file))).toEqual([]);
    await expect(readFile(path.join(cwd, "download.html"), "utf8")).resolves.toContain("html");
  });

  it("pins a citizen's work outside projects to one runner, moves it when told, and moves it when its runner is gone", async () => {
    const { board } = await Board.init(dir, { name: "pins" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const fresh: Record<string, boolean[]> = { a: [], b: [] };
    const backendOn = (runner: "a" | "b"): AgentBackend => ({
      kind: "claude",
      newSession: () => Promise.resolve(`session-${runner}`),
      runTurn: (request) => {
        fresh[runner]?.push(request.newSession);
        return Promise.resolve(completed(`ran on ${runner}`));
      },
    });
    society = await startTestSociety({
      board,
      runnerName: "a",
      backends: () => ({ claude: backendOn("a") }),
      extraRunners: [{ name: "b", backends: () => ({ claude: backendOn("b") }) }],
      graceMs: 300,
    });
    const { run, hub, runners } = society;
    const turn = {
      agent: "stew",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
      priority: 1,
    };

    // The first turn pins it to the least busy runner, and every later one goes there too.
    expect((await run(turn)).runner).toBe("a");
    expect((await run(turn)).runner).toBe("a");
    expect((await board.readAgent("stew")).homeRunner).toBe("a");
    expect(fresh).toEqual({ a: [true, false], b: [] });

    // The user moves it: its conversation starts afresh there.
    await board.setAgentRunner(USER, "stew", "b");
    expect((await run(turn)).runner).toBe("b");
    expect(fresh["b"]).toEqual([true]);

    // Its runner goes away: the turn waits through the grace period, then moves.
    await runners.get("b")?.stop();
    await vi.waitFor(() => expect(hub.connected).toEqual(["a"]));
    expect(
      await hub.assign({
        ...turn,
        trigger: { ...turn.trigger, from: undefined },
        onboarding: false,
      }),
    ).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect((await run(turn)).runner).toBe("a");
    expect((await board.readAgent("stew")).homeRunner).toBe("a");
    const moved = (await board.readEvents(null, 500)).filter((e) => e.type === "agent.placed");
    expect(moved.map((event) => event.payload)).toEqual([
      { agent: "stew", runner: "a" },
      { agent: "stew", runner: "a", from: "b" },
    ]);
  });

  /**
   * One citizen's turn outside projects on runner a and its turn in the lab on runner b, run at once,
   * each after both have read the same memory, each making one edit to its core memory.
   */
  async function twoMachines(
    edits: { a: [string, string]; b: [string, string] },
    prompts: string[] = [],
  ): Promise<{ board: Board; core: string; run: TestSociety["run"] }> {
    const { board } = await Board.init(dir, { name: "two-machines" });
    await board.addProject(USER, { slug: "lab" });
    await board.addAgent(USER, {
      name: "stew",
      role: "steward",
      cli: "claude",
      memberships: ["lab"],
    });
    const core = path.join(board.paths.agent("stew"), "memory", "core.md");
    await writeFile(core, "# Core memory\n\n- one\n- two\n- three\n- four\n- five\n", "utf8");
    await commitHome(board, "stew", "an earlier turn wrote the core");
    let arrived = 0;
    const { promise: both, resolve: together } = Promise.withResolvers<void>();
    const backendOn = ([line, changed]: [string, string]): AgentBackend => ({
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        prompts.push(request.prompt);
        arrived += 1;
        if (arrived === 2) {
          together();
        }
        if (arrived <= 2) {
          await both;
          const file = path.join(request.spec.configHome, "memory", "core.md");
          await writeFile(file, (await readFile(file, "utf8")).replace(line, changed), "utf8");
        }
        return completed(`changed ${line}`);
      },
    });
    society = await startTestSociety({
      board,
      runnerName: "a",
      backends: () => ({ claude: backendOn(edits.a) }),
      extraRunners: [{ name: "b", backends: () => ({ claude: backendOn(edits.b) }) }],
    });
    // Its work outside projects runs on a, and the lab lives on b.
    await board.setAgentRunner(USER, "stew", "a");
    await board.placeProject("lab", "b");
    const { run } = society;
    const [home, lab] = await Promise.all(
      (["society", "lab"] as const).map((project) =>
        run({
          agent: "stew",
          project,
          trigger: { kind: "manual", fromUser: true, reason: "test" },
          priority: 1,
        }),
      ),
    );
    expect([home?.runner, lab?.runner]).toEqual(["a", "b"]);
    return { board, core, run };
  }

  it("merges what one citizen wrote to its memory on two machines at once", async () => {
    const { board, core } = await twoMachines({
      a: ["- one", "- one, from the society's work"],
      b: ["- five", "- five, from the lab"],
    });
    const merged = await readFile(core, "utf8");
    expect(merged).toContain("- one, from the society's work");
    expect(merged).toContain("- five, from the lab");
    expect(await board.listHomeConflicts("stew")).toEqual([]);
    const authors = await execa("git", ["log", "--format=%an"], { cwd: board.paths.agent("stew") });
    expect(
      authors.stdout.split("\n").filter((name) => name === "stew").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps both versions of a line two machines changed at once, and asks the citizen to reconcile them", async () => {
    const prompts: string[] = [];
    const { board, core, run } = await twoMachines(
      {
        a: ["- three", "- three, as the society's work saw it"],
        b: ["- three", "- three, as the lab saw it"],
      },
      prompts,
    );
    const kept = await readFile(core, "utf8");
    const [conflict, ...more] = await board.listHomeConflicts("stew");
    expect(more).toEqual([]);
    expect(conflict?.path).toMatch(/^memory\/core\.md\.conflict-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(conflict?.file).toBe("memory/core.md");
    // The copy's age is the commit that brought it, made moments ago on a runner.
    expect(Date.now() - Date.parse(conflict?.since ?? "")).toBeLessThan(60_000);
    const other = await readFile(
      path.join(board.paths.agent("stew"), conflict?.path ?? ""),
      "utf8",
    );
    // One version is in place and the other beside it; neither is lost.
    expect([kept, other].join("\n")).toContain("- three, as the society's work saw it");
    expect([kept, other].join("\n")).toContain("- three, as the lab saw it");
    // The history shows both turns' edits and the merge that kept the copy, with that alone.
    const { changes } = await board.homeHistory("stew", 30);
    const turns = changes.filter((change) => change.turnId !== undefined);
    expect(turns.map((change) => change.kind)).toEqual(["turn", "turn"]);
    expect(
      turns.every((change) => change.files.some((file) => file.path === "memory/core.md")),
    ).toBe(true);
    expect(
      changes.filter((change) => change.kind === "merge").map((change) => change.files),
    ).toEqual([[{ path: conflict?.path, status: "added", added: 7, removed: 0 }]]);
    await run({
      agent: "stew",
      project: "society",
      trigger: { kind: "manual", fromUser: true, reason: "test" },
      priority: 1,
    });
    expect(prompts.at(-1)).toContain("## Edits to reconcile in your home");
    expect(prompts.at(-1)).toContain(`- ${conflict?.path}, beside memory/core.md, since`);
  });

  it("keeps a turn queued while its project's runner is away, and fails turns a restarted runner dropped", async () => {
    const { board } = await Board.init(dir, { name: "away" });
    await board.addProject(USER, { slug: "demo" });
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const gate: { release: (() => void) | null; holding: boolean } = {
      release: null,
      holding: true,
    };
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async () => {
        if (gate.holding) {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        return completed("done");
      },
    };
    const { run, hub, runner } = await start(board, backend);
    const dispatch = {
      agent: "eng-1",
      project: "demo",
      trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
      priority: 2,
    };

    // A runner that registers again without a turn it was running: that turn ends as failed.
    const running = run(dispatch);
    await vi.waitFor(() => expect(runner.turns).toHaveLength(1));
    await hub.register("pod", {
      protocol: RUNNER_PROTOCOL,
      version: "test",
      os: "linux",
      clis: ["claude"],
      residentClis: [],
      capabilities: [],
      slots: null,
      turns: [],
    });
    const dropped = await running;
    expect(dropped).toMatchObject({
      exitReason: "error",
      error: expect.stringContaining("restarted"),
    });
    gate.holding = false;
    gate.release?.();
    await vi.waitFor(() => expect(runner.turns).toHaveLength(0));
    expect((await board.readProject("demo")).runner).toBe("pod");

    // With the project's runner gone, its turns wait rather than go anywhere else.
    await runner.stop();
    await vi.waitFor(() => expect(hub.connected).toEqual([]));
    expect(await hub.assign({ ...dispatch, onboarding: false })).toBeNull();
  });

  it("speaks only to runners that hold a token, a matching protocol, and a turn for the home they ask for", async () => {
    const { board } = await Board.init(dir, { name: "auth" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: () => Promise.resolve(completed("done")),
      listModels: () =>
        Promise.resolve([{ id: "opus", name: "Opus", description: "", isDefault: true }]),
    };
    const { app } = await start(board, backend);
    const { token } = await board.addRunner(USER, "laptop");
    const call = (route: string, init: RequestInit = {}, bearer = token) =>
      app.request(route, {
        ...init,
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      });
    expect((await call("/runner/board/manifest", {}, "stl_nothing")).status).toBe(401);
    const hello = await call("/runner/hello", {
      method: "POST",
      body: JSON.stringify({
        protocol: RUNNER_PROTOCOL + 1,
        version: "future",
        os: "linux",
        clis: ["claude"],
        slots: 1,
      }),
    });
    expect(hello.status).toBe(409);
    expect((await call("/runner/homes/stew/git/info/refs?service=git-upload-pack")).status).toBe(
      403,
    );
    expect((await call("/runner/board/manifest")).status).toBe(200);

    // The interface's model list is asked of a runner that has the CLI.
    const models = await app.request("/api/models/claude", {
      headers: { authorization: `Bearer ${board.issueTurnToken("user", "user", 60_000)}` },
    });
    expect(await models.json()).toEqual([
      { id: "opus", name: "Opus", description: "", isDefault: true },
    ]);
  });
});
