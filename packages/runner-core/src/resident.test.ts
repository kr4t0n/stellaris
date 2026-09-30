import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { execa } from "execa";
import { MEMBER_VERBS, type AgentEvent } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalRunner } from "./local-runner.js";
import { ZERO_USAGE, type AgentBackend, type ResidentSession, type TurnResult } from "./types.js";

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

describe("LocalRunner resident sessions and the society scope", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-resident-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
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
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const runner = new LocalRunner({
        board,
        runnerName: "server",
        backends: { claude: backend },
        mcpUrl: "http://127.0.0.1:0/mcp",
        turnTimeoutMs: null,
      });
      await runner.runTurn({
        agent: "eng-1",
        project: "demo",
        trigger: { kind: "manual", fromUser: false, reason: "test" },
        priority: 1,
        onboarding: false,
      });
    } finally {
      vi.useRealTimers();
    }
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
    const runner = new LocalRunner({
      board,
      runnerName: "server",
      backends: { claude: backend },
      mcpUrl: "http://127.0.0.1:0/mcp",
    });
    const turn = (project: string, thread?: string) =>
      runner.runTurn({
        agent: "eng-1",
        project,
        ...(thread === undefined ? {} : { thread: { id: thread, task: true } }),
        trigger: { kind: "mention", fromUser: true, reason: "mentioned by user" },
        priority: 2,
        onboarding: false,
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
    expect(task?.cwd).toBe(path.resolve(board.paths.taskWorktree("eng-1", demoTask.id)));
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
    });
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
    const runner = new LocalRunner({
      board,
      runnerName: "server",
      backends: { claude: backend },
      mcpUrl: "http://127.0.0.1:0/mcp",
    });
    const dispatch = {
      agent: "stew",
      project: "society",
      trigger: { kind: "ops_event" as const, from: "board", fromUser: false, reason: "a role gap" },
      priority: 0,
      onboarding: false,
    };
    await board.publishSignal({
      kind: "role_gap",
      key: "role_gap:lab:referee",
      summary: "a stage waits on the referee role, which nobody fills",
      value: 1,
    });
    await runner.runTurn(dispatch);
    await runner.runTurn(dispatch);
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
    const runner = new LocalRunner({
      board,
      runnerName: "server",
      backends: { claude: backend },
      mcpUrl: "http://127.0.0.1:0/mcp",
    });
    const dispatch = {
      agent: "stew",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
      priority: 1,
      onboarding: false,
    };
    await runner.runTurn(dispatch);
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
    await runner.runTurn(dispatch);
    expect(await board.listThreads()).toHaveLength(1);
    expect(await board.listRequests()).toHaveLength(2);
  });

  it("hands a resumed session the running total its last turn reported", async () => {
    const { board } = await Board.init(dir, { name: "totals" });
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const backend = new TotalingBackend();
    const runner = new LocalRunner({
      board,
      runnerName: "server",
      backends: { claude: backend },
      mcpUrl: "http://127.0.0.1:0/mcp",
    });
    const dispatch = {
      agent: "stew",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: false, reason: "test" },
      priority: 1,
      onboarding: false,
    };
    await runner.runTurn(dispatch);
    const second = await runner.runTurn(dispatch);
    expect(backend.startedFrom).toEqual([0, 0.25]);
    expect(second).toMatchObject({ costUsd: 0.25, sessionCostUsd: 0.5 });
    // A record from before the running total was kept held it as the turn's cost.
    const { sessionCostUsd: _total, ...legacy } = second;
    await board.finishTurn({ ...legacy, costUsd: 0.5 });
    await runner.runTurn(dispatch);
    expect(backend.startedFrom).toEqual([0, 0.25, 0.5]);
  });

  it("starts a warm session afresh when the citizen's model changes", async () => {
    const { board } = await Board.init(dir, { name: "resident" });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const backend = new ResidentBackend();
    const runner = new LocalRunner({
      board,
      runnerName: "server",
      backends: { claude: backend },
      mcpUrl: "http://127.0.0.1:0/mcp",
      residentIdleMs: 60_000,
    });
    const dispatch = {
      agent: "desk",
      project: "society",
      trigger: { kind: "user_post" as const, fromUser: true, reason: "posted" },
      priority: 2,
      onboarding: false,
    };
    await runner.runTurn(dispatch);
    await runner.runTurn(dispatch);
    expect(backend.models).toEqual([undefined]);

    await board.setAgentModel(USER, "desk", "sonnet");
    await runner.runTurn(dispatch);
    expect(backend.closes).toEqual(["desk:session-1"]);
    expect(backend.models).toEqual([undefined, "sonnet"]);
    await runner.runTurn(dispatch);
    expect(backend.models).toHaveLength(2);
    await runner.close();
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
    const runner = new LocalRunner({
      board,
      runnerName: "server",
      backends: { claude: backend },
      mcpUrl: "http://127.0.0.1:0/mcp",
      residentIdleMs: 80,
    });
    const dispatch = {
      agent: "desk",
      project: "society",
      trigger: { kind: "user_post" as const, fromUser: true, reason: "posted" },
      priority: 2,
      onboarding: false,
    };

    // Two turns, one session: the society scope needs no repository, and the roster rides in the prompt.
    const first = await runner.runTurn(dispatch);
    expect(first.exitReason).toBe("completed");
    expect(first.project).toBe("society");
    expect(backend.starts).toEqual(["desk:session-1"]);
    expect(backend.prompts[0]).toContain("## The society");
    expect(backend.prompts[0]).toContain("- eng-1: engineer on claude");
    expect(runner.residentPairs).toEqual(["desk/society"]);
    await runner.runTurn(dispatch);
    expect(backend.starts).toHaveLength(1);
    expect(backend.prompts).toHaveLength(2);
    expect(backend.coldTurns).toEqual([]);
    expect((await board.readLastTurn("desk", "society"))?.status?.summary).toBe("warm turn 2");

    // A turn that updated memory makes the next one start fresh, since the instructions carry it.
    backend.memoryUpdatedNext = true;
    await runner.runTurn(dispatch);
    expect(backend.closes).toEqual(["desk:session-1"]);
    expect(runner.residentPairs).toEqual([]);
    await runner.runTurn(dispatch);
    expect(backend.starts).toHaveLength(2);

    // Idle sessions go cold on their own; shutdown closes whatever is left.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runner.residentPairs).toEqual([]);
    expect(backend.closes).toHaveLength(2);
    await runner.runTurn(dispatch);
    expect(runner.residentPairs).toEqual(["desk/society"]);
    await runner.close();
    expect(runner.residentPairs).toEqual([]);
    expect(backend.closes).toHaveLength(3);

    // Non-resident roles still take cold turns, and an engineer cannot use the society scope.
    await runner.runTurn({
      agent: "eng-1",
      project: "demo",
      trigger: { kind: "manual" as const, fromUser: true, reason: "dev" },
      priority: 2,
      onboarding: false,
    });
    expect(backend.coldTurns).toEqual(["cold"]);
    const refused = await runner.runTurn({ ...dispatch, agent: "eng-1" });
    expect(refused.exitReason).toBe("error");
    expect(refused.error).toContain("society-scope");
  });
});
