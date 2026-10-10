import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import {
  createRunner,
  EnrollmentDeniedError,
  enrollRunner,
  readCredentials,
  RunnerLayout,
  saveCredentials,
  ZERO_USAGE,
  type AgentBackend,
  type PullRequestOps,
  type ResidentSession,
  type TurnResult,
} from "@stellaris/runner-core";
import {
  BranchChangesSchema,
  BranchFileSchema,
  HOME_FILE_LIMIT_BYTES,
  MEMBER_VERBS,
  RUNNER_PROTOCOL,
  RunnerModelsSchema,
  type AgentEvent,
  type RunnerHello,
  type RunnerMessage,
} from "@stellaris/shared";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestSociety, type TestSociety } from "./testing/harness.js";

const USER = { name: "user", role: "user" } as const;

/** A pull request's number from its address. */
function pullNumber(url: string): number {
  return Number(url.split("/").at(-1));
}

/** A commit made in a bare repository, as GitHub makes one: the tree, its parents, its message. */
async function commitTree(
  repo: string,
  tree: string,
  parents: readonly string[],
  message: readonly string[],
): Promise<string> {
  const args = ["-c", "user.name=u", "-c", "user.email=u@x", "commit-tree", tree];
  for (const parent of parents) {
    args.push("-p", parent);
  }
  for (const paragraph of message) {
    args.push("-m", paragraph);
  }
  return (await execa("git", args, { cwd: repo })).stdout.trim();
}

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
  readonly efforts: Array<string | undefined> = [];
  readonly closes: string[] = [];
  readonly prompts: string[] = [];
  readonly coldTurns: string[] = [];
  memoryUpdatedNext = false;
  coldMemoryUpdatedNext = false;

  newSession(): Promise<string> {
    return Promise.resolve("session-1");
  }

  runTurn(): Promise<TurnResult> {
    this.coldTurns.push("cold");
    const result = completed("cold turn", this.coldMemoryUpdatedNext);
    this.coldMemoryUpdatedNext = false;
    return Promise.resolve(result);
  }

  startResident(
    spec: { agent: string; model?: string | undefined; effort?: string | undefined },
    start: { session: string },
  ): Promise<ResidentSession> {
    this.starts.push(`${spec.agent}:${start.session}`);
    this.models.push(spec.model);
    this.efforts.push(spec.effort);
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

  it("hands an agent the board at the address its runner reaches the server by", async () => {
    const { board } = await Board.init(dir, { name: "address" });
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
    const urls: string[] = [];
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: (request) => {
        urls.push(request.mcp.url);
        return Promise.resolve(completed("done"));
      },
    };
    const { run, url } = await start(board, backend);
    await run({
      agent: "eng-1",
      project: "demo",
      trigger: { kind: "manual", fromUser: false, reason: "test" },
      priority: 1,
    });
    expect(urls).toEqual([`${url}/mcp`]);
  });

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
    let proposeRole = false;
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
        if (proposeRole) {
          await board.propose(
            { name: "stew", role: "steward" },
            {
              kind: "role",
              charter: { name: "researcher", purpose: "Researches.", verbs: ["read_inbox"] },
            },
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
    // Nor does one that proposed what the user decides: the proposal is the question, and it
    // leaves the user's list when decided, where a mention would stay.
    mention = false;
    proposeRole = true;
    await run(dispatch);
    const asked = (await board.listThreads()).filter((thread) => thread.openedBy === "stew");
    expect(asked.map((thread) => thread.channel)).toEqual(["general", "governance"]);
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

  it("starts a warm session afresh when the citizen's model or effort changes", async () => {
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

    // So does a new reasoning effort, which the session was started with too.
    await board.setAgentEffort(USER, "desk", "low");
    await run(deskPost);
    expect(backend.closes).toEqual(["desk:session-1", "desk:session-1"]);
    expect(backend.efforts).toEqual([undefined, undefined, "low"]);
    expect(backend.models.at(-1)).toBe("sonnet");
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
    // A society role plans where work runs, so it sees every machine and what lives on it.
    expect(backend.prompts[0]).toContain("## Runners");
    expect(backend.prompts[0]).toMatch(
      /- pod: connected; \w+; CLIs claude; offers nothing beyond its CLIs; /,
    );
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

    // Non-resident roles still take cold turns, in their projects and, asked there, outside them.
    await run({
      agent: "eng-1",
      project: "demo",
      trigger: { kind: "manual" as const, fromUser: true, reason: "dev" },
      priority: 2,
    });
    expect(backend.coldTurns).toEqual(["cold"]);
    const outside = await run({ ...deskPost, agent: "eng-1" });
    expect(outside.exitReason).toBe("completed");
    expect(backend.coldTurns).toEqual(["cold", "cold"]);

    // Stopping the runner lets whatever is warm go.
    await runner.stop();
    expect(backend.closes).toHaveLength(3);
    expect(hub.residentPairs).toEqual([]);
  });

  it("starts a warm session afresh once another turn of its citizen changed the memory", async () => {
    const { board } = await Board.init(dir, { name: "stale" });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const ask = await board.openThread(USER, { channel: "general", title: "a question" });
    const backend = new ResidentBackend();
    const { run, hub } = await start(board, backend, { residentIdleMs: 60_000 });
    await run(deskPost);
    expect(backend.starts).toEqual(["desk:session-1"]);

    // A cold turn in an ask's thread changes the memory the warm session started with; the warm
    // session is not cut short, and starts afresh at its next turn.
    backend.coldMemoryUpdatedNext = true;
    await run({ ...deskPost, thread: { id: ask.id, task: false } });
    expect(backend.coldTurns).toEqual(["cold"]);
    expect(hub.residentPairs).toEqual(["desk/society"]);
    await run(deskPost);
    expect(backend.closes).toEqual(["desk:session-1"]);
    expect(backend.starts).toHaveLength(2);
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

  it("gives each thread's conversation a workspace of its own beside the citizen's others, until the thread closes", async () => {
    const { board } = await Board.init(dir, { name: "threads" });
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
    const topic = await board.openThread(USER, {
      channel: "demo/general",
      title: "which library?",
    });
    const ask = await board.openThread(USER, { channel: "general", title: "a question" });

    // Each turn waits until all three are in flight, so they can only finish by running together.
    const cwds = new Set<string>();
    const { promise: together, resolve: allStarted } = Promise.withResolvers<void>();
    let detachedAtOwnBranch = false;
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        const { cwd } = request.spec;
        cwds.add(cwd);
        if (cwds.size === 3) {
          allStarted();
        }
        await together;
        // A worktree that holds nothing on no branch goes when its thread closes; a scratch
        // folder goes whatever it holds.
        if (!cwd.includes(topic.id)) {
          await writeFile(path.join(cwd, "notes.txt"), "left behind\n", "utf8");
        }
        if (cwd.includes(topic.id)) {
          const head = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
          const [at, own] = await Promise.all([
            execa("git", ["rev-parse", "HEAD"], { cwd }),
            execa("git", ["rev-parse", "agent/eng-1"], { cwd }),
          ]);
          detachedAtOwnBranch = head.stdout === "HEAD" && at.stdout === own.stdout;
          // A thread closes from inside its closer's own turn there, never under another's.
          const inside = { name: "eng-1", role: "engineer", scope: "demo", thread: topic.id };
          await board.postMessage(inside, { thread_id: topic.id, body: "Zod." });
          await board.closeThread(inside, { thread_id: topic.id, summary: "Settled." });
        }
        if (cwd.includes(ask.id)) {
          const inside = { name: "eng-1", role: "engineer", scope: "society", thread: ask.id };
          await board.postMessage(inside, { thread_id: ask.id, body: "Yes." });
          await board.closeThread(inside, { thread_id: ask.id, summary: "Answered." });
        }
        return completed("done");
      },
    };
    const { run, runner } = await start(board, backend);
    const turn = (project: string, thread?: string) =>
      run({
        agent: "eng-1",
        project,
        ...(thread === undefined ? {} : { thread: { id: thread, task: false } }),
        trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
        priority: 1,
      });
    const ended = await Promise.all([
      turn("demo"),
      turn("demo", topic.id),
      turn("society", ask.id),
    ]);
    expect(ended.map((each) => each.exitReason)).toEqual(["completed", "completed", "completed"]);

    const home = runner.paths.worktree("eng-1", "demo");
    const topicWorktree = runner.paths.threadWorktree("eng-1", topic.id);
    const askFolder = path.join(runner.paths.agent("eng-1"), "scratch", ".threads", ask.id);
    expect([...cwds].toSorted()).toEqual([home, topicWorktree, askFolder].toSorted());
    expect(detachedAtOwnBranch).toBe(true);
    // A closed thread's workspace goes once the runner has the server's answer to the turn's
    // outcome; the home worktree stays.
    await vi.waitFor(async () => {
      await expect(stat(topicWorktree)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(askFolder)).rejects.toMatchObject({ code: "ENOENT" });
    });
    await expect(readFile(path.join(home, "notes.txt"), "utf8")).resolves.toBe("left behind\n");
    const worktrees = await execa("git", ["worktree", "list", "--porcelain"], {
      cwd: runner.paths.repo("demo"),
    });
    expect(worktrees.stdout).not.toContain(topic.id);
  });

  it("gives each channel's conversation beside general a workspace of its own, until the channel is archived", async () => {
    const { board } = await Board.init(dir, { name: "channels" });
    await board.addProject(USER, { slug: "demo", channels: ["general", "release"] });
    await board.addChannel(USER, { project: null, name: "lounge", purpose: "Chatter." });
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
    await board.subscribe({ name: "eng-1", role: "engineer" }, { channel: "demo/release" });
    const posted = await board.postMessage(USER, { channel: "demo/release", body: "ship it" });

    // Each turn waits until all three are in flight, so they can only finish by running together.
    const cwds = new Set<string>();
    const prompts = new Map<string, string>();
    let refusal: unknown = null;
    const { promise: together, resolve: allStarted } = Promise.withResolvers<void>();
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        const { cwd } = request.spec;
        cwds.add(cwd);
        prompts.set(cwd, request.prompt);
        if (cwds.size === 3) {
          allStarted();
        }
        await together;
        if (cwd.endsWith(path.join("demo", "release"))) {
          // Archiving under eng-1's turn in the channel is refused until that turn ends.
          refusal = await board
            .archiveChannel(USER, { channel: "demo/release", reason: "Shipped." })
            .then(
              () => null,
              (error: unknown) => error,
            );
        }
        return completed("done");
      },
    };
    const { run, runner, hub } = await start(board, backend);
    const turn = (project: string, channel?: string) =>
      run({
        agent: "eng-1",
        project,
        ...(channel === undefined ? {} : { channel }),
        trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
        priority: 1,
      });
    const ended = await Promise.all([
      turn("demo"),
      turn("demo", "release"),
      turn("society", "lounge"),
    ]);
    expect(ended.map((each) => each.exitReason)).toEqual(["completed", "completed", "completed"]);
    expect(ended.map((each) => each.channel)).toEqual([undefined, "release", "lounge"]);

    const home = runner.paths.worktree("eng-1", "demo");
    const release = runner.paths.channelWorktree("eng-1", "demo", "release");
    const lounge = path.join(runner.paths.agent("eng-1"), "scratch", ".channels", "lounge");
    expect([...cwds].toSorted()).toEqual([home, release, lounge].toSorted());
    // The channel's turn read the channel's post; the home's did not.
    expect(prompts.get(release)).toContain("conversation of demo/release");
    expect(prompts.get(release)).toContain("ship it");
    expect(prompts.get(home)).not.toContain("ship it");
    expect(await board.digestCursor("eng-1", "demo", "#release")).toBe(posted.id);
    expect(refusal).toMatchObject({ code: "INVALID_STATE" });
    // Archived once the turns have ended, each channel's workspace goes with the sweep the
    // scheduler asks for on the archive.
    await board.archiveChannel(USER, { channel: "demo/release", reason: "Shipped." });
    await board.archiveChannel(USER, { channel: "lounge", reason: "Quiet." });
    await hub.sweep({ kind: "channel", scope: "demo", name: "release" });
    await hub.sweep({ kind: "channel", scope: "society", name: "lounge" });
    await expect(stat(release)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(lounge)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(home)).resolves.toBeDefined();
  });

  it("keeps a project's code current with its remote: the clone, the home, and branches nobody has worked on", async () => {
    // A remote standing in for GitHub, where work lands by pull request.
    const remote = await mkdtemp(path.join(os.tmpdir(), "stellaris-remote-"));
    try {
      const origin = path.join(remote, "origin.git");
      const author = path.join(remote, "author");
      await execa("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
      await execa("git", ["clone", "--quiet", origin, author]);
      const land = async (file: string): Promise<void> => {
        await writeFile(path.join(author, file), `${file}\n`, "utf8");
        await execa("git", ["add", file], { cwd: author });
        await execa("git", ["-c", "user.name=u", "-c", "user.email=u@x", "commit", "-qm", file], {
          cwd: author,
        });
        await execa("git", ["push", "--quiet", "origin", "HEAD:main"], { cwd: author });
      };
      await land("first.txt");

      const { board } = await Board.init(dir, { name: "remote" });
      await board.addProject(USER, { slug: "demo", repo: origin, onDone: "none" });
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
      const prompts: string[] = [];
      let script: ((cwd: string) => Promise<void>) | null = null;
      const backend: AgentBackend = {
        kind: "claude",
        newSession: () => Promise.resolve("session-1"),
        runTurn: async (request) => {
          prompts.push(request.prompt);
          await script?.(request.spec.cwd);
          script = null;
          return completed("done");
        },
      };
      const { run, runner } = await start(board, backend);
      const home = (): Promise<unknown> =>
        run({
          agent: "eng-1",
          project: "demo",
          trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
          priority: 1,
        });
      const repo = runner.paths.repo("demo");
      const worktree = runner.paths.worktree("eng-1", "demo");
      const rev = async (ref: string, cwd = repo): Promise<string> =>
        (await execa("git", ["rev-parse", ref], { cwd })).stdout;

      await home();
      const task = await board.createTask(USER, { project: "demo", title: "build" });
      const branch = `task/${task.id}`;
      await home();
      const forkedAt = await rev(branch);

      // A pull request lands on the remote: the next turn fetches it, the clone's main and the
      // citizen's own branch follow, and the task branch nobody has worked on starts from it.
      await land("second.txt");
      await home();
      const landed = await rev("origin/main");
      expect(landed).not.toBe(forkedAt);
      expect(await rev("main")).toBe(landed);
      expect(await rev("agent/eng-1")).toBe(landed);
      await expect(readFile(path.join(worktree, "second.txt"), "utf8")).resolves.toBe(
        "second.txt\n",
      );
      expect(await rev(branch)).toBe(landed);
      expect(prompts.at(-1)).not.toContain("## Your workspace");

      // The citizen's own commit keeps its branch where it is, and the prompt says so.
      script = async (cwd) => {
        await writeFile(path.join(cwd, "mine.txt"), "mine\n", "utf8");
        await execa("git", ["add", "mine.txt"], { cwd });
        // A real turn commits as its citizen through the runner's environment; this script has none.
        await execa(
          "git",
          ["-c", "user.name=eng-1", "-c", "user.email=eng-1@x", "commit", "-qm", "my own notes"],
          { cwd },
        );
      };
      await home();
      await land("third.txt");
      await home();
      expect(await rev("main")).toBe(await rev("origin/main"));
      expect(await rev("agent/eng-1")).not.toBe(await rev("main"));
      expect(prompts.at(-1)).toContain(
        "Your branch agent/eng-1 holds 1 commit that is not on main: `",
      );
      expect(prompts.at(-1)).toContain(
        "It was not brought up to main, which has 1 commit it lacks",
      );

      // Work on the task's branch stays where it forked; the prompt says what landed since.
      const inTask = (): Promise<unknown> =>
        run({
          agent: "eng-1",
          project: "demo",
          thread: { id: task.id, task: true },
          trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
          priority: 1,
        });
      script = async (cwd) => {
        await writeFile(path.join(cwd, "work.txt"), "work\n", "utf8");
      };
      await inTask();
      const worked = await rev(branch);
      await land("fourth.txt");
      await inTask();
      expect(await rev(branch)).toBe(worked);
      expect(prompts.at(-1)).toContain(
        `1 commit landed on main since your branch ${branch} left it, changing \`fourth.txt\`. Merging main into it is your decision.`,
      );
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("keeps an ended conversation's workspace that holds work on no branch for a closing turn, then lets it go", async () => {
    const { board } = await Board.init(dir, { name: "leftovers" });
    await board.addProject(USER, { slug: "demo" });
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    for (const name of ["eng-1", "eng-2"]) {
      await board.addAgent(USER, { name, role: "engineer", cli: "claude", memberships: ["demo"] });
    }
    const topic = await board.openThread(USER, {
      channel: "demo/general",
      title: "which library?",
    });
    const prompts = new Map<string, string>();
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        prompts.set(request.spec.agent, request.prompt);
        if (request.spec.agent === "eng-1" && !request.prompt.includes("has ended")) {
          await writeFile(path.join(request.spec.cwd, "draft.md"), "a draft\n", "utf8");
          // Closed from inside eng-1's own turn there, which the guard lets through.
          const inside = { name: "eng-1", role: "engineer", scope: "demo", thread: topic.id };
          await board.postMessage(inside, { thread_id: topic.id, body: "Zod." });
          await board.closeThread(inside, { thread_id: topic.id, summary: "Settled." });
          // What the scheduler does on the thread's close: eng-1's turn still uses its workspace.
          await society?.hub.sweep({ kind: "thread", id: topic.id });
        }
        return completed("done");
      },
    };
    const { run, runner } = await start(board, backend);
    const inTopic = (agent: string, kind: "manual" | "closing" = "manual"): Promise<unknown> =>
      run({
        agent,
        project: "demo",
        thread: { id: topic.id, task: false },
        trigger: { kind, fromUser: kind === "manual", reason: "test" },
        priority: 1,
      });
    await inTopic("eng-2");
    await inTopic("eng-1");

    // eng-2's clean worktree went with the sweep; eng-1's holds a draft on no branch and stays.
    await expect(stat(runner.paths.threadWorktree("eng-2", topic.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const kept = runner.paths.threadWorktree("eng-1", topic.id);
    await expect(readFile(path.join(kept, "draft.md"), "utf8")).resolves.toBe("a draft\n");
    const leftovers = (await board.readEvents(null, 1_000)).filter(
      (event) => event.type === "workspace.leftovers",
    );
    expect(leftovers.map((event) => event.payload)).toEqual([
      { agent: "eng-1", project: "demo", thread: topic.id },
    ]);

    // The closing turn is told how the thread ended and what it holds, and the workspace goes after.
    await inTopic("eng-1", "closing");
    const closing = prompts.get("eng-1") ?? "";
    expect(closing).toContain(
      `## This conversation has ended\n\nThe thread "which library?" on demo/general was closed by eng-1.`,
    );
    expect(closing).toContain("ask them in demo/general with a mention");
    expect(closing).toContain("- Uncommitted here: `?? draft.md`.");
    await vi.waitFor(async () => {
      await expect(stat(kept)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("gives a failed closing turn another try, twice, then leaves the workspace and says so", async () => {
    const { board } = await Board.init(dir, { name: "stuck" });
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
    const topic = await board.openThread(USER, {
      channel: "demo/general",
      title: "which library?",
    });
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        if (request.prompt.includes("has ended")) {
          return {
            ...completed("broke"),
            status: null,
            exitReason: "error",
            error: "the CLI broke",
          };
        }
        await writeFile(path.join(request.spec.cwd, "draft.md"), "a draft\n", "utf8");
        const inside = { name: "eng-1", role: "engineer", scope: "demo", thread: topic.id };
        await board.postMessage(inside, { thread_id: topic.id, body: "Zod." });
        await board.closeThread(inside, { thread_id: topic.id, summary: "Settled." });
        return completed("done");
      },
    };
    const { run, runner } = await start(board, backend);
    const inTopic = (kind: "manual" | "closing"): Promise<unknown> =>
      run({
        agent: "eng-1",
        project: "demo",
        thread: { id: topic.id, task: false },
        trigger: { kind, fromUser: kind === "manual", reason: "test" },
        priority: 1,
      });
    const recorded = async (type: string): Promise<number> =>
      (await board.readEvents(null, 1_000)).filter((event) => event.type === type).length;

    await inTopic("manual");
    expect(await recorded("workspace.leftovers")).toBe(1);
    await inTopic("closing");
    await inTopic("closing");
    expect(await recorded("workspace.leftovers")).toBe(3);
    await inTopic("closing");
    expect(await recorded("workspace.leftovers")).toBe(3);
    expect(
      (await board.listSignals())
        .map((record) => record.signal)
        .filter((signal) => signal.kind === "stuck_workspace"),
    ).toMatchObject([
      {
        kind: "stuck_workspace",
        agent: "eng-1",
        project: "demo",
        summary: `eng-1's workspace in thread ${topic.id} still holds work on no branch after 3 closing turns failed, so it stays on runner pod`,
      },
    ]);
    await expect(
      readFile(path.join(runner.paths.threadWorktree("eng-1", topic.id), "draft.md"), "utf8"),
    ).resolves.toBe("a draft\n");
  });

  it("lists a citizen's models from its own runner, and asks again once that runner reconnects", async () => {
    const { board, userToken } = await Board.init(dir, { name: "models" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const listed: Record<string, number> = { a: 0, b: 0 };
    const efforts: Record<string, string[]> = { a: ["high"], b: [] };
    const backendOn = (runner: "a" | "b"): AgentBackend => ({
      kind: "claude",
      newSession: () => Promise.resolve(`session-${runner}`),
      runTurn: () => Promise.resolve(completed("done")),
      listModels: () => {
        listed[runner] = (listed[runner] ?? 0) + 1;
        return Promise.resolve([
          {
            id: `opus-${runner}`,
            name: "Opus",
            description: "",
            isDefault: true,
            efforts: (efforts[runner] ?? []).map((id) => ({ id, description: "" })),
          },
        ]);
      },
    });
    society = await startTestSociety({
      board,
      runnerName: "a",
      backends: () => ({ claude: backendOn("a") }),
      extraRunners: [{ name: "b", backends: () => ({ claude: backendOn("b") }) }],
    });
    const { app, hub } = society;
    const models = async () => {
      const response = await app.request("/api/agents/stew/models", {
        headers: { authorization: `Bearer ${userToken}` },
      });
      return RunnerModelsSchema.parse(await response.json());
    };

    // Pinned to b, its list is b's, even though a is first by name.
    await board.setAgentRunner(USER, "stew", "b");
    expect(await models()).toMatchObject({ runner: "b", models: [{ id: "opus-b", efforts: [] }] });
    await models();
    expect(listed).toEqual({ a: 0, b: 1 });

    // An upgrade reconnects b, whose CLI now lists effort levels: the kept list is dropped.
    efforts["b"] = ["low", "high"];
    await hub.register("b", {
      protocol: RUNNER_PROTOCOL,
      version: "test",
      os: "linux",
      clis: ["claude"],
      residentClis: [],
      steerableClis: [],
      stoppableClis: [],
      branchReads: true,
      branchChanges: true,
      capabilities: [],
      slots: null,
      turns: [],
    });
    expect((await models()).models[0]?.efforts.map((effort) => effort.id)).toEqual(["low", "high"]);
    expect(listed).toEqual({ a: 0, b: 2 });
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
    await board.setRoleCharter(USER, {
      name: "researcher",
      purpose: "Researches.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    await board.addAgent(USER, {
      name: "sage",
      role: "researcher",
      cli: "claude",
      memberships: ["lab"],
    });
    const core = path.join(board.paths.agent("sage"), "memory", "core.md");
    await writeFile(core, "# Core memory\n\n- one\n- two\n- three\n- four\n- five\n", "utf8");
    await commitHome(board, "sage", "an earlier turn wrote the core");
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
    await board.setAgentRunner(USER, "sage", "a");
    await board.placeProject("lab", "b");
    const { run } = society;
    const [home, lab] = await Promise.all(
      (["society", "lab"] as const).map((project) =>
        run({
          agent: "sage",
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
    expect(await board.listHomeConflicts("sage")).toEqual([]);
    const authors = await execa("git", ["log", "--format=%an"], { cwd: board.paths.agent("sage") });
    expect(
      authors.stdout.split("\n").filter((name) => name === "sage").length,
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
    const [conflict, ...more] = await board.listHomeConflicts("sage");
    expect(more).toEqual([]);
    expect(conflict?.path).toMatch(/^memory\/core\.md\.conflict-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(conflict?.file).toBe("memory/core.md");
    // The copy's age is the commit that brought it, made moments ago on a runner.
    expect(Date.now() - Date.parse(conflict?.since ?? "")).toBeLessThan(60_000);
    const other = await readFile(
      path.join(board.paths.agent("sage"), conflict?.path ?? ""),
      "utf8",
    );
    // One version is in place and the other beside it; neither is lost.
    expect([kept, other].join("\n")).toContain("- three, as the society's work saw it");
    expect([kept, other].join("\n")).toContain("- three, as the lab saw it");
    // The history shows both turns' edits and the merge that kept the copy, with that alone.
    const { changes } = await board.homeHistory("sage", 30);
    const turns = changes.filter((change) => change.turnId !== undefined);
    expect(turns.map((change) => change.kind)).toEqual(["turn", "turn"]);
    expect(
      turns.every((change) => change.files.some((file) => file.path === "memory/core.md")),
    ).toBe(true);
    expect(
      changes.filter((change) => change.kind === "merge").map((change) => change.files),
    ).toEqual([[{ path: conflict?.path, status: "added", added: 7, removed: 0 }]]);
    await run({
      agent: "sage",
      project: "society",
      trigger: { kind: "manual", fromUser: true, reason: "test" },
      priority: 1,
    });
    expect(prompts.at(-1)).toContain("## Edits to reconcile in your home");
    expect(prompts.at(-1)).toContain(`- ${conflict?.path}, beside memory/core.md, since`);
  });

  it("ends a turn whose end the board could not record, rather than holding its conversation for good", async () => {
    const { board } = await Board.init(dir, { name: "unrecorded" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: () => Promise.resolve(completed("done")),
    };
    const { run } = await start(board, backend);
    const dispatch = {
      agent: "stew",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: false, reason: "test" },
      priority: 1,
    };
    const finish = vi.spyOn(board, "finishTurn").mockRejectedValueOnce(new Error("disk full"));
    await expect(run(dispatch)).rejects.toThrow("disk full");
    finish.mockRestore();
    await expect(run(dispatch)).resolves.toMatchObject({ exitReason: "completed" });
  });

  it("sends a job that never reached its runner again once it reconnects, and holds new turns meanwhile", async () => {
    const { board } = await Board.init(dir, { name: "silent" });
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
    society = await startTestSociety({
      board,
      backends: () => ({
        claude: {
          kind: "claude",
          newSession: () => Promise.resolve("s"),
          runTurn: () => Promise.resolve(completed("never runs here")),
        },
      }),
      ackTimeoutMs: 50,
      graceMs: 300,
    });
    const { run, hub } = society;
    const hello: RunnerHello = {
      protocol: RUNNER_PROTOCOL,
      version: "test",
      os: "linux",
      clis: ["claude"],
      residentClis: [],
      steerableClis: [],
      stoppableClis: [],
      branchReads: true,
      branchChanges: true,
      capabilities: [],
      slots: null,
      turns: [],
    };
    // A runner whose machine's network stopped passing traffic: its stream looks open, and
    // nothing written into it arrives.
    await board.addRunner(USER, "ghost");
    await hub.register("ghost", hello);
    const lost: RunnerMessage[] = [];
    await hub.attach("ghost", (message) => lost.push(message) > 0);
    await board.placeProject("demo", "ghost");
    const dispatch = {
      agent: "eng-1",
      project: "demo",
      trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
      priority: 2,
    };
    const first = run(dispatch);
    await vi.waitFor(() => expect(lost).toHaveLength(1));
    const job = lost[0]?.type === "turn" ? lost[0].job : null;
    expect(job).not.toBeNull();
    const turnId = job?.turnId ?? "";

    // Unacknowledged past the timeout, the runner gets no more turns, and the one it has carries on.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await hub.assign({ ...dispatch, onboarding: false })).toBeNull();
    expect(hub.unacknowledged("ghost")).toEqual([turnId]);

    // It connects again without the turn, which it never received: the job is sent again, not failed.
    await hub.register("ghost", hello);
    const delivered: RunnerMessage[] = [];
    const detach = await hub.attach("ghost", (message) => delivered.push(message) > 0);
    expect(delivered).toEqual([{ type: "turn", job }]);
    hub.received("ghost", turnId);
    expect(hub.unacknowledged("ghost")).toEqual([]);
    await hub.turnOutcome("ghost", turnId, {
      exitReason: "completed",
      status: null,
      error: null,
      usage: ZERO_USAGE,
      costUsd: 0,
      session: "s",
      model: null,
      work: null,
      leftovers: false,
    });
    expect(await first).toMatchObject({ exitReason: "completed" });

    // A job that never arrived on a runner that then stays away is said to have never reached it.
    const second = run(dispatch);
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    await detach();
    expect(await second).toMatchObject({
      exitReason: "error",
      error: expect.stringContaining("never reached runner ghost"),
    });
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

    // A runner that registers again without a turn it took: that turn ends as failed.
    const running = run(dispatch);
    await vi.waitFor(() => expect(runner.turns).toHaveLength(1));
    await vi.waitFor(() => expect(hub.unacknowledged("pod")).toEqual([]));
    await hub.register("pod", {
      protocol: RUNNER_PROTOCOL,
      version: "test",
      os: "linux",
      clis: ["claude"],
      residentClis: [],
      steerableClis: [],
      stoppableClis: [],
      branchReads: true,
      branchChanges: true,
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

  it("moves a project to a new default branch: the next task starts from it and lands on it", async () => {
    const { board } = await Board.init(dir, { name: "branches" });
    await board.addProject(USER, { slug: "demo", onDone: "merge" });
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    await board.addAgent(USER, {
      name: "sage",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const SAGE = { name: "sage", role: "engineer" };
    const refused: string[] = [];
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        const { cwd } = request.spec;
        await writeFile(path.join(cwd, "notes.md"), `${request.prompt.length}\n`);
        await execa("git", ["add", "notes.md"], { cwd });
        await execa(
          "git",
          ["-c", "user.name=sage", "-c", "user.email=sage@x", "commit", "-m", "notes"],
          {
            cwd,
          },
        );
        // Landing its own work on the default branch is the board's, and the runner refuses it.
        const guarded = (
          await execa("git", ["config", "--get", "stellaris.guardBranch"], { cwd })
        ).stdout.trim();
        const moved = await execa("git", ["update-ref", `refs/heads/${guarded}`, "HEAD"], {
          cwd,
          reject: false,
        });
        if (moved.exitCode !== 0) {
          refused.push(guarded);
        }
        return completed("wrote notes");
      },
    };
    const { run, runner, hub } = await start(board, backend);
    const turnOn = (taskId: string) =>
      run({
        agent: "sage",
        project: "demo",
        thread: { id: taskId, task: true },
        trigger: { kind: "manual", fromUser: true, reason: "test" },
        priority: 2,
      });
    const first = await board.createTask(USER, { project: "demo", title: "first" });
    expect((await turnOn(first.id)).exitReason).toBe("completed");

    // The repository has only main; the next turn makes trunk where the clone stands.
    await board.configureProject(USER, { project: "demo", default_branch: "trunk" });
    const second = await board.createTask(USER, { project: "demo", title: "second" });
    expect((await turnOn(second.id)).exitReason).toBe("completed");
    const repo = runner.paths.repo("demo");
    const log = async (ref: string) =>
      (await execa("git", ["log", "--oneline", ref], { cwd: repo })).stdout;
    await board.claimTask(SAGE, { task_id: second.id });
    expect(await board.advanceTask(SAGE, { task_id: second.id })).toMatchObject({
      completing: true,
    });
    expect(await hub.completeTask("demo", second.id)).toBe("done");
    expect(await log("trunk")).toContain(`merge: land task/${second.id} on trunk`);
    expect(await log("main")).not.toContain(`merge: land task/${second.id}`);
    expect((await board.getTask(USER, { task_id: second.id })).status).toBe("done");
    // The guard followed the default branch from main to trunk.
    expect(refused).toEqual(["main", "trunk"]);
  });

  it("lands a ghpr task by merging its pull request with the message its agent gave", async () => {
    // GitHub, played by a bare repository that git reaches for the project's GitHub address.
    const seed = path.join(dir, "seed");
    await execa("git", ["init", "-b", "main", seed]);
    await writeFile(path.join(seed, "README.md"), "demo\n");
    await execa("git", ["add", "README.md"], { cwd: seed });
    await execa("git", ["-c", "user.name=u", "-c", "user.email=u@x", "commit", "-m", "root"], {
      cwd: seed,
    });
    const origin = path.join(dir, "origin.git");
    await execa("git", ["clone", "--bare", seed, origin]);
    const rewrite = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/acme/demo",
    };
    Object.assign(process.env, rewrite);
    const rev = async (ref: string) =>
      (await execa("git", ["rev-parse", ref], { cwd: origin })).stdout.trim();
    const pulls = new Map<number, { branch: string; head: string; merged: string | null }>();
    const merges: Array<{ subject: string; body: string }> = [];
    const deleted: string[] = [];
    const github: PullRequestOps = {
      view: (url) => {
        const pull = pulls.get(pullNumber(url));
        if (pull === undefined) {
          return Promise.reject(new Error("no such pull request"));
        }
        return Promise.resolve({
          number: pullNumber(url),
          state: pull.merged === null ? "OPEN" : "MERGED",
          title: `pull request ${pullNumber(url)}`,
          baseRefName: "main",
          headRefName: pull.branch,
          headRefOid: pull.head,
          isCrossRepository: false,
          mergeCommit: pull.merged,
        });
      },
      merge: async (url, head, message) => {
        const pull = pulls.get(pullNumber(url));
        if (pull === undefined || pull.head !== head) {
          throw new Error("Head branch was modified");
        }
        const merged = await commitTree(
          origin,
          `${head}^{tree}`,
          [await rev("main"), head],
          [message.subject, message.body],
        );
        await execa("git", ["update-ref", "refs/heads/main", merged], { cwd: origin });
        pull.merged = merged;
        merges.push(message);
      },
      deleteBranch: async (_url, branch) => {
        await execa("git", ["update-ref", "-d", `refs/heads/${branch}`], { cwd: origin });
        deleted.push(branch);
      },
    };
    try {
      const { board } = await Board.init(dir, { name: "ghpr" });
      await board.addProject(USER, {
        slug: "demo",
        repo: "https://github.com/acme/demo",
        onDone: "ghpr",
      });
      await board.setRoleCharter(USER, {
        name: "engineer",
        purpose: "Builds.",
        verbs: [...MEMBER_VERBS],
        wakeTriggers: ["heartbeat"],
      });
      await board.addAgent(USER, {
        name: "sage",
        role: "engineer",
        cli: "claude",
        memberships: ["demo"],
      });
      const SAGE = { name: "sage", role: "engineer" };
      // The agent opens its pull request from a branch named for what it does, as gh would show it.
      const opened: Array<{ number: number; branch: string; content: string }> = [];
      const backend: AgentBackend = {
        kind: "claude",
        newSession: () => Promise.resolve("session-1"),
        runTurn: async (request) => {
          const { cwd } = request.spec;
          const next = opened.shift();
          if (next !== undefined) {
            await writeFile(path.join(cwd, "feature.md"), next.content);
            await execa("git", ["add", "feature.md"], { cwd });
            await execa(
              "git",
              ["-c", "user.name=sage", "-c", "user.email=sage@x", "commit", "-m", "feat: add"],
              { cwd },
            );
            await execa("git", ["push", "origin", `HEAD:${next.branch}`], { cwd });
            const head = await rev(next.branch);
            await execa("git", ["update-ref", `refs/pull/${next.number}/head`, head], {
              cwd: origin,
            });
            pulls.set(next.number, { branch: next.branch, head, merged: null });
          }
          return completed("opened the pull request");
        },
      };
      society = await startTestSociety({
        board,
        backends: () => ({ claude: backend }),
        pullRequests: github,
      });
      const { run, hub, runner } = society;
      const finish = async (taskId: string, pull: number) => {
        opened.push({ number: pull, branch: `feat/readable-${pull}`, content: `${pull}\n` });
        expect(
          (
            await run({
              agent: "sage",
              project: "demo",
              thread: { id: taskId, task: true },
              trigger: { kind: "manual", fromUser: true, reason: "test" },
              priority: 2,
            })
          ).exitReason,
        ).toBe("completed");
        await board.updateTask(SAGE, {
          task_id: taskId,
          pull_request: {
            url: `https://github.com/acme/demo/pull/${pull}`,
            merge_subject: "feat: add the readable feature",
            merge_body: "Adds it.\n\nCo-Authored-By: sage <sage@x>",
          },
        });
        await board.claimTask(SAGE, { task_id: taskId });
        await board.advanceTask(SAGE, { task_id: taskId });
        return hub.completeTask("demo", taskId);
      };

      const first = await board.createTask(USER, { project: "demo", title: "readable" });
      expect(await finish(first.id, 1)).toBe("done");
      expect((await board.getTask(USER, { task_id: first.id })).status).toBe("done");
      expect(merges).toEqual([
        {
          subject: "feat: add the readable feature",
          body: "Adds it.\n\nCo-Authored-By: sage <sage@x>",
        },
      ]);
      const landed = await rev("main");
      expect(
        (
          await execa("git", ["log", "-1", "--format=%B", landed], { cwd: origin })
        ).stdout.trimEnd(),
      ).toBe("feat: add the readable feature\n\nAdds it.\n\nCo-Authored-By: sage <sage@x>");
      // The merged branch is gone, and the runner's clone follows the remote at once.
      expect(deleted).toEqual(["feat/readable-1"]);
      const clone = runner.paths.repo("demo");
      expect((await execa("git", ["rev-parse", "main"], { cwd: clone })).stdout.trim()).toBe(
        landed,
      );
      expect((await board.listThread(first.id)).at(-1)?.body).toContain(
        "merged pull request #1 (https://github.com/acme/demo/pull/1) into main",
      );

      // Someone else pushed to the pull request after the agent: it no longer holds the task's
      // work, so the board merges nothing and the task waits at its last stage.
      const second = await board.createTask(USER, { project: "demo", title: "drifted" });
      opened.push({ number: 2, branch: "feat/drifted", content: "2\n" });
      await run({
        agent: "sage",
        project: "demo",
        thread: { id: second.id, task: true },
        trigger: { kind: "manual", fromUser: true, reason: "test" },
        priority: 2,
      });
      const drifted = await commitTree(
        origin,
        `${landed}^{tree}`,
        [await rev("feat/drifted")],
        ["someone else"],
      );
      await execa("git", ["update-ref", "refs/pull/2/head", drifted], { cwd: origin });
      pulls.set(2, { branch: "feat/drifted", head: drifted, merged: null });
      await board.updateTask(SAGE, {
        task_id: second.id,
        pull_request: { url: "https://github.com/acme/demo/pull/2" },
      });
      await board.claimTask(SAGE, { task_id: second.id });
      await board.advanceTask(SAGE, { task_id: second.id });
      expect(await hub.completeTask("demo", second.id)).toBe("done");
      expect(await board.getTask(USER, { task_id: second.id })).toMatchObject({
        status: "open",
        completing: false,
      });
      expect((await board.listThread(second.id)).at(-1)?.body).toContain(
        "does not hold the same files as task/",
      );
      expect(merges).toHaveLength(1);
    } finally {
      for (const key of Object.keys(rewrite)) {
        Reflect.deleteProperty(process.env, key);
      }
    }
  });

  it("reads what a task's turns left from its branch on the project's runner", async () => {
    const { board, userToken } = await Board.init(dir, { name: "files" });
    for (const slug of ["demo", "idle"]) {
      await board.addProject(USER, { slug });
    }
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    await board.addAgent(USER, {
      name: "sage",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const task = await board.createTask(USER, { project: "demo", title: "report" });
    const waiting = await board.createTask(USER, { project: "idle", title: "not started" });
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        await mkdir(path.join(request.spec.cwd, "evidence"), { recursive: true });
        await writeFile(path.join(request.spec.cwd, "report.md"), "# Report\n");
        await writeFile(
          path.join(request.spec.cwd, "evidence", "plot.png"),
          Buffer.from([0, 1, 2]),
        );
        return completed("wrote the report");
      },
    };
    const { app, run, runner, hub } = await start(board, backend);
    await run({
      agent: "sage",
      project: "demo",
      thread: { id: task.id, task: true },
      trigger: { kind: "manual", fromUser: true, reason: "test" },
      priority: 2,
    });
    const read = (route: string) =>
      app.request(`/api/tasks/${route}`, { headers: { authorization: `Bearer ${userToken}` } });

    const report = await read(`${task.id}/files/report.md`);
    expect(report.status).toBe(200);
    const file = BranchFileSchema.parse(await report.json());
    expect(file).toMatchObject({ kind: "file", path: "report.md", size: 9 });
    expect(Buffer.from(file.kind === "file" ? (file.content ?? "") : "", "base64").toString()).toBe(
      "# Report\n",
    );
    expect(file.commit.author).toBe("sage");
    const root = BranchFileSchema.parse(await (await read(`${task.id}/files`)).json());
    expect(root.kind === "dir" ? root.entries.map((entry) => entry.name) : null).toEqual([
      "evidence",
      "report.md",
    ]);
    expect(
      BranchFileSchema.parse(await (await read(`${task.id}/files/evidence/plot.png`)).json()),
    ).toMatchObject({ kind: "file", size: 3, content: Buffer.from([0, 1, 2]).toString("base64") });

    // The task's view lists what its branch changed, each file with the citizen whose turn wrote it.
    const changes = BranchChangesSchema.parse(await (await read(`${task.id}/changes`)).json());
    expect(changes).toMatchObject({ total: 2, head: { author: "sage" } });
    expect(changes.files).toEqual([
      {
        path: "evidence/plot.png",
        status: "added",
        added: null,
        removed: null,
        lastChange: { author: "sage", at: changes.head.at },
      },
      {
        path: "report.md",
        status: "added",
        added: 1,
        removed: 0,
        lastChange: { author: "sage", at: changes.head.at },
      },
    ]);
    expect((await read(`${waiting.id}/changes`)).status).toBe(404);

    expect((await read(`${task.id}/files/draft.md`)).status).toBe(404);
    // A URL's own `..` is resolved before any route sees it; one hidden behind encoded slashes is refused.
    expect((await read(`${task.id}/files/evidence%2F..%2Freport.md`)).status).toBe(400);
    // A project no turn has run in has no repository on any runner yet.
    expect((await read(`${waiting.id}/files/report.md`)).status).toBe(404);

    // A runner from before file reads is refused at once rather than left to time out.
    await hub.register("pod", {
      protocol: RUNNER_PROTOCOL,
      version: "0.3.1",
      os: "linux",
      clis: ["claude"],
      residentClis: [],
      steerableClis: [],
      stoppableClis: [],
      branchReads: false,
      branchChanges: false,
      capabilities: [],
      slots: null,
      turns: [],
    });
    expect((await board.readRunner("pod")).version).toBe("0.3.1");
    const old = await read(`${task.id}/files/report.md`);
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ message: expect.stringContaining("upgrade it") });
    expect((await read(`${task.id}/changes`)).status).toBe(409);

    await runner.stop();
    await vi.waitFor(() => expect(hub.connected).toEqual([]));
    const away = await read(`${task.id}/files/report.md`);
    expect(away.status).toBe(503);
    expect(await away.json()).toMatchObject({ error: "RUNNER_AWAY" });
  });

  it("speaks only to runners that hold a token, a matching protocol, and a turn for the home they ask for", async () => {
    const { board } = await Board.init(dir, { name: "auth" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: () => Promise.resolve(completed("done")),
      listModels: () =>
        Promise.resolve([
          { id: "opus", name: "Opus", description: "", isDefault: true, efforts: [] },
        ]),
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
      { id: "opus", name: "Opus", description: "", isDefault: true, efforts: [] },
    ]);
  });

  it("enrolls a runner the user approves on the board, hands its token over once, and refuses a denied one", async () => {
    const { board, userToken } = await Board.init(dir, { name: "enroll" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: () => Promise.resolve(completed("done")),
    };
    const { app, url } = await start(board, backend);
    const as = (bearer: string, route: string, body?: unknown) =>
      app.request(route, {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      });
    const codes: string[] = [];
    const ask = () =>
      enrollRunner({
        serverUrl: `${url}/`,
        version: "test",
        clis: ["claude"],
        capabilities: ["gpu"],
        hostname: "studio.local",
        onCode: (enrollment, approveUrl) => {
          codes.push(enrollment.userCode);
          expect(approveUrl).toBe(`${url}/runners?code=${enrollment.userCode}`);
        },
      });

    const enrolled = ask();
    await vi.waitFor(() => expect(codes).toHaveLength(1));
    const code = codes[0] ?? "";
    expect(await (await as(userToken, "/api/enrollments")).json()).toMatchObject([
      { userCode: code, hostname: "studio.local", clis: ["claude"], capabilities: ["gpu"] },
    ]);
    // Only the user lets a machine in.
    const stew = board.issueTurnToken("stew", "steward", 60_000);
    expect((await as(stew, "/api/enrollments")).status).toBe(403);
    expect((await as(stew, `/api/enrollments/${code}/approve`, { name: "studio" })).status).toBe(
      403,
    );
    // A code as typed, in lower case and without its hyphen, is the same code.
    const typed = code.toLowerCase().replace("-", "");
    expect(
      (await as(userToken, `/api/enrollments/${typed}/approve`, { name: "studio" })).status,
    ).toBe(200);
    const { name, token } = await enrolled;
    expect(name).toBe("studio");
    expect(await (await as(userToken, "/api/enrollments")).json()).toEqual([]);
    const added = (await board.readEvents(null)).find(
      (event) => event.type === "runner.added" && event.payload["name"] === "studio",
    );
    expect(added?.payload["enrolledFrom"]).toBe("studio.local");

    // What approval returned is the runner's, kept readable by its user alone, for its server.
    const runnerDir = path.join(dir, "studio-runner");
    const layout = new RunnerLayout(runnerDir);
    await saveCredentials(layout, { serverUrl: `${url}/`, name, token });
    expect(await readCredentials(layout, url)).toEqual({ serverUrl: `${url}/`, name, token });
    expect(await readCredentials(layout, "http://127.0.0.1:1")).toBeNull();
    expect((await stat(layout.credentials)).mode & 0o777).toBe(0o600);
    const studio = createRunner({
      serverUrl: url,
      token,
      dataDir: runnerDir,
      backends: { claude: backend },
      version: "test",
      slots: 1,
      retryMs: 50,
    });
    await studio.start();
    expect(studio.name).toBe("studio");
    await studio.stop();

    const denied = ask();
    await vi.waitFor(() => expect(codes).toHaveLength(2));
    expect((await as(userToken, `/api/enrollments/${codes[1] ?? ""}/deny`, {})).status).toBe(200);
    await expect(denied).rejects.toBeInstanceOf(EnrollmentDeniedError);

    // Asking is limited per address: two asks so far from this one, and three more are let through.
    const askRaw = () =>
      fetch(`${url}/runner/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol: RUNNER_PROTOCOL,
          version: "test",
          hostname: "flood",
          os: "linux",
          clis: [],
        }),
      });
    for (let n = 0; n < 3; n += 1) {
      expect((await askRaw()).status).toBe(200);
    }
    const limited = await askRaw();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    // A token the server does not know is refused at the start rather than tried forever.
    const stranger = createRunner({
      serverUrl: url,
      token: "stl_nothing",
      dataDir: path.join(dir, "stranger"),
      backends: { claude: backend },
      version: "test",
      slots: 1,
      retryMs: 50,
    });
    await expect(stranger.start()).rejects.toMatchObject({ status: 401 });
  });
});
