import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
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

  startResident(spec: { agent: string }, start: { session: string }): Promise<ResidentSession> {
    this.starts.push(`${spec.agent}:${start.session}`);
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
