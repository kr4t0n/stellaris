import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { Scheduler } from "@stellaris/scheduler";
import {
  createRunner,
  EnrollmentDeniedError,
  GitIdentityCheck,
  enrollRunner,
  readCredentials,
  ResumeError,
  RunnerLayout,
  saveCredentials,
  ZERO_USAGE,
  type AgentBackend,
  type PullRequestOps,
  type ResidentSession,
  type TurnResult,
} from "@stellaris/runner-core";
import {
  addUsage,
  BranchChangesSchema,
  BranchFileDiffSchema,
  BranchFileSchema,
  CliQuotaSchema,
  HOME_FILE_LIMIT_BYTES,
  MEMBER_VERBS,
  RUNNER_PROTOCOL,
  RunnerModelsSchema,
  TurnDispatchSchema,
  type AgentEvent,
  type GitIdentityPart,
  type RunnerHello,
  type RunnerMessage,
  type Usage,
} from "@stellaris/shared";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

/** A time a few minutes past noon on 2026-10-13, for quota reports. */
function quotaTime(minute: number): string {
  return `2026-10-13T12:0${minute}:00.000Z`;
}

/** A 5-hour window of a quota report, used this much, reported at `minute`. */
function fiveHour(usedPercent: number, minute: number) {
  return {
    key: "five_hour",
    minutes: 300,
    usedPercent,
    resetsAt: "2026-10-13T17:00:00.000Z",
    observedAt: quotaTime(minute),
  };
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
  /** Every request and resident start the runner handed over, as given. */
  readonly handed: object[] = [];
  memoryUpdatedNext = false;
  coldMemoryUpdatedNext = false;

  newSession(): Promise<string> {
    return Promise.resolve("session-1");
  }

  runTurn(request: object): Promise<TurnResult> {
    this.handed.push(request);
    this.coldTurns.push("cold");
    const result = completed("cold turn", this.coldMemoryUpdatedNext);
    this.coldMemoryUpdatedNext = false;
    return Promise.resolve(result);
  }

  startResident(
    spec: { agent: string; model?: string | undefined; effort?: string | undefined },
    start: { session: string },
  ): Promise<ResidentSession> {
    this.handed.push(start);
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
  /** Whether the next turn fails to resume its session, reporting no running total. */
  failNext = false;
  private total = 0;

  newSession(): Promise<string> {
    return Promise.resolve("session-1");
  }

  runTurn(request: { costSoFarUsd?: number | undefined }): Promise<TurnResult> {
    this.startedFrom.push(request.costSoFarUsd ?? 0);
    if (this.failNext) {
      this.failNext = false;
      return Promise.resolve({
        ...completed(""),
        costUsd: 0,
        status: null,
        exitReason: "error",
        error: "Claude Code returned an error result",
        resumeFailed: "retry",
      });
    }
    this.total += 0.25;
    const sessionCostUsd = this.total;
    return Promise.resolve({
      ...completed("cold turn"),
      costUsd: sessionCostUsd - (request.costSoFarUsd ?? 0),
      sessionCostUsd,
    });
  }
}

const TURN_USAGE: Usage = {
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 1_000,
  cacheWriteTokens: 5,
};

/**
 * A backend whose session reports its running usage, as Claude's `modelUsage` does, cold or warm:
 * each turn that sees a result adds `TURN_USAGE` to it, and one that sees none reports none.
 */
class UsageTotalingBackend implements AgentBackend {
  readonly kind = "claude" as const;
  /** The running usage each cold turn and each warm start was handed, in order. */
  readonly startedFrom: Array<Usage | undefined> = [];
  /** The folder each cold turn ran in. */
  readonly cwds: string[] = [];
  /** Whether the next turn sees no result. */
  noResult = false;
  private total: Usage = ZERO_USAGE;

  newSession(): Promise<string> {
    return Promise.resolve("session-1");
  }

  runTurn(request: { usageSoFar?: Usage | undefined; spec: { cwd: string } }): Promise<TurnResult> {
    this.startedFrom.push(request.usageSoFar);
    this.cwds.push(request.spec.cwd);
    this.total = request.usageSoFar ?? ZERO_USAGE;
    return Promise.resolve(this.turn("cold turn"));
  }

  startResident(
    _spec: object,
    start: { session: string; usageSoFar?: Usage | undefined },
  ): Promise<ResidentSession> {
    this.startedFrom.push(start.usageSoFar);
    this.total = start.usageSoFar ?? ZERO_USAGE;
    return Promise.resolve({
      session: start.session,
      runTurn: () => Promise.resolve(this.turn("warm turn")),
      close: () => Promise.resolve(),
    });
  }

  private turn(summary: string): TurnResult {
    if (this.noResult) {
      this.noResult = false;
      return completed(summary);
    }
    this.total = addUsage(this.total, TURN_USAGE);
    return { ...completed(summary), usage: TURN_USAGE, sessionUsage: this.total };
  }
}

/** `TURN_USAGE` times `turns`, the running usage after that many turns that saw a result. */
function turnsOfUsage(turns: number): Usage {
  return {
    inputTokens: TURN_USAGE.inputTokens * turns,
    outputTokens: TURN_USAGE.outputTokens * turns,
    cacheReadTokens: TURN_USAGE.cacheReadTokens * turns,
    cacheWriteTokens: TURN_USAGE.cacheWriteTokens * turns,
  };
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

/** Commits nothing, as `agent`, in a worktree; returns the commit. */
async function commitEmpty(cwd: string, agent: string, message: string): Promise<string> {
  await execa(
    "git",
    [
      "-c",
      `user.name=${agent}`,
      "-c",
      `user.email=${agent}@x`,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      message,
    ],
    { cwd },
  );
  return (await execa("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
}

/** A verb's answer or refusal, as a JSON object. */
const AnswerSchema = z.record(z.string(), z.unknown());

/** The smallest PNG there is: one transparent pixel. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const deskPost = {
  agent: "desk",
  project: "society",
  trigger: { kind: "user_post" as const, fromUser: true, reason: "posted" },
  priority: 2,
};

/** A signal reader's backend that keeps each prompt's signal lines, the runner's connection left out. */
function signalReader(): { backend: AgentBackend; listed: string[][] } {
  const listed: string[][] = [];
  const backend: AgentBackend = {
    kind: "claude",
    newSession: () => Promise.resolve("session-1"),
    runTurn: (request) => {
      listed.push(
        request.prompt
          .split("\n")
          .filter(
            (line) => /^- \[[^\]]+\] [a-z_]+: /.test(line) && !/^- \[[^\]]+\] runner: /.test(line),
          ),
      );
      return Promise.resolve(completed("read the signals"));
    },
  };
  return { backend, listed };
}

const stewardTurn = {
  agent: "steward-1",
  project: "society",
  trigger: { kind: "ops_event" as const, from: "board", fromUser: false, reason: "a role gap" },
  priority: 0,
};

/** A scheduled reflection of a citizen's home in a scope. */
function reflection(agent: string, project = "society") {
  return {
    agent,
    project,
    trigger: { kind: "reflection" as const, reason: "scheduled reflection" },
    priority: 0,
  };
}

/** A wake the user asked of a citizen's home in a scope. */
function manual(agent: string, project: string) {
  return {
    agent,
    project,
    trigger: { kind: "manual" as const, fromUser: true, reason: "work" },
    priority: 2,
  };
}

/** Logs a spend report worded as the scheduler's `reportCost` words it. */
async function spendReport(board: Board, turns: number, cost: number): Promise<void> {
  await board.publishSignal({
    kind: "turn_cost",
    key: "turn_cost",
    summary: `${turns} turn(s) completed for $${cost.toFixed(2)} since the last report`,
    value: cost,
  });
}

/** Logs one idle member's condition `count` times, to fill the newest signals a prompt reads. */
async function idleRepeats(board: Board, count: number): Promise<void> {
  for (let days = 1; days <= count; days += 1) {
    await board.publishSignal({
      kind: "idle_member",
      key: "idle_member:eng-1",
      summary: `eng-1 (engineer) has not completed a turn for ${days}d`,
      value: days,
      agent: "eng-1",
      wakes: false,
    });
  }
}

/** When each spend report was logged, oldest first. */
async function spendTimes(board: Board): Promise<string[]> {
  return (await board.listSignals(10_000))
    .filter((record) => record.signal.kind === "turn_cost")
    .map((record) => record.ts);
}

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

  it("keeps a task's branch for its stage's holder, and puts commits made beside it on it or says why not", async () => {
    const { board } = await Board.init(dir, { name: "beside" });
    await board.addProject(USER, { slug: "demo" });
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    for (const name of ["ref", "eng-1"]) {
      await board.addAgent(USER, { name, role: "engineer", cli: "claude", memberships: ["demo"] });
    }
    const holder = { name: "eng-1", role: "engineer" } as const;

    // ref, a participant, is in a turn in the task's thread while eng-1, its stage's holder, works.
    let refStarted = Promise.withResolvers<void>();
    let refRelease = Promise.withResolvers<void>();
    let engWork: ((cwd: string) => Promise<void>) | null = null;
    let refWork: ((cwd: string) => Promise<void>) | null = null;
    const seen = new Map<string, { branch: string; prompt: string }>();
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        const actor = board.resolveToken(request.mcp.token);
        const { cwd } = request.spec;
        const head = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
        seen.set(`${actor?.name}/${actor?.thread}`, {
          branch: head.stdout.trim(),
          prompt: request.prompt,
        });
        if (actor?.name === "ref") {
          await refWork?.(cwd);
          refStarted.resolve();
          await refRelease.promise;
        } else {
          await engWork?.(cwd);
        }
        return completed("done");
      },
    };
    const { run, runner } = await start(board, backend);
    const turn = (agent: string, task: string) =>
      run({
        agent,
        project: "demo",
        thread: { id: task, task: true },
        trigger: { kind: "mention", fromUser: true, reason: "mentioned by user" },
        priority: 2,
      });
    const tip = async (task: string) =>
      (
        await execa("git", ["rev-parse", `task/${task}`], { cwd: runner.paths.repo("demo") })
      ).stdout.trim();
    const notices = async (task: string) =>
      (await board.listThread(task)).filter((message) => message.author === "board");
    const overlap = async (task: string) => {
      refStarted = Promise.withResolvers<void>();
      refRelease = Promise.withResolvers<void>();
      const participant = turn("ref", task);
      await refStarted.promise;
      return {
        participant,
        release: async () => {
          refRelease.resolve();
          await participant;
        },
      };
    };

    // The holder's turn has the branch though the participant's started first, which works beside it.
    const held = await board.createTask(USER, { project: "demo", title: "held" });
    await board.claimTask(holder, { task_id: held.id });
    let reviewed = "";
    engWork = async (cwd) => {
      reviewed = await commitEmpty(cwd, "eng-1", "review");
    };
    const first = await overlap(held.id);
    await turn("eng-1", held.id);
    expect(seen.get(`eng-1/${held.id}`)?.branch).toBe(`task/${held.id}`);
    expect(seen.get(`ref/${held.id}`)?.branch).toBe("HEAD");
    expect(seen.get(`ref/${held.id}`)?.prompt).toContain(
      `eng-1 holds the task's stage, and its turns have task/${held.id} to themselves`,
    );
    expect(await tip(held.id)).toBe(reviewed);
    await first.release();
    expect(await tip(held.id)).toBe(reviewed);

    // The user takes no turns, so a stage it holds keeps the branch from nobody.
    const approval = await board.createTask(USER, {
      project: "demo",
      title: "approval",
      stages: [{ name: "approve", agent: "user" }],
    });
    await board.claimTask(USER, { task_id: approval.id });
    // Released above, so this turn of ref's runs straight through.
    await turn("ref", approval.id);
    expect(seen.get(`ref/${approval.id}`)?.branch).toBe(`task/${approval.id}`);

    // Taken before anyone held the stage, the branch stays the participant's: the holder works
    // beside it, and its commits go on the branch once the participant's turn lets it go.
    const open = await board.createTask(USER, { project: "demo", title: "open" });
    const second = await overlap(open.id);
    const before = await tip(open.id);
    await board.claimTask(holder, { task_id: open.id });
    await turn("eng-1", open.id);
    expect(seen.get(`eng-1/${open.id}`)?.branch).toBe("HEAD");
    expect(seen.get(`eng-1/${open.id}`)?.prompt).toContain(
      `another turn in this task has task/${open.id} checked out`,
    );
    expect(await tip(open.id)).toBe(before);
    await second.release();
    expect(await tip(open.id)).toBe(reviewed);
    expect(await notices(open.id)).toEqual([]);

    // When the participant's turn commits on the branch meanwhile, the holder's commits are left
    // where they are, and the task's thread is told once.
    const split = await board.createTask(USER, { project: "demo", title: "split" });
    const third = await overlap(split.id);
    await board.claimTask(holder, { task_id: split.id });
    let refHead = "";
    engWork = async (cwd) => {
      refHead = await commitEmpty(runner.paths.taskWorktree("ref", split.id), "ref", "ref work");
      // Backticks in a subject end the notice's code span early, which would leave the name awake.
      reviewed = await commitEmpty(cwd, "eng-1", "eng-1 review of `x` for @ref");
      // A branch of its own holds the commit too, which leaves it no less beside the task's.
      await execa("git", ["branch", "fix/review"], { cwd });
    };
    await turn("eng-1", split.id);
    expect(await tip(split.id)).toBe(refHead);
    const told = await notices(split.id);
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toContain(
      `eng-1's worktree for this task holds commits that \`task/${split.id}\` lacks`,
    );
    expect(told[0]?.body).toContain(`\`${reviewed.slice(0, 7)} eng-1 review of \`x\` for ref\``);
    expect(told[0]?.mentions).toEqual([]);
    await third.release();
    expect(await tip(split.id)).toBe(refHead);
    expect(await notices(split.id)).toHaveLength(1);
    expect(
      (
        await execa("git", ["rev-parse", "HEAD"], {
          cwd: runner.paths.taskWorktree("eng-1", split.id),
        })
      ).stdout,
    ).toBe(reviewed);

    // The holder's next turn there is left where its commits are and told so; once it commits
    // again, the thread is told of the new head too.
    let again = "";
    engWork = async (cwd) => {
      expect((await execa("git", ["rev-parse", "HEAD"], { cwd })).stdout).toBe(reviewed);
      again = await commitEmpty(cwd, "eng-1", "eng-1 second look");
    };
    await turn("eng-1", split.id);
    expect(seen.get(`eng-1/${split.id}`)?.prompt).toContain(
      `This worktree holds commits that task/${split.id} lacks, so it was left where it is`,
    );
    const toldAgain = await notices(split.id);
    expect(toldAgain).toHaveLength(2);
    expect(toldAgain[1]?.body).toContain(`\`${again.slice(0, 7)} eng-1 second look\``);
    expect(await tip(split.id)).toBe(refHead);

    // A participant's commits made beside the holder's turn follow the branch too, but only from
    // its own hand-back: the holder's leaves the worktree of a turn still running alone.
    const beside = await board.createTask(USER, { project: "demo", title: "beside" });
    await board.claimTask(holder, { task_id: beside.id });
    let note = "";
    refWork = async (cwd) => {
      note = await commitEmpty(cwd, "ref", "ref note");
    };
    engWork = null;
    const fourth = await overlap(beside.id);
    // The participant's turn has committed beside the branch by now, which stays where it was.
    const from = await tip(beside.id);
    expect(from).not.toBe(note);
    await turn("eng-1", beside.id);
    expect(seen.get(`eng-1/${beside.id}`)?.branch).toBe(`task/${beside.id}`);
    expect(await tip(beside.id)).toBe(from);
    await fourth.release();
    expect(await tip(beside.id)).toBe(note);
    expect(await notices(beside.id)).toEqual([]);
  });

  it("gives a task's branch to any turn once its holder's lease has run out", async () => {
    // Every claim's lease runs out at once, as a holder's does that no turn renews.
    const { board } = await Board.init(dir, { name: "lapsed" }, { leaseMs: 1 });
    await board.addProject(USER, { slug: "demo" });
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    for (const name of ["ref", "eng-1"]) {
      await board.addAgent(USER, { name, role: "engineer", cli: "claude", memberships: ["demo"] });
    }
    const task = await board.createTask(USER, { project: "demo", title: "lapsed" });
    await board.claimTask({ name: "eng-1", role: "engineer" }, { task_id: task.id });
    let branch = "";
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        const head = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: request.spec.cwd,
        });
        branch = head.stdout.trim();
        return completed("done");
      },
    };
    const { run } = await start(board, backend);
    const turn = (id: string) =>
      run({
        agent: "ref",
        project: "demo",
        thread: { id, task: true },
        trigger: { kind: "mention", fromUser: true, reason: "mentioned by user" },
        priority: 2,
      });
    await turn(task.id);
    expect(branch).toBe(`task/${task.id}`);
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

  it("lists each condition once in a reader's prompt, at its latest log", async () => {
    const { board } = await Board.init(dir, { name: "signals" });
    await board.addAgent(USER, { name: "steward-1", role: "steward", cli: "claude" });
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
    const idle = (days: number) =>
      board.publishSignal({
        kind: "idle_member",
        key: "idle_member:eng-1",
        summary: `eng-1 (engineer) has not completed a turn for ${days}d`,
        value: days,
        agent: "eng-1",
        wakes: false,
      });
    await idle(3);
    await board.publishSignal({
      kind: "role_gap",
      key: "role_gap:lab:referee",
      summary: "a stage waits on the referee role, which nobody fills",
      value: 1,
    });
    await idle(4);
    for (const cost of [1, 2]) {
      await board.publishSignal({
        kind: "turn_cost",
        key: "turn_cost",
        summary: `1 turn(s) completed for $${cost}.00 since the last report`,
        value: cost,
      });
    }
    await run({
      agent: "steward-1",
      project: "society",
      trigger: { kind: "ops_event" as const, from: "board", fromUser: false, reason: "a role gap" },
      priority: 0,
    });
    const listed = (prompts[0] ?? "")
      .split("\n")
      .filter((line) => /^- \[[^\]]+\] [a-z_]+: /.test(line))
      .map((line) => line.replace(/^- \[[^\]]+\] /, "").replace(/ \([^()]*\)$/, ""))
      // The runner's connection is logged too.
      .filter((line) => !line.startsWith("runner: "));
    expect(listed).toEqual([
      "role_gap: a stage waits on the referee role, which nobody fills",
      "idle_member: eng-1 (engineer) has not completed a turn for 4d",
      expect.stringMatching(
        /^turn_cost: 2 turn\(s\) completed for \$3\.00 in 2 hourly report\(s\) /,
      ),
    ]);
  });

  it("sums the spend reports logged since a reader's last turn into one line", async () => {
    const { board } = await Board.init(dir, { name: "signals" });
    await board.addAgent(USER, { name: "steward-1", role: "steward", cli: "claude" });
    const { backend, listed } = signalReader();
    const { run } = await start(board, backend);
    // Logged before the reader's last turn, so left out of the next one's sum.
    await spendReport(board, 9, 9);
    await run(stewardTurn);
    await spendReport(board, 2, 1.25);
    await spendReport(board, 5, 4.5);
    // More conditions than the prompt lists: the oldest goes, while the sum around them stays.
    for (let gap = 0; gap < 30; gap += 1) {
      await board.publishSignal({
        kind: "role_gap",
        key: `role_gap:lab:role-${gap}`,
        summary: `a stage waits on the role-${gap} role, which nobody fills`,
        value: 1,
      });
    }
    await spendReport(board, 1, 0.75);
    await run(stewardTurn);
    await spendReport(board, 3, 2);
    await run(stewardTurn);
    await spendReport(board, 3, 2);
    await board.publishSignal({
      kind: "turn_cost",
      key: "turn_cost",
      summary: "spend in the last hour: $1.20",
      value: 1.2,
    });
    await run(stewardTurn);
    const at = await spendTimes(board);
    expect(listed[1]).toHaveLength(30);
    expect(listed[1]?.[0]).toMatch(/ role_gap: a stage waits on the role-1 role, /);
    expect(listed[1]?.at(-1)).toBe(
      `- [${at[3]}] turn_cost: 8 turn(s) completed for $6.50 in 3 hourly report(s) logged from ${at[1]} to ${at[3]}; the dearest, logged at ${at[2]}, was $4.50 (value 6.5)`,
    );
    // One report since the last turn reads as the scheduler wrote it.
    expect(listed[2]).toEqual([
      `- [${at[4]}] turn_cost: 3 turn(s) completed for $2.00 since the last report (value 2)`,
    ]);
    // A report whose summary gives no turn count leaves the turns uncounted, never short.
    expect(listed[3]).toEqual([
      `- [${at[6]}] turn_cost: turns completed for $3.20 in 2 hourly report(s) logged from ${at[5]} to ${at[6]}; the dearest, logged at ${at[5]}, was $2.00 (value 3.2)`,
    ]);
  });

  it("calls the spend a lower bound only when the signals read cut some logged since the last turn", async () => {
    const { board } = await Board.init(dir, { name: "signals" });
    await board.addAgent(USER, { name: "steward-1", role: "steward", cli: "claude" });
    const { backend, listed } = signalReader();
    const { run } = await start(board, backend);
    // No last turn, and more than 500 signals: the first report falls out of the newest 500.
    await spendReport(board, 4, 3);
    await idleRepeats(board, 499);
    await spendReport(board, 2, 1);
    await run(stewardTurn);
    // More than 500 signals, but the one past the newest 500 is older than the last turn.
    await spendReport(board, 1, 0.5);
    await spendReport(board, 3, 2);
    expect((await board.listSignals(1000)).length).toBeGreaterThan(500);
    await run(stewardTurn);
    // 502 signals since the last turn: the newest 500 leave out two, a report among them.
    await spendReport(board, 4, 3);
    await idleRepeats(board, 499);
    await spendReport(board, 2, 1);
    await spendReport(board, 1, 0.5);
    await run(stewardTurn);
    // Exactly 500 signals since the last turn: the newest 500 leave out none.
    await spendReport(board, 2, 1);
    await idleRepeats(board, 497);
    await spendReport(board, 1, 0.5);
    await spendReport(board, 3, 2);
    await run(stewardTurn);
    const at = await spendTimes(board);
    const idle = expect.stringMatching(/ idle_member: eng-1 \(engineer\) .* for 499d /);
    expect(listed[0]).toEqual([
      idle,
      `- [${at[1]}] turn_cost: 2 turn(s) completed for $1.00 in 1 hourly report(s) logged at ${at[1]}; the read holds the newest 500 signals, so these are lower bounds (value 1)`,
    ]);
    expect(listed[1]).toEqual([
      `- [${at[3]}] turn_cost: 4 turn(s) completed for $2.50 in 2 hourly report(s) logged from ${at[2]} to ${at[3]}; the dearest, logged at ${at[3]}, was $2.00 (value 2.5)`,
    ]);
    expect(listed[2]).toEqual([
      idle,
      `- [${at[6]}] turn_cost: 3 turn(s) completed for $1.50 in 2 hourly report(s) logged from ${at[5]} to ${at[6]}; the dearest, logged at ${at[5]}, was $1.00; the read holds the newest 500 signals, so these are lower bounds (value 1.5)`,
    ]);
    expect(listed[3]).toEqual([
      expect.stringMatching(/ idle_member: eng-1 \(engineer\) .* for 497d /),
      `- [${at[9]}] turn_cost: 6 turn(s) completed for $3.50 in 3 hourly report(s) logged from ${at[7]} to ${at[9]}; the dearest, logged at ${at[9]}, was $2.00 (value 3.5)`,
    ]);
  });

  it("counts the turns of the spend reports the scheduler writes", async () => {
    const { board } = await Board.init(dir, { name: "signals" });
    await board.addAgent(USER, { name: "steward-1", role: "steward", cli: "claude" });
    await board.addAgent(USER, { name: "concierge-1", role: "concierge", cli: "claude" });
    const { backend, listed } = signalReader();
    const { run } = await start(board, backend);
    // The scheduler keeps a clock of its own and runs no turn: it only reports what turns cost.
    let clock = Date.parse("2026-10-01T00:00:00.000Z");
    const scheduler = new Scheduler({
      board,
      runner: {
        assign: () => Promise.resolve(null),
        runTurn: () => Promise.reject(new Error("no turns from this scheduler")),
        completeTask: () => Promise.resolve("deferred"),
      },
      now: () => new Date(clock),
    });
    const conciergeTurn = {
      agent: "concierge-1",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
      priority: 1,
    };
    await run(stewardTurn);
    await scheduler.tick();
    await run(conciergeTurn);
    await run(conciergeTurn);
    clock += 3_600_000;
    await scheduler.tick();
    await run(stewardTurn);
    const reports = (await board.listSignals(1000)).filter(
      (record) => record.signal.kind === "turn_cost",
    );
    const at = reports.map((record) => record.ts);
    const [one = 0, two = 0] = reports.map((record) => record.signal.value);
    expect(reports).toHaveLength(2);
    expect(two).toBeGreaterThan(one);
    // The concierge's turns are in the list too, with no signals in their prompts.
    expect(listed.at(-1)?.filter((line) => line.includes("] turn_cost: "))).toEqual([
      `- [${at[1]}] turn_cost: 3 turn(s) completed for $${(one + two).toFixed(2)} in 2 hourly report(s) logged from ${at[0]} to ${at[1]}; the dearest, logged at ${at[1]}, was $${two.toFixed(2)} (value ${one + two})`,
    ]);
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
    // A turn in a project's conversation outside it asks on the project's channel it was asked
    // from, else on the project's general.
    proposeRole = false;
    await board.addProject(USER, { slug: "lab", channels: ["general", "dev"] });
    await run({
      ...dispatch,
      place: "lab",
      trigger: { ...dispatch.trigger, channel: "lab/dev" },
    });
    await run({ ...dispatch, place: "lab" });
    const inLab = (await board.listThreads()).filter((thread) => thread.openedBy === "stew");
    expect(inLab.map((thread) => thread.channel)).toEqual([
      "general",
      "governance",
      "lab/dev",
      "lab/general",
    ]);
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
    // A turn that reports none, as one whose resume failed, leaves the session's total as it was.
    backend.failNext = true;
    const failed = await run(dispatch);
    expect(failed).toMatchObject({ resumeFailed: "retry", costUsd: 0, sessionCostUsd: 0.75 });
    await run(dispatch);
    expect(backend.startedFrom).toEqual([0, 0.25, 0.5, 0.75, 0.75]);
  });

  it("hands a resumed session the running usage its last turn reported, and none a record does not hold", async () => {
    const { board } = await Board.init(dir, { name: "usage" });
    await board.addAgent(USER, { name: "steward-1", role: "steward", cli: "claude" });
    const backend = new UsageTotalingBackend();
    const { run, host } = await start(board, backend);
    const dispatch = {
      agent: "steward-1",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: false, reason: "test" },
      priority: 1,
    };
    await run(dispatch);
    const second = await run(dispatch);
    expect(backend.startedFrom).toEqual([undefined, turnsOfUsage(1)]);
    expect(second).toMatchObject({ usage: TURN_USAGE, sessionUsage: turnsOfUsage(2) });

    // A turn that saw no result reports no running usage, and the session's stays as it was.
    backend.noResult = true;
    expect((await run(dispatch)).sessionUsage).toEqual(turnsOfUsage(2));
    await run(dispatch);
    expect(backend.startedFrom.at(-1)).toEqual(turnsOfUsage(2));

    // A runner from before reports none at all, and the record then holds none.
    const close = host.closeTurn.bind(host);
    const older = vi.spyOn(host, "closeTurn").mockImplementation((turnId, outcome) => {
      const { sessionUsage: _unknown, ...before } = outcome;
      return close(turnId, before);
    });
    const unreported = await run(dispatch);
    older.mockRestore();
    expect(unreported).not.toHaveProperty("sessionUsage");
    await run(dispatch);
    expect(backend.startedFrom.at(-1)).toBeUndefined();

    // Nor does a record of another session hand its running usage on.
    const last = await run(dispatch);
    expect(last.sessionUsage).toBeDefined();
    await board.finishTurn({ ...last, session: "session-0" });
    await run(dispatch);
    expect(backend.startedFrom.at(-1)).toBeUndefined();
  });

  it("keeps a session's running usage through a turn that never reached its CLI", async () => {
    const { board } = await Board.init(dir, { name: "usage-unstarted" });
    await board.addAgent(USER, { name: "steward-1", role: "steward", cli: "claude" });
    const ask = await board.openThread(USER, { channel: "general", title: "a question" });
    const backend = new UsageTotalingBackend();
    let dropping = false;
    society = await startTestSociety({
      board,
      backends: () => ({ claude: backend }),
      drop: (request) => dropping && new URL(request.url).pathname === "/runner/board/manifest",
    });
    const dispatch = {
      agent: "steward-1",
      project: "society",
      thread: { id: ask.id, task: false },
      trigger: { kind: "manual" as const, fromUser: false, reason: "test" },
      priority: 1,
    };
    await society.run(dispatch);
    await society.run(dispatch);

    // The board's copy never arrives, so the runner fails the turn before the CLI starts.
    dropping = true;
    const unpulled = await society.run(dispatch);
    dropping = false;
    expect(unpulled.error).toMatch(/^the runner could not run the turn/);
    expect(unpulled).toMatchObject({ session: "session-1", sessionUsage: turnsOfUsage(2) });

    // Nor from a workspace that could not be prepared: a file stands where its folder goes.
    const workspace = backend.cwds.at(-1) ?? "";
    await rm(workspace, { recursive: true });
    await writeFile(workspace, "", "utf8");
    const unprepared = await society.run(dispatch);
    expect(unprepared.error).toMatch(/^could not prepare the workspace/);
    expect(unprepared).toMatchObject({ session: "session-1", sessionUsage: turnsOfUsage(2) });
    await rm(workspace);

    await society.run(dispatch);
    expect(backend.startedFrom).toEqual([undefined, turnsOfUsage(1), turnsOfUsage(2)]);
  });

  it("hands a warm session that starts on a saved session the running usage its last turn reported", async () => {
    const { board } = await Board.init(dir, { name: "warm-usage" });
    await board.addAgent(USER, { name: "concierge-1", role: "concierge", cli: "claude" });
    const backend = new UsageTotalingBackend();
    const { run } = await start(board, backend, { residentIdleMs: 60_000 });
    const post = { ...deskPost, agent: "concierge-1" };
    await run(post);
    expect((await run(post)).sessionUsage).toEqual(turnsOfUsage(2));
    // A new model starts the warm session again, on the saved session.
    await board.setAgentModel(USER, "concierge-1", "sonnet");
    const resumed = await run(post);
    expect(backend.startedFrom).toEqual([undefined, turnsOfUsage(2)]);
    expect(resumed).toMatchObject({ usage: TURN_USAGE, sessionUsage: turnsOfUsage(3) });
  });

  it("keeps no session from a turn whose CLI never started, so the conversation's next turn starts one", async () => {
    const { board } = await Board.init(dir, { name: "unstarted" });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const first = await board.openThread(USER, { channel: "general", title: "a question" });
    const second = await board.openThread(USER, { channel: "general", title: "another" });
    const handed: Array<{ session: string; newSession: boolean }> = [];
    let home = "";
    let made = 0;
    let throwing = false;
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve(`session-${(made += 1)}`),
      runTurn: (request) => {
        if (throwing) {
          return Promise.reject(
            new Error("codex app-server did not answer thread/start within 60000 ms"),
          );
        }
        handed.push({ session: request.session, newSession: request.newSession });
        home = request.spec.configHome;
        return Promise.resolve(completed("cold turn"));
      },
    };
    let dropping = false;
    society = await startTestSociety({
      board,
      backends: () => ({ claude: backend }),
      drop: (request) => dropping && new URL(request.url).pathname === "/runner/board/manifest",
    });
    const inFirst = { ...deskPost, thread: { id: first.id, task: false } };
    const inSecond = { ...deskPost, thread: { id: second.id, task: false } };

    // The board's copy never arrives, as when a proxy closes the connection: the CLI never starts.
    dropping = true;
    const lost = await society.run(inFirst);
    dropping = false;
    expect(lost.error).toMatch(/^the runner could not run the turn: .*other side closed/);
    expect(handed).toEqual([]);
    expect(await board.readSessions("desk", "society", first.id)).toEqual({});
    expect(lost.session).toBeNull();
    // So the conversation's next turn starts a session, which is kept for the one after.
    await society.run(inFirst);
    await society.run(inFirst);
    expect(handed).toEqual([
      { session: "session-1", newSession: true },
      { session: "session-1", newSession: false },
    ]);

    // Nor from one whose workspace could not be prepared: a file stands where its folder goes.
    const blocked = path.join(home, "scratch", ".threads", second.id);
    await writeFile(blocked, "", "utf8");
    const unprepared = await society.run(inSecond);
    expect(unprepared.error).toMatch(/^could not prepare the workspace/);
    expect(await board.readSessions("desk", "society", second.id)).toEqual({});
    expect(unprepared.session).toBeNull();
    await rm(blocked);
    await society.run(inSecond);
    expect(handed.at(-1)).toEqual({ session: "session-2", newSession: true });

    // Nor from one its runner has no adapter for, which the hub places there only by hand.
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "codex" });
    const dispatch = TurnDispatchSchema.parse({
      agent: "stew",
      project: "society",
      trigger: { kind: "manual", fromUser: false, reason: "test" },
      priority: 1,
    });
    const unadapted = await society.hub.runTurn(dispatch, { runner: "pod" });
    expect(unadapted.error).toBe("no backend registered for codex");
    expect(await board.readSessions("stew", "society")).toEqual({});
    expect(unadapted.session).toBeNull();

    // Nor from one whose CLI could not open the new session, as when Codex's server never answered
    // `thread/start`: the adapter throws.
    const third = await board.openThread(USER, { channel: "general", title: "a third" });
    const inThird = { ...deskPost, thread: { id: third.id, task: false } };
    throwing = true;
    const unopened = await society.run(inThird);
    throwing = false;
    expect(unopened.error).toBe("codex app-server did not answer thread/start within 60000 ms");
    expect(await board.readSessions("desk", "society", third.id)).toEqual({});
    expect(unopened.session).toBeNull();
    await society.run(inThird);
    expect(handed.at(-1)).toEqual({ session: "session-4", newSession: true });
  });

  it("keeps no session from a turn stopped before its CLI started", async () => {
    const { board } = await Board.init(dir, { name: "stopped-early" });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const thread = await board.openThread(USER, { channel: "general", title: "a question" });
    const handed: Array<{ session: string; newSession: boolean }> = [];
    const chosen = Promise.withResolvers<void>();
    let asked = 0;
    let made = 0;
    const backend: AgentBackend = {
      kind: "claude",
      stops: true,
      // The runner asks for a new session's id after preparing the workspace and before it checks
      // for a stop, so the first one waits while the test stops the turn.
      newSession: async () => {
        asked += 1;
        if (asked === 1) {
          await chosen.promise;
        }
        return `session-${(made += 1)}`;
      },
      runTurn: (request) => {
        handed.push({ session: request.session, newSession: request.newSession });
        return Promise.resolve(completed("cold turn"));
      },
    };
    const { run, hub } = await start(board, backend);
    const inThread = { ...deskPost, thread: { id: thread.id, task: false } };
    const running = run(inThread);
    await vi.waitFor(() => expect(asked).toBe(1));
    const turnId = hub.liveTurns()[0]?.turnId ?? "";
    expect(await hub.stop(turnId, "user")).toBe(true);
    chosen.resolve();
    const stopped = await running;
    expect(stopped.exitReason).toBe("stopped");
    expect(handed).toEqual([]);
    expect(stopped.session).toBeNull();
    expect(await board.readSessions("desk", "society", thread.id)).toEqual({});
    // So the conversation's next turn starts a session of its own, with the whole thread.
    await run(inThread);
    expect(handed).toEqual([{ session: "session-2", newSession: true }]);
  });

  it("drops a session its CLI found nothing of, so the next turn starts anew and is told why, cold and warm", async () => {
    const { board } = await Board.init(dir, { name: "lost" });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const thread = await board.openThread(USER, { channel: "general", title: "a question" });
    await board.postMessage(USER, {
      channel: "general",
      thread_id: thread.id,
      body: "Where are we?",
    });
    // A session saved before, which the CLI no longer has, in a thread and at home.
    await board.writeSession("desk", "society", "claude", "s-gone", "pod", thread.id);
    await board.writeSession("desk", "society", "claude", "s-gone", "pod");
    const words =
      "Claude Code returned an error result: No conversation found with session ID: s-gone";
    const handed: Array<{ session: string; newSession: boolean }> = [];
    const prompts: string[] = [];
    const started: Array<{ session: string; newSession: boolean }> = [];
    let made = 0;
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve(`s-new-${(made += 1)}`),
      runTurn: (request) => {
        handed.push({ session: request.session, newSession: request.newSession });
        prompts.push(request.prompt);
        return Promise.resolve(
          request.session === "s-gone"
            ? {
                ...completed("unresumed"),
                status: null,
                exitReason: "error" as const,
                error: words,
                resumeFailed: "lost" as const,
              }
            : completed("cold turn"),
        );
      },
      startResident: (_spec, resident) => {
        started.push({ session: resident.session, newSession: resident.newSession });
        if (resident.session === "s-gone") {
          return Promise.reject(new ResumeError("lost", words));
        }
        return Promise.resolve({
          session: resident.session,
          runTurn: (prompt) => {
            prompts.push(prompt);
            return Promise.resolve(completed("warm turn"));
          },
          close: () => Promise.resolve(),
        });
      },
    };
    const { run } = await start(board, backend);
    const note = "Its CLI could not resume this conversation's session, so the session was dropped";

    const inThread = { ...deskPost, thread: { id: thread.id, task: false } };
    const lost = await run(inThread);
    expect(lost).toMatchObject({
      exitReason: "error",
      error: words,
      resumeFailed: "lost",
      sessionDropped: true,
    });
    // A lost session is no retry: nothing counts toward the three a retry gets.
    expect(lost.resumeRetries).toBeUndefined();
    expect(await board.readSessions("desk", "society", thread.id)).toEqual({ runner: "pod" });
    // The next turn starts a session, with the whole thread and the reason in its prompt.
    await run(inThread);
    expect(handed.at(-1)).toEqual({ session: "s-new-1", newSession: true });
    expect(prompts.at(-1)).toContain("## The thread so far");
    expect(prompts.at(-1)).toContain("Where are we?");
    expect(prompts.at(-1)).toContain(`It ended with error: ${words}.`);
    expect(prompts.at(-1)).toContain(note);
    // And the one after resumes it, told nothing more.
    await run(inThread);
    expect(handed.at(-1)).toEqual({ session: "s-new-1", newSession: false });
    expect(prompts.at(-1)).not.toContain(note);

    // At home, a warm session that cannot be resumed fails as it starts, and the next one is new
    // and gets the first-turn notes.
    const home = await run(deskPost);
    expect(home).toMatchObject({ exitReason: "error", resumeFailed: "lost", sessionDropped: true });
    expect(await board.readSessions("desk", "society")).toEqual({ runner: "pod" });
    await run(deskPost);
    expect(started).toEqual([
      { session: "s-gone", newSession: false },
      { session: "s-new-2", newSession: true },
    ]);
    expect(prompts.at(-1)).toContain("## First turn");
    expect(prompts.at(-1)).toContain(note);
    const failed = (await board.readEvents(null, 1_000)).filter(
      (event) => event.type === "turn.failed",
    );
    expect(failed.map((event) => event.payload)).toEqual([
      expect.objectContaining({ resumeFailed: "lost", sessionDropped: true, error: words }),
      expect.objectContaining({ resumeFailed: "lost", sessionDropped: true, error: words }),
    ]);
  });

  it("starts a society role's home afresh once a reflection there completes, warm or cold, and tells its next turn", async () => {
    const { board } = await Board.init(dir, { name: "afresh" });
    await board.addAgent(USER, { name: "steward-1", role: "steward", cli: "claude" });
    await board.addAgent(USER, { name: "concierge-1", role: "concierge", cli: "claude" });
    const topic = await board.openThread(USER, { channel: "general", title: "a question" });
    const handed: Array<[string, string, boolean]> = [];
    const prompts: string[] = [];
    const closes: string[] = [];
    let made = 0;
    let failNext = false;
    const ran = (): TurnResult => {
      if (failNext) {
        failNext = false;
        return { ...completed(""), status: null, exitReason: "timeout", error: "turn timed out" };
      }
      return { ...completed("ran"), contextTokens: 4_321 };
    };
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve(`s-${(made += 1)}`),
      runTurn: (request) => {
        handed.push([request.spec.agent, request.session, request.newSession]);
        prompts.push(request.prompt);
        return Promise.resolve(ran());
      },
      startResident: (spec, resident) => {
        handed.push([spec.agent, resident.session, resident.newSession]);
        return Promise.resolve({
          session: resident.session,
          runTurn: (prompt) => {
            prompts.push(prompt);
            return Promise.resolve(ran());
          },
          close: () => {
            closes.push(resident.session);
            return Promise.resolve();
          },
        });
      },
    };
    const { run } = await start(board, backend);
    const steward = { ...stewardTurn, agent: "steward-1" };
    const save = "This conversation's session ends with this turn";
    const note = "## Your session started afresh";

    // A cold home, with a thread beside it: the turn records how large its session had grown.
    const first = await run(steward);
    expect(first.contextTokens).toBe(4_321);
    await run({ ...steward, thread: { id: topic.id, task: false } });
    const reflected = await run(reflection("steward-1"));
    expect(reflected).toMatchObject({
      exitReason: "completed",
      session: "s-1",
      sessionDropped: true,
    });
    expect(prompts.at(-1)).toContain(save);
    expect(await board.readSessions("steward-1", "society")).toEqual({ runner: "pod" });
    expect(await board.readSessions("steward-1", "society", topic.id)).toEqual({
      claude: "s-2",
      runner: "pod",
    });
    const ended = (await board.readEvents(null, 1_000)).filter(
      (event) => event.type === "turn.completed" && event.payload["trigger"] === "reflection",
    );
    expect(ended.map((event) => event.payload)).toEqual([
      expect.objectContaining({ session: "s-1", sessionDropped: true, contextTokens: 4_321 }),
    ]);
    // The next home turn starts a session, told why rather than given the first-turn notes, and
    // the one after resumes it, told nothing.
    await run(steward);
    expect(handed.at(-1)).toEqual(["steward-1", "s-3", true]);
    expect(prompts.at(-1)).toContain(note);
    expect(prompts.at(-1)).not.toContain("## First turn");
    await run(steward);
    expect(handed.at(-1)).toEqual(["steward-1", "s-3", false]);
    expect(prompts.at(-1)).not.toContain(note);

    // A reflection that fails keeps the session.
    failNext = true;
    const failed = await run(reflection("steward-1"));
    expect(failed.exitReason).toBe("timeout");
    expect(failed.sessionDropped).toBeUndefined();
    await run(steward);
    expect(handed.at(-1)).toEqual(["steward-1", "s-3", false]);
    expect(prompts.at(-1)).not.toContain(note);

    // A warm home goes the same way, though its reflection changed no memory: the runner starts
    // the warm session afresh once the job names none.
    const concierge = { ...deskPost, agent: "concierge-1" };
    await run(concierge);
    expect(handed.at(-1)).toEqual(["concierge-1", "s-4", true]);
    expect((await run(reflection("concierge-1"))).sessionDropped).toBe(true);
    expect(closes).toEqual([]);
    await run(concierge);
    expect(closes).toEqual(["s-4"]);
    expect(handed.at(-1)).toEqual(["concierge-1", "s-5", true]);
    expect(prompts.at(-1)).toContain(note);
  });

  it("keeps the session after a reflection outside a society role's home", async () => {
    const { board } = await Board.init(dir, { name: "kept" });
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
    const handed: Array<[string, boolean]> = [];
    const prompts: string[] = [];
    let made = 0;
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve(`s-${(made += 1)}`),
      runTurn: (request) => {
        handed.push([request.session, request.newSession]);
        prompts.push(request.prompt);
        return Promise.resolve(completed("ran"));
      },
    };
    const { run } = await start(board, backend);
    // A work role's home in its project, and its home outside projects, where it was asked.
    for (const project of ["demo", "society"]) {
      await run(manual("eng-1", project));
      const reflected = await run(reflection("eng-1", project));
      expect(reflected.sessionDropped).toBeUndefined();
      expect(prompts.at(-1)).toContain("## Reflection");
      expect(prompts.at(-1)).not.toContain("This conversation's session ends with this turn");
      await run(manual("eng-1", project));
      expect(handed.at(-1)).toEqual([handed.at(-2)?.[0], false]);
    }
    expect(await board.readSessions("eng-1", "demo")).toEqual({ claude: "s-1", runner: "pod" });
    expect(await board.readSessions("eng-1", "society")).toEqual({ claude: "s-2", runner: "pod" });
  });

  it("records a turn the model service turned away as transient, and only a failed one", async () => {
    const { board } = await Board.init(dir, { name: "refused" });
    await board.addAgent(USER, { name: "concierge-1", role: "concierge", cli: "claude" });
    const post = { ...deskPost, agent: "concierge-1" };
    const words = "API Error: Repeated 529 Overloaded errors.";
    const plan: TurnResult[] = [
      { ...completed("refused"), status: null, exitReason: "error", error: words, transient: true },
      // A CLI that says so of a turn that completed is not believed.
      { ...completed("ran"), transient: true },
    ];
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("s-1"),
      runTurn: () => Promise.resolve(plan.shift() ?? completed("ran")),
    };
    const { run } = await start(board, backend);
    const refused = await run(post);
    expect(refused).toMatchObject({ exitReason: "error", error: words, transient: true });
    const ran = await run(post);
    expect(ran.exitReason).toBe("completed");
    expect(ran.transient).toBeUndefined();
    const ended = (await board.readEvents(null, 1_000)).filter((event) =>
      ["turn.failed", "turn.completed"].includes(event.type),
    );
    expect(ended.map((event) => [event.type, event.payload["transient"] ?? null])).toEqual([
      ["turn.failed", true],
      ["turn.completed", null],
    ]);
  });

  it("keeps a session its CLI may resume next time, and drops it after three such turns in a row", async () => {
    const { board } = await Board.init(dir, { name: "retry" });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const thread = await board.openThread(USER, { channel: "general", title: "a question" });
    await board.writeSession("desk", "society", "claude", "s-slow", "pod", thread.id);
    const words = "codex app-server did not answer thread/resume within 60000 ms";
    const handed: Array<{ session: string; newSession: boolean }> = [];
    const prompts: string[] = [];
    // How each turn of the old session goes: a resume that fails for now, or one that works.
    const plan = ["retry", "retry", "resumed", "retry", "retry", "retry"];
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("s-new"),
      runTurn: (request) => {
        handed.push({ session: request.session, newSession: request.newSession });
        prompts.push(request.prompt);
        if (request.session === "s-slow" && plan.shift() === "retry") {
          return Promise.reject(new ResumeError("retry", words));
        }
        return Promise.resolve(completed("cold turn"));
      },
    };
    const { run } = await start(board, backend);
    const inThread = { ...deskPost, thread: { id: thread.id, task: false } };
    const records = [];
    for (let turn = 0; turn < 7; turn += 1) {
      records.push(await run(inThread));
    }
    expect(
      records.map((record) => [
        record.exitReason,
        record.resumeFailed ?? null,
        record.resumeRetries ?? null,
        record.sessionDropped ?? false,
      ]),
    ).toEqual([
      ["error", "retry", 1, false],
      ["error", "retry", 2, false],
      // A turn that resumed ends the run of failures.
      ["completed", null, null, false],
      ["error", "retry", 1, false],
      ["error", "retry", 2, false],
      ["error", "retry", 3, true],
      ["completed", null, null, false],
    ]);
    expect(handed.map((each) => each.session)).toEqual([
      "s-slow",
      "s-slow",
      "s-slow",
      "s-slow",
      "s-slow",
      "s-slow",
      "s-new",
    ]);
    expect(handed.at(-1)?.newSession).toBe(true);
    // A turn after a failure that kept the session is told the failure, not that it was dropped.
    const note = "Its CLI could not resume this conversation's session, so the session was dropped";
    expect(prompts[1]).toContain(`It ended with error: ${words}.`);
    expect(prompts[1]).not.toContain(note);
    expect(prompts.at(-1)).toContain(note);
    expect(await board.readSessions("desk", "society", thread.id)).toEqual({
      claude: "s-new",
      runner: "pod",
    });
  });

  // What each adapter's session does once its CLI ended between turns: Claude's throws, with the
  // SDK's words after a crash and its own after a clean end, and Codex's returns the failure.
  const deadSessions = [
    {
      shape: "throws after a crash, as Claude's does",
      error: "Claude Code process terminated by signal SIGKILL",
      throws: true,
    },
    {
      shape: "throws after a clean end, as Claude's does",
      error: "the resident session has ended",
      throws: true,
    },
    {
      shape: "returns the failure, as Codex's does",
      error: "codex app-server is closed",
      throws: false,
    },
  ];
  for (const { shape, error, throws } of deadSessions) {
    it(`lets a warm session go once its CLI has ended, when the turn on it ${shape}`, async () => {
      const { board } = await Board.init(dir, { name: "dead" });
      await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
      const started: string[] = [];
      let closes = 0;
      let alive = true;
      const backend: AgentBackend = {
        kind: "claude",
        newSession: () => Promise.resolve("s1"),
        runTurn: () => Promise.resolve(completed("cold")),
        startResident: (_spec, resident) => {
          started.push(resident.session);
          alive = true;
          return Promise.resolve({
            session: resident.session,
            runTurn: () => {
              if (alive) {
                return Promise.resolve(completed("warm"));
              }
              if (throws) {
                return Promise.reject(new Error(error));
              }
              return Promise.resolve({
                ...completed("closed"),
                status: null,
                exitReason: "error" as const,
                error,
              });
            },
            close: () => {
              closes += 1;
              return Promise.resolve();
            },
          });
        },
      };
      const { run, hub } = await start(board, backend);
      const records = [await run(deskPost)];
      expect(hub.residentPairs).toEqual(["desk/society"]);
      alive = false;
      // The failed turn lets the session go at once, so the runner no longer reports it warm.
      records.push(await run(deskPost));
      expect(hub.residentPairs).toEqual([]);
      for (let i = 0; i < 2; i += 1) {
        records.push(await run(deskPost));
      }
      // The failed turn is recorded with the adapter's words, and the next one starts a new
      // process on the saved session.
      expect(hub.residentPairs).toEqual(["desk/society"]);
      expect(records.map((record) => [record.exitReason, record.error ?? null])).toEqual([
        ["completed", null],
        ["error", error],
        ["completed", null],
        ["completed", null],
      ]);
      expect(started).toEqual(["s1", "s1"]);
      expect(closes).toBe(1);
      expect(await board.readSessions("desk", "society")).toEqual({ claude: "s1", runner: "pod" });
    });
  }

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

  it("hands the CLI no environment of its own, warm or cold", async () => {
    const { board } = await Board.init(dir, { name: "env" });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const ask = await board.openThread(USER, { channel: "general", title: "a question" });
    const backend = new ResidentBackend();
    const { run } = await start(board, backend, { residentIdleMs: 60_000 });
    await run(deskPost);
    await run({ ...deskPost, thread: { id: ask.id, task: false } });
    expect(backend.starts).toHaveLength(1);
    expect(backend.coldTurns).toEqual(["cold"]);
    // A citizen's own commits carry the runner account's identity, so no git identity, nor any
    // other environment, rides along with a turn.
    expect(backend.handed).toHaveLength(2);
    for (const handed of backend.handed) {
      expect(handed).not.toHaveProperty("env");
      expect(JSON.stringify(handed)).not.toMatch(/GIT_(AUTHOR|COMMITTER)_/);
    }
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

  it("gives a citizen outside a project one workspace per project for its channels, until the project is archived", async () => {
    const { board } = await Board.init(dir, { name: "places" });
    await board.addProject(USER, { slug: "demo", channels: ["general", "release"] });
    await board.addProject(USER, { slug: "lab" });
    await board.addAgent(USER, { name: "concierge-1", role: "concierge", cli: "claude" });
    const inDemo = await board.postMessage(USER, { channel: "demo/release", body: "demo's date?" });
    await board.postMessage(USER, { channel: "lab/general", body: "lab's budget?" });
    await board.postMessage(USER, { channel: "general", body: "the society's plan?" });

    // Each turn waits until all three are in flight, so they can only finish by running together.
    const cwds = new Set<string>();
    const prompts = new Map<string, string>();
    let refusal: unknown = null;
    let started = 0;
    // The turn in flight in each conversation, as a post into it would find it.
    const found: Array<string | undefined> = [];
    const { promise: together, resolve: allStarted } = Promise.withResolvers<void>();
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve(randomUUID()),
      runTurn: async (request) => {
        const { cwd } = request.spec;
        cwds.add(cwd);
        prompts.set(cwd, request.prompt);
        started += 1;
        if (started === 3) {
          for (const place of [undefined, "demo", "lab"]) {
            found.push(host.turnIn("concierge-1", "society", { place })?.turnId);
          }
          allStarted();
        }
        await together;
        if (cwd.endsWith(path.join(".places", "lab"))) {
          // Archiving under the concierge's turn in lab's conversation is refused until that turn ends.
          refusal = await board.archiveProject(USER, { project: "lab", reason: "Done." }).then(
            () => null,
            (error: unknown) => error,
          );
        }
        return completed("done");
      },
    };
    const { run, runner, hub, host } = await start(board, backend);
    const turn = (place?: string) =>
      run({
        agent: "concierge-1",
        project: "society",
        ...(place === undefined ? {} : { place }),
        trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
        priority: 1,
      });
    const ended = await Promise.all([turn(), turn("demo"), turn("lab")]);
    expect(ended.map((each) => each.exitReason)).toEqual(["completed", "completed", "completed"]);
    expect(ended.map((each) => each.place)).toEqual([undefined, "demo", "lab"]);
    expect(found).toEqual(ended.map((each) => each.id));

    const scratch = path.join(runner.paths.agent("concierge-1"), "scratch");
    const demo = path.join(scratch, ".places", "demo");
    const lab = path.join(scratch, ".places", "lab");
    expect([...cwds].toSorted()).toEqual([scratch, demo, lab].toSorted());
    // Each project's turn read that project's posts alone, and the home the society's.
    expect(prompts.get(demo)).toContain("conversation of project demo's channels");
    expect(prompts.get(demo)).toContain("demo's date?");
    expect(prompts.get(demo)).not.toContain("lab's budget?");
    expect(prompts.get(lab)).toContain("lab's budget?");
    expect(prompts.get(lab)).not.toContain("demo's date?");
    expect(prompts.get(scratch)).toContain("the society's plan?");
    expect(prompts.get(scratch)).not.toContain("demo's date?");
    expect(prompts.get(scratch)).not.toContain("lab's budget?");
    expect(await board.digestCursor("concierge-1", "society", "~demo")).toBe(inDemo.id);
    // Each conversation has a session of its own.
    const sessions = await Promise.all(
      [undefined, "~demo", "~lab"].map(
        async (part) => (await board.readSessions("concierge-1", "society", part)).claude,
      ),
    );
    expect(new Set(sessions).size).toBe(3);
    expect(refusal).toMatchObject({ code: "INVALID_STATE" });
    // Archived once the turns have ended, lab's workspace goes with the sweep the scheduler asks
    // for on the archive, and demo's and the home's stay.
    await board.archiveProject(USER, { project: "lab", reason: "Done." });
    await hub.sweep({ kind: "place", project: "lab" });
    await expect(stat(lab)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(demo)).resolves.toBeDefined();
    await expect(stat(scratch)).resolves.toBeDefined();
    // A turn there that a sweep could not take its workspace from, as one dispatched just before
    // the archive, leaves none behind once the server answers its outcome.
    expect((await turn("lab")).exitReason).toBe("completed");
    await vi.waitFor(() => expect(stat(lab)).rejects.toMatchObject({ code: "ENOENT" }));
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
        // The test's account may have no git identity, as CI's has none, so the script names one.
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
      quotaReads: true,
      imageReads: false,
      projectMoves: false,
      capabilities: [],
      slots: null,
      turns: [],
    });
    expect((await models()).models[0]?.efforts.map((effort) => effort.id)).toEqual(["low", "high"]);
    expect(listed).toEqual({ a: 0, b: 2 });
  });

  it("keeps each CLI's quota on its runner's record, from a turn and from a read the user asks for", async () => {
    const { board, userToken } = await Board.init(dir, { name: "quotas" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    let turnPercent = 35;
    const reads: string[] = [];
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: () =>
        Promise.resolve({
          ...completed("done"),
          quota: CliQuotaSchema.parse({
            observedAt: quotaTime(0),
            source: "turn",
            status: "allowed",
            windows: [fiveHour(turnPercent, 0)],
          }),
        }),
      readQuota: () => {
        reads.push("claude");
        return Promise.resolve(
          CliQuotaSchema.parse({
            observedAt: quotaTime(5),
            source: "read",
            status: "allowed",
            plan: "max",
            windows: [
              fiveHour(40, 5),
              {
                key: "seven_day_opus",
                minutes: 10_080,
                usedPercent: 3,
                observedAt: quotaTime(5),
              },
            ],
          }),
        );
      },
    };
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({ claude: backend }),
    });
    const { app, run, hub } = society;
    const turn = {
      agent: "stew",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
      priority: 1,
    };
    const logged = async () =>
      (await board.readEvents(null, 500)).filter((event) => event.type === "runner.quota");

    // A turn's report lands on the record of the runner it ran on.
    await run(turn);
    expect((await board.readRunner("pod")).quotas?.claude).toMatchObject({
      source: "turn",
      windows: [{ key: "five_hour", usedPercent: 35 }],
    });
    expect((await logged()).map((event) => event.payload)).toEqual([
      { name: "pod", cli: "claude", status: "allowed" },
    ]);
    // Within the same whole percent, the record is written and nothing is logged; a new percent is.
    turnPercent = 35.4;
    await run(turn);
    expect(await logged()).toHaveLength(1);
    turnPercent = 36;
    await run(turn);
    expect(await logged()).toHaveLength(2);
    // A quota the board cannot keep is the runner record's trouble, never the turn's.
    const failing = vi
      .spyOn(board, "recordQuota")
      .mockRejectedValueOnce(new Error("the runner record could not be written"));
    turnPercent = 50;
    const kept = await run(turn);
    expect(failing).toHaveBeenCalledTimes(1);
    failing.mockRestore();
    expect(kept.exitReason).toBe("completed");
    expect(kept.error).toBeNull();
    expect((await board.readRunner("pod")).quotas?.claude?.windows[0]?.usedPercent).toBe(36);

    const refresh = (bearer: string, cli = "claude") =>
      app.request(`/api/runners/pod/quota/${cli}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
      });
    // A read starts a CLI process on the runner, so only the user asks for one.
    expect((await refresh(board.issueTurnToken("stew", "steward", 60_000))).status).toBe(403);
    const read = await refresh(userToken);
    expect(read.status).toBe(200);
    expect(CliQuotaSchema.parse(await read.json())).toMatchObject({ source: "read", plan: "max" });
    // The read merges over the turn's report: its windows win, and the turn's others would stay.
    const record = (await board.readRunner("pod")).quotas?.claude;
    expect(record?.windows.map((window) => [window.key, window.usedPercent])).toEqual([
      ["five_hour", 40],
      ["seven_day_opus", 3],
    ]);
    expect(record?.plan).toBe("max");
    const listed = await app.request("/api/runners", {
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(JSON.stringify(await listed.json())).toContain('"seven_day_opus"');
    // Asked again at once, the read is answered again rather than run again.
    expect((await refresh(userToken)).status).toBe(200);
    expect(reads).toEqual(["claude"]);
    // A CLI the runner does not have is away there.
    expect((await refresh(userToken, "codex")).status).toBe(503);
    // A runner from before quota reads is refused at once rather than left to time out.
    await hub.register("pod", {
      protocol: RUNNER_PROTOCOL,
      version: "0.3.21",
      os: "linux",
      clis: ["claude"],
      residentClis: [],
      steerableClis: [],
      stoppableClis: [],
      branchReads: true,
      branchChanges: true,
      quotaReads: false,
      imageReads: false,
      projectMoves: false,
      capabilities: [],
      slots: null,
      turns: [],
    });
    await expect(hub.quota("pod", "claude")).rejects.toThrow("upgrade it");
    expect(reads).toEqual(["claude"]);
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
      name: "eng-1",
      role: "researcher",
      cli: "claude",
      memberships: ["lab"],
    });
    const core = path.join(board.paths.agent("eng-1"), "memory", "core.md");
    await writeFile(core, "# Core memory\n\n- one\n- two\n- three\n- four\n- five\n", "utf8");
    await commitHome(board, "eng-1", "an earlier turn wrote the core");
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
    await board.setAgentRunner(USER, "eng-1", "a");
    await board.placeProject("lab", "b");
    const { run } = society;
    const [home, lab] = await Promise.all(
      (["society", "lab"] as const).map((project) =>
        run({
          agent: "eng-1",
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
    expect(await board.listHomeConflicts("eng-1")).toEqual([]);
    const authors = await execa("git", ["log", "--format=%an"], {
      cwd: board.paths.agent("eng-1"),
    });
    expect(
      authors.stdout.split("\n").filter((name) => name === "eng-1").length,
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
    const [conflict, ...more] = await board.listHomeConflicts("eng-1");
    expect(more).toEqual([]);
    expect(conflict?.path).toMatch(/^memory\/core\.md\.conflict-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(conflict?.file).toBe("memory/core.md");
    // The copy's age is the commit that brought it, made moments ago on a runner.
    expect(Date.now() - Date.parse(conflict?.since ?? "")).toBeLessThan(60_000);
    const other = await readFile(
      path.join(board.paths.agent("eng-1"), conflict?.path ?? ""),
      "utf8",
    );
    // One version is in place and the other beside it; neither is lost.
    expect([kept, other].join("\n")).toContain("- three, as the society's work saw it");
    expect([kept, other].join("\n")).toContain("- three, as the lab saw it");
    // The history shows both turns' edits and the merge that kept the copy, with that alone.
    const { changes } = await board.homeHistory("eng-1", 30);
    const turns = changes.filter((change) => change.turnId !== undefined);
    expect(turns.map((change) => change.kind)).toEqual(["turn", "turn"]);
    expect(
      turns.every((change) => change.files.some((file) => file.path === "memory/core.md")),
    ).toBe(true);
    expect(
      changes.filter((change) => change.kind === "merge").map((change) => change.files),
    ).toEqual([[{ path: conflict?.path, status: "added", added: 7, removed: 0 }]]);
    await run({
      agent: "eng-1",
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
      quotaReads: true,
      imageReads: false,
      projectMoves: false,
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
      quotaReads: true,
      imageReads: false,
      projectMoves: false,
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
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const ENG = { name: "eng-1", role: "engineer" };
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
          ["-c", "user.name=eng-1", "-c", "user.email=eng-1@x", "commit", "-m", "notes"],
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
        agent: "eng-1",
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
    await board.claimTask(ENG, { task_id: second.id });
    expect(await board.advanceTask(ENG, { task_id: second.id })).toMatchObject({
      completing: true,
    });
    expect(await hub.completeTask("demo", second.id)).toBe("done");
    expect(await log("trunk")).toContain(`merge: land task/${second.id} on trunk`);
    expect(await log("main")).not.toContain(`merge: land task/${second.id}`);
    expect((await board.getTask(USER, { task_id: second.id })).status).toBe("done");
    // The guard followed the default branch from main to trunk.
    expect(refused).toEqual(["main", "trunk"]);
  });

  it("takes a merge project's clone back from husky's hooks path before the next turn", async () => {
    const { board } = await Board.init(dir, { name: "husky" });
    await board.addProject(USER, { slug: "demo", onDone: "merge" });
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
    let turns = 0;
    const seen: { hooksPath: string; refused: string }[] = [];
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        const { cwd } = request.spec;
        turns += 1;
        if (turns === 1) {
          // What husky's install, run by a project's `prepare` on `pnpm install`, does to the clone.
          await execa("git", ["config", "core.hooksPath", ".husky/_"], { cwd });
          return completed("installed");
        }
        const hooksPath = (
          await execa("git", ["config", "--get", "core.hooksPath"], { cwd, reject: false })
        ).stdout;
        await writeFile(path.join(cwd, "notes.md"), "notes\n");
        await execa("git", ["add", "notes.md"], { cwd });
        await execa(
          "git",
          ["-c", "user.name=eng-1", "-c", "user.email=eng-1@x", "commit", "-m", "notes"],
          {
            cwd,
          },
        );
        const moved = await execa("git", ["update-ref", "refs/heads/main", "HEAD"], {
          cwd,
          reject: false,
        });
        seen.push({ hooksPath, refused: moved.exitCode === 0 ? "" : moved.stderr });
        return completed("wrote notes");
      },
    };
    const { run, runner } = await start(board, backend);
    const task = await board.createTask(USER, { project: "demo", title: "notes" });
    const turn = () =>
      run({
        agent: "eng-1",
        project: "demo",
        thread: { id: task.id, task: true },
        trigger: { kind: "manual", fromUser: true, reason: "test" },
        priority: 2,
      });
    expect((await turn()).exitReason).toBe("completed");
    const repo = runner.paths.repo("demo");
    const main = (await execa("git", ["rev-parse", "main"], { cwd: repo })).stdout;
    expect((await execa("git", ["config", "--get", "core.hooksPath"], { cwd: repo })).stdout).toBe(
      ".husky/_",
    );

    expect((await turn()).exitReason).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.hooksPath).toBe("");
    expect(seen[0]?.refused).toContain("only the runner moves it");
    expect((await execa("git", ["rev-parse", "main"], { cwd: repo })).stdout).toBe(main);
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
    const pulls = new Map<
      number,
      { branch: string; head: string; merged: string | null; closed?: string }
    >();
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
          state: pull.merged !== null ? "MERGED" : pull.closed === undefined ? "OPEN" : "CLOSED",
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
      close: (url, comment) => {
        const pull = pulls.get(pullNumber(url));
        if (pull === undefined || pull.merged !== null || pull.closed !== undefined) {
          return Promise.reject(new Error("Pull request is not open"));
        }
        pull.closed = comment;
        return Promise.resolve();
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
        name: "eng-1",
        role: "engineer",
        cli: "claude",
        memberships: ["demo"],
      });
      const ENG = { name: "eng-1", role: "engineer" };
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
              ["-c", "user.name=eng-1", "-c", "user.email=eng-1@x", "commit", "-m", "feat: add"],
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
              agent: "eng-1",
              project: "demo",
              thread: { id: taskId, task: true },
              trigger: { kind: "manual", fromUser: true, reason: "test" },
              priority: 2,
            })
          ).exitReason,
        ).toBe("completed");
        await board.updateTask(ENG, {
          task_id: taskId,
          pull_request: {
            url: `https://github.com/acme/demo/pull/${pull}`,
            merge_subject: "feat: add the readable feature",
            merge_body: "Adds it.\n\nCo-Authored-By: eng-1 <eng-1@x>",
          },
        });
        await board.claimTask(ENG, { task_id: taskId });
        await board.advanceTask(ENG, { task_id: taskId });
        return hub.completeTask("demo", taskId);
      };

      const first = await board.createTask(USER, { project: "demo", title: "readable" });
      expect(await finish(first.id, 1)).toBe("done");
      expect((await board.getTask(USER, { task_id: first.id })).status).toBe("done");
      expect(merges).toEqual([
        {
          subject: "feat: add the readable feature",
          body: "Adds it.\n\nCo-Authored-By: eng-1 <eng-1@x>",
        },
      ]);
      const landed = await rev("main");
      expect(
        (
          await execa("git", ["log", "-1", "--format=%B", landed], { cwd: origin })
        ).stdout.trimEnd(),
      ).toBe("feat: add the readable feature\n\nAdds it.\n\nCo-Authored-By: eng-1 <eng-1@x>");
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
        agent: "eng-1",
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
      await board.updateTask(ENG, {
        task_id: second.id,
        pull_request: { url: "https://github.com/acme/demo/pull/2" },
      });
      await board.claimTask(ENG, { task_id: second.id });
      await board.advanceTask(ENG, { task_id: second.id });
      expect(await hub.completeTask("demo", second.id)).toBe("done");
      expect(await board.getTask(USER, { task_id: second.id })).toMatchObject({
        status: "open",
        completing: false,
      });
      expect((await board.listThread(second.id)).at(-1)?.body).toContain(
        "does not hold the same files as task/",
      );
      expect(merges).toHaveLength(1);

      // Merged by hand before the task finished, the pull request counts as landed, and its
      // branch goes all the same.
      const third = await board.createTask(USER, { project: "demo", title: "merged by hand" });
      opened.push({ number: 3, branch: "feat/by-hand", content: "3\n" });
      await run({
        agent: "eng-1",
        project: "demo",
        thread: { id: third.id, task: true },
        trigger: { kind: "manual", fromUser: true, reason: "test" },
        priority: 2,
      });
      const byHand = "https://github.com/acme/demo/pull/3";
      await github.merge(byHand, pulls.get(3)?.head ?? "", { subject: "by hand", body: "" });
      await board.updateTask(ENG, { task_id: third.id, pull_request: { url: byHand } });
      await board.claimTask(ENG, { task_id: third.id });
      await board.advanceTask(ENG, { task_id: third.id });
      expect(await hub.completeTask("demo", third.id)).toBe("done");
      expect((await board.getTask(USER, { task_id: third.id })).status).toBe("done");
      expect((await board.listThread(third.id)).at(-1)?.body).toContain("was merged already");
      expect(merges).toHaveLength(2);
      expect(deleted).toEqual(["feat/readable-1", "feat/by-hand"]);
      // Checking a pull request's files leaves nothing behind in the runner's clone.
      expect((await execa("git", ["for-each-ref", "refs/stellaris"], { cwd: clone })).stdout).toBe(
        "",
      );

      // Abandoned, the task's pull request is closed with a word on why, its branch goes, and the
      // task keeps how it went, so it is closed once.
      const fourth = await board.createTask(USER, { project: "demo", title: "given up" });
      opened.push({ number: 4, branch: "feat/given-up", content: "4\n" });
      await run({
        agent: "eng-1",
        project: "demo",
        thread: { id: fourth.id, task: true },
        trigger: { kind: "manual", fromUser: true, reason: "test" },
        priority: 2,
      });
      await board.updateTask(ENG, {
        task_id: fourth.id,
        pull_request: { url: "https://github.com/acme/demo/pull/4" },
      });
      expect(await hub.closePullRequest("demo", fourth.id)).toBe("done");
      expect(pulls.get(4)?.closed).toBeUndefined();
      await board.updateTask(USER, { task_id: fourth.id, status: "abandoned" });
      expect(await hub.closePullRequest("demo", fourth.id)).toBe("done");
      expect(pulls.get(4)?.closed).toBe(
        'Closed by Stellaris: the task this pull request was opened for, "given up", was abandoned.',
      );
      expect(deleted).toEqual(["feat/readable-1", "feat/by-hand", "feat/given-up"]);
      expect((await board.getTask(USER, { task_id: fourth.id })).pullRequest?.closed).toMatchObject(
        { ok: true, detail: "closed pull request #4 (https://github.com/acme/demo/pull/4)" },
      );
      expect(await hub.closePullRequest("demo", fourth.id)).toBe("done");
      expect(deleted).toHaveLength(3);
      expect(
        (await board.readEvents(null, 10_000)).filter((event) =>
          event.type.startsWith("pull_request."),
        ),
      ).toMatchObject([
        {
          type: "pull_request.closed",
          payload: { taskId: fourth.id, url: "https://github.com/acme/demo/pull/4" },
        },
      ]);

      // One closed by hand already loses only its branch.
      const fifth = await board.createTask(USER, { project: "demo", title: "closed by hand" });
      opened.push({ number: 5, branch: "feat/by-hand-closed", content: "5\n" });
      await run({
        agent: "eng-1",
        project: "demo",
        thread: { id: fifth.id, task: true },
        trigger: { kind: "manual", fromUser: true, reason: "test" },
        priority: 2,
      });
      const closedByHand = "https://github.com/acme/demo/pull/5";
      await board.updateTask(ENG, { task_id: fifth.id, pull_request: { url: closedByHand } });
      await github.close(closedByHand, "by hand");
      await board.updateTask(USER, { task_id: fifth.id, status: "abandoned" });
      expect(await hub.closePullRequest("demo", fifth.id)).toBe("done");
      expect(pulls.get(5)?.closed).toBe("by hand");
      expect(deleted.at(-1)).toBe("feat/by-hand-closed");
      expect((await board.getTask(USER, { task_id: fifth.id })).pullRequest?.closed).toMatchObject({
        ok: true,
        detail: `pull request #5 (${closedByHand}) was closed already`,
      });
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
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const task = await board.createTask(USER, { project: "demo", title: "report" });
    const waiting = await board.createTask(USER, { project: "idle", title: "not started" });
    let repoDir = "";
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        repoDir = request.spec.repoDir;
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
      agent: "eng-1",
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
    expect(file.commit.author).toBe("eng-1");
    // The runner commits what the turn left as the citizen, author and committer alike.
    const tip = await execa(
      "git",
      ["log", "-1", "--format=%an <%ae> | %cn <%ce>", `task/${task.id}`],
      { cwd: repoDir },
    );
    expect(tip.stdout).toBe("eng-1 <eng-1@stellaris.local> | eng-1 <eng-1@stellaris.local>");
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
    expect(changes).toMatchObject({ total: 2, head: { author: "eng-1" } });
    expect(changes.files).toEqual([
      {
        path: "evidence/plot.png",
        status: "added",
        added: null,
        removed: null,
        lastChange: { author: "eng-1", at: changes.head.at },
      },
      {
        path: "report.md",
        status: "added",
        added: 1,
        removed: 0,
        lastChange: { author: "eng-1", at: changes.head.at },
      },
    ]);
    expect((await read(`${waiting.id}/changes`)).status).toBe(404);
    // Each opens to its patch over the same range.
    expect(
      BranchFileDiffSchema.parse(await (await read(`${task.id}/diff/report.md`)).json()),
    ).toEqual({
      head: changes.head,
      path: "report.md",
      status: "added",
      patch: "@@ -0,0 +1 @@\n+# Report",
      truncated: false,
    });
    expect(
      BranchFileDiffSchema.parse(await (await read(`${task.id}/diff/evidence/plot.png`)).json()),
    ).toMatchObject({ status: "added", patch: null });
    expect((await read(`${task.id}/diff/draft.md`)).status).toBe(404);
    expect((await read(`${task.id}/diff/evidence%2F..%2Freport.md`)).status).toBe(400);

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
      quotaReads: false,
      imageReads: false,
      projectMoves: false,
      capabilities: [],
      slots: null,
      turns: [],
    });
    expect((await board.readRunner("pod")).version).toBe("0.3.1");
    const old = await read(`${task.id}/files/report.md`);
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ message: expect.stringContaining("upgrade it") });
    expect((await read(`${task.id}/changes`)).status).toBe(409);
    expect((await read(`${task.id}/diff/report.md`)).status).toBe(409);

    await runner.stop();
    await vi.waitFor(() => expect(hub.connected).toEqual([]));
    const away = await read(`${task.id}/files/report.md`);
    expect(away.status).toBe(503);
    expect(await away.json()).toMatchObject({ error: "RUNNER_AWAY" });
  });

  it("reads a project's default branch on the project's runner, not its tasks' work", async () => {
    const { board, userToken } = await Board.init(dir, { name: "project-files" });
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
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const task = await board.createTask(USER, { project: "demo", title: "guide" });
    let repoDir = "";
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        repoDir = request.spec.repoDir;
        await mkdir(path.join(request.spec.cwd, "docs"), { recursive: true });
        await writeFile(path.join(request.spec.cwd, "docs", "guide.md"), "# Guide\n");
        await writeFile(path.join(request.spec.cwd, "README.md"), "# Demo\n");
        return completed("wrote the guide");
      },
    };
    const { app, run, runner, hub } = await start(board, backend);
    await run({
      agent: "eng-1",
      project: "demo",
      thread: { id: task.id, task: true },
      trigger: { kind: "manual", fromUser: true, reason: "test" },
      priority: 2,
    });
    const read = (route: string) =>
      app.request(`/api/projects/${route}`, { headers: { authorization: `Bearer ${userToken}` } });

    // The default branch holds the clone's first commit alone; the task's work is on its own branch.
    const listed = await read("demo/files");
    expect(listed.status).toBe(200);
    const empty = BranchFileSchema.parse(await listed.json());
    expect(empty).toMatchObject({ kind: "dir", path: "", entries: [] });
    const initial = await execa("git", ["rev-parse", "main"], { cwd: repoDir });
    expect(empty.commit.id).toBe(initial.stdout);
    expect((await read("demo/files/README.md")).status).toBe(404);

    // Whatever branch the project names as its default is the one read.
    await execa("git", ["branch", "site", `task/${task.id}`], { cwd: repoDir });
    await board.configureProject(USER, { project: "demo", default_branch: "site" });
    const root = BranchFileSchema.parse(await (await read("demo/files")).json());
    expect(root.kind === "dir" ? root.entries : null).toEqual([
      { name: "README.md", kind: "file", size: 7 },
      { name: "docs", kind: "dir", size: null },
    ]);
    expect(root.commit.author).toBe("eng-1");
    const guide = BranchFileSchema.parse(await (await read("demo/files/docs/guide.md")).json());
    expect(guide).toMatchObject({ kind: "file", path: "docs/guide.md", size: 8 });
    expect(
      Buffer.from(guide.kind === "file" ? (guide.content ?? "") : "", "base64").toString(),
    ).toBe("# Guide\n");
    expect(BranchFileSchema.parse(await (await read("demo/files/docs")).json())).toMatchObject({
      kind: "dir",
      entries: [{ name: "guide.md", kind: "file", size: 8 }],
    });

    expect((await read("demo/files/draft.md")).status).toBe(404);
    expect((await read("demo/files/docs%2F..%2FREADME.md")).status).toBe(400);
    expect((await read("nothing/files")).status).toBe(404);
    expect((await read("..%2Fdemo/files")).status).toBe(400);
    // A project no turn has run in has no repository on any runner yet.
    expect((await read("idle/files")).status).toBe(404);

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
      quotaReads: false,
      imageReads: false,
      projectMoves: false,
      capabilities: [],
      slots: null,
      turns: [],
    });
    const old = await read("demo/files");
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ message: expect.stringContaining("upgrade it") });

    await runner.stop();
    await vi.waitFor(() => expect(hub.connected).toEqual([]));
    const away = await read("demo/files/README.md");
    expect(away.status).toBe(503);
    expect(await away.json()).toMatchObject({ error: "RUNNER_AWAY" });
  });

  it("keeps an image a turn names on its runner and shows it by id, refusing what is out of reach or no image", async () => {
    const { board, userToken } = await Board.init(dir, { name: "images" });
    await board.addProject(USER, { slug: "demo" });
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    for (const name of ["eng-1", "eng-2", "rev-1"]) {
      await board.addAgent(USER, { name, role: "engineer", cli: "claude", memberships: ["demo"] });
    }
    const topic = await board.openThread(USER, {
      channel: "demo/general",
      title: "How the board looks",
    });
    const answers = new Map<string, { status: number; body: Record<string, unknown> }>();
    const prompts = new Map<string, string>();
    let hello: RunnerHello | null = null;
    // eng-1's home turn and eng-2's turn in the thread run all the while eng-1's turn there
    // uploads, each in a worktree of its own.
    const home = Promise.withResolvers<void>();
    const beside = Promise.withResolvers<void>();
    const uploaded = Promise.withResolvers<void>();
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        const inThread = board.resolveToken(request.mcp.token)?.thread !== undefined;
        if (request.spec.agent === "eng-1" && !inThread) {
          home.resolve();
          await uploaded.promise;
          return completed("worked at home");
        }
        if (request.spec.agent === "eng-2") {
          beside.resolve();
          await uploaded.promise;
          return completed("worked in the thread");
        }
        prompts.set(request.spec.agent, request.prompt);
        if (request.spec.agent !== "eng-1" || society === null) {
          return completed("read the thread");
        }
        const { app } = society;
        const verb = async (name: string, input: object) => {
          const response = await app.request(`/api/verbs/${name}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${request.mcp.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(input),
          });
          return { status: response.status, body: AnswerSchema.parse(await response.json()) };
        };
        const upload = async (label: string, file: string) => {
          answers.set(label, await verb("upload_image", { path: file }));
        };
        const { cwd, configHome } = request.spec;
        await mkdir(path.join(cwd, "shots"), { recursive: true });
        await writeFile(path.join(cwd, "shots", "board.png"), PIXEL);
        const temp = await mkdtemp(path.join(os.tmpdir(), "stellaris-shot-"));
        await writeFile(path.join(temp, "runners.png"), PIXEL);
        await mkdir(path.join(configHome, "scratch"), { recursive: true });
        await writeFile(path.join(configHome, "scratch", "citizens.png"), PIXEL);
        await upload("worktree", "shots/board.png");
        await upload("temp", path.join(temp, "runners.png"));
        await upload("home", path.join(configHome, "scratch", "citizens.png"));
        await symlink("/etc/passwd", path.join(cwd, "shots", "passwd.png"));
        await upload("link", "shots/passwd.png");
        await upload("outside", "/etc/passwd");
        await writeFile(path.join(cwd, "shots", "notes.png"), "notes, not a picture\n");
        await upload("text", "shots/notes.png");
        await upload("missing", "shots/gone.png");
        await upload("nul", "shots/board.png\0.png");
        // A runner from before image reads is refused at once rather than left to time out.
        hello = {
          protocol: RUNNER_PROTOCOL,
          version: "0.3.22",
          os: "linux",
          clis: ["claude"],
          residentClis: [],
          steerableClis: [],
          stoppableClis: [],
          branchReads: true,
          branchChanges: true,
          quotaReads: true,
          imageReads: false,
          projectMoves: false,
          capabilities: [],
          slots: null,
          turns: society.runner.turns,
        };
        await society.hub.register("pod", hello);
        await upload("old", "shots/board.png");
        await society.hub.register("pod", { ...hello, imageReads: true });
        const shown = answers.get("worktree")?.body["markdown"];
        await verb("post_message", { thread_id: topic.id, body: `Before: ${String(shown)}` });
        await rm(temp, { recursive: true, force: true });
        uploaded.resolve();
        return completed("uploaded the board's screenshots");
      },
    };
    society = await startTestSociety({ board, backends: () => ({ claude: backend }) });
    const { run, app } = society;
    const turn = (agent: string, thread: string | null = topic.id) =>
      run({
        agent,
        project: "demo",
        ...(thread === null ? {} : { thread: { id: thread, task: false } }),
        trigger: { kind: "mention", fromUser: true, reason: "mentioned by user" },
        priority: 2,
      });
    // The temp folder is a place of its own, apart from the runner's data folder, as on a machine.
    const tmpdir = process.env["TMPDIR"];
    process.env["TMPDIR"] = await mkdtemp(path.join(dir, "tmp-"));
    try {
      const others = [turn("eng-1", null), turn("eng-2")];
      await home.promise;
      await beside.promise;
      expect((await turn("eng-1")).exitReason).toBe("completed");
      for (const other of await Promise.all(others)) {
        expect(other.exitReason).toBe("completed");
      }
    } finally {
      if (tmpdir === undefined) {
        delete process.env["TMPDIR"];
      } else {
        process.env["TMPDIR"] = tmpdir;
      }
    }
    expect(hello).not.toBeNull();

    const ids = ["worktree", "temp", "home"].map((label) => {
      const answer = answers.get(label);
      expect({ label, status: answer?.status }).toEqual({ label, status: 200 });
      return String(answer?.body["id"]);
    });
    expect(answers.get("worktree")?.body).toEqual({
      id: ids[0],
      type: "png",
      size: PIXEL.length,
      markdown: `![board.png](image:${ids[0]})`,
    });
    expect(answers.get("link")).toMatchObject({
      status: 403,
      body: {
        error: "FORBIDDEN",
        message: expect.stringContaining("which leads to /etc/passwd, is outside your worktree"),
      },
    });
    expect(answers.get("outside")).toMatchObject({ status: 403 });
    expect(answers.get("text")).toMatchObject({
      status: 400,
      body: { message: expect.stringContaining("is not a PNG, JPEG, GIF, or WebP image") },
    });
    expect(answers.get("missing")).toMatchObject({
      status: 404,
      body: { message: "shots/gone.png does not exist on this runner" },
    });
    // A path no runner could be asked for is refused before any runner is.
    expect(answers.get("nul")).toMatchObject({
      status: 400,
      body: {
        error: "VALIDATION",
        message: expect.stringContaining("a path with no NUL character"),
      },
    });
    expect(answers.get("old")).toMatchObject({
      status: 409,
      body: { message: "runner pod, where the turn runs, cannot read images yet; upgrade it" },
    });

    // The board serves the bytes to whoever holds a token, as an image and nothing else.
    const image = (id: string, token: string | null = userToken) =>
      app.request(`/api/images/${id}`, {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      });
    for (const id of ids) {
      const response = await image(id);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PIXEL);
    }
    expect((await image(ids[0] ?? "", null)).status).toBe(401);
    expect((await image(ids[0] ?? "", "stl_not-a-token")).status).toBe(401);
    const unknown = await image("01M4WY483E0XG4Q2ZTHAX3JBZW");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: "NOT_FOUND",
      message: "image 01M4WY483E0XG4Q2ZTHAX3JBZW not found",
    });
    expect((await image("not-an-id")).status).toBe(400);
    // Nobody but a turn has a machine to upload from.
    const byUser = await app.request("/api/verbs/upload_image", {
      method: "POST",
      headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "/tmp/x.png" }),
    });
    expect(byUser.status).toBe(409);

    // A reader of the thread is shown the markdown, never the bytes.
    await turn("rev-1");
    expect(prompts.get("rev-1")).toContain(`Before: ![board.png](image:${ids[0]})`);
    expect(prompts.get("rev-1")).not.toContain(PIXEL.toString("base64").slice(0, 16));
  });

  it("reads an upload from the very turn that asked, among one citizen's turns in two projects, a channel, and outside projects", async () => {
    const { board } = await Board.init(dir, { name: "image-turns" });
    await board.addProject(USER, { slug: "demo", channels: ["general", "release"] });
    await board.addProject(USER, { slug: "lab" });
    await board.addProject(USER, { slug: "ops" });
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
    // Each turn writes a file only its own worktree has, and uploads it by a relative path once all
    // five are in flight, so a turn matched by fewer than all its parts reads another's worktree.
    const statuses = new Map<string, number>();
    const written = Promise.withResolvers<void>();
    const uploaded = Promise.withResolvers<void>();
    let writers = 0;
    let uploaders = 0;
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: async (request) => {
        const actor = board.resolveToken(request.mcp.token);
        const key = `${actor?.scope ?? ""}${actor?.channel === undefined ? "" : `#${actor.channel}`}${
          actor?.place === undefined ? "" : `~${actor.place}`
        }`;
        await mkdir(path.join(request.spec.cwd, "shots"), { recursive: true });
        await writeFile(path.join(request.spec.cwd, "shots", `${key}.png`), PIXEL);
        writers += 1;
        if (writers === 5) {
          written.resolve();
        }
        await written.promise;
        const response = await society?.app.request("/api/verbs/upload_image", {
          method: "POST",
          headers: {
            authorization: `Bearer ${request.mcp.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ path: `shots/${key}.png` }),
        });
        statuses.set(key, response?.status ?? 0);
        uploaders += 1;
        if (uploaders === 5) {
          uploaded.resolve();
        }
        await uploaded.promise;
        return completed("uploaded");
      },
    };
    const { run } = await start(board, backend);
    const turn = (project: string, channel?: string, place?: string) =>
      run({
        agent: "eng-1",
        project,
        ...(channel === undefined ? {} : { channel }),
        ...(place === undefined ? {} : { place }),
        trigger: { kind: "mention", fromUser: true, reason: "mentioned by user" },
        priority: 2,
      });
    const turns = await Promise.all([
      turn("demo"),
      turn("demo", "release"),
      turn("lab"),
      turn("society"),
      turn("society", undefined, "ops"),
    ]);
    expect(turns.map((each) => each.exitReason)).toEqual(Array(5).fill("completed"));
    expect(Object.fromEntries(statuses)).toEqual({
      demo: 200,
      "demo#release": 200,
      lab: 200,
      society: 200,
      "society~ops": 200,
    });
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

  it("keeps what a runner's account lacks of a git identity from each hello, warning of it once", async () => {
    const { board } = await Board.init(dir, { name: "identity" });
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: () => Promise.resolve(completed("done")),
    };
    const { url, hub } = await start(board, backend);
    const { token } = await board.addRunner(USER, "laptop");
    let missing: GitIdentityPart[] | Error = ["email"];
    let checks = 0;
    const said: Array<{ level: string; message: string; context: object }> = [];
    const note =
      (level: string) =>
      (context: object, message: string): void => {
        said.push({ level, message, context });
      };
    const log = { info: note("info"), warn: note("warn"), error: note("error") };
    const laptop = createRunner({
      serverUrl: url,
      token,
      dataDir: path.join(dir, "laptop"),
      backends: { claude: backend },
      version: "test",
      slots: 1,
      retryMs: 20,
      // The stream goes quiet at once, so the runner connects again, and says hello, every 100 ms.
      streamIdleMs: 100,
      log,
      gitIdentity: new GitIdentityCheck(log, () => {
        checks += 1;
        return missing instanceof Error ? Promise.reject(missing) : Promise.resolve(missing);
      }),
    });
    const about = (pattern: RegExp) => said.filter((entry) => pattern.test(entry.message));
    const identity = /git identity|no git user/;

    await laptop.start();
    expect((await board.readRunner("laptop")).gitIdentityMissing).toEqual(["email"]);
    // Each hello checks again, and the log speaks of a gap once, not on every reconnect.
    await vi.waitFor(() => expect(checks).toBeGreaterThanOrEqual(3));
    expect(about(identity)).toEqual([
      {
        level: "warn",
        context: { missing: ["email"] },
        message: expect.stringContaining(`git config --global user.email "you@example.com"`),
      },
    ]);

    // Set on the machine, the gap clears at the next hello.
    missing = [];
    await vi.waitFor(async () =>
      expect((await board.readRunner("laptop")).gitIdentityMissing).toEqual([]),
    );
    expect(about(identity).map((entry) => entry.level)).toEqual(["warn", "info"]);

    // A check that fails sends nothing, which the board takes as not knowing.
    missing = new Error("git: not found");
    await vi.waitFor(async () =>
      expect((await board.readRunner("laptop")).gitIdentityMissing).toBeUndefined(),
    );
    expect(about(/could not check the git identity/)[0]?.context).toEqual({
      error: "Error: git: not found",
    });
    await laptop.stop();

    // An older runner's hello says nothing either, so what an earlier one reported goes.
    const hello: RunnerHello = {
      protocol: RUNNER_PROTOCOL,
      version: "0.3.21",
      os: "linux",
      clis: ["claude"],
      residentClis: [],
      steerableClis: [],
      stoppableClis: [],
      branchReads: true,
      branchChanges: true,
      quotaReads: false,
      imageReads: false,
      projectMoves: false,
      capabilities: [],
      slots: null,
      turns: [],
    };
    await hub.register("laptop", { ...hello, gitIdentityMissing: ["name", "email"] });
    expect((await board.readRunner("laptop")).gitIdentityMissing).toEqual(["name", "email"]);
    // Connecting and going away keep it.
    const detach = await hub.attach("laptop", () => true);
    await detach();
    expect(await board.readRunner("laptop")).toMatchObject({
      status: "disconnected",
      gitIdentityMissing: ["name", "email"],
    });
    await hub.register("laptop", hello);
    const record = await board.readRunner("laptop");
    expect(record.version).toBe("0.3.21");
    expect(record).not.toHaveProperty("gitIdentityMissing");
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
