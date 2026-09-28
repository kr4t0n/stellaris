import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import {
  LocalRunner,
  ZERO_USAGE,
  type AgentBackend,
  type AgentSpec,
  type ResidentSession,
  type ResidentStart,
  type TurnRequest,
  type TurnResult,
} from "@stellaris/runner-core";
import { Scheduler } from "@stellaris/scheduler";
import { execa } from "execa";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "./app.js";

const OWNER = { name: "owner", role: "owner" } as const;
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;

function done(summary: string): TurnResult {
  return {
    events: [{ type: "tool_call", name: "mcp__board__post_message", input: {} }],
    finalText: summary,
    usage: ZERO_USAGE,
    costUsd: 0.01,
    status: {
      summary,
      claimsHeld: [],
      blockedOn: [],
      needsOwnerDecision: false,
      memoryUpdated: false,
    },
    exitReason: "completed",
  };
}

/**
 * A scripted stand-in for a CLI agent. It reads the prompt like an agent would, acts through the
 * HTTP verbs with the turn token it was handed, and edits code in its worktree with git.
 * The real adapters replace it; everything around it is the production path.
 */
class ScriptedBackend implements AgentBackend {
  readonly kind = "claude" as const;
  readonly prompts: string[] = [];
  readonly residentStarts: string[] = [];
  readonly residentCloses: string[] = [];

  constructor(
    private readonly app: Hono<{ Variables: { actor: { name: string; role: string } } }>,
  ) {}

  newSession(): Promise<string> {
    return Promise.resolve(`session-${this.prompts.length + 1}`);
  }

  /** The same script over a warm session, so resident roles exercise the runner's resident path. */
  startResident(spec: AgentSpec, start: ResidentStart): Promise<ResidentSession> {
    const key = `${spec.agent}/${spec.project}`;
    this.residentStarts.push(key);
    const session: ResidentSession = {
      session: start.session,
      runTurn: (prompt) =>
        this.runTurn({
          spec,
          session: start.session,
          newSession: start.newSession,
          prompt,
          instructions: start.instructions,
          mcp: start.mcp,
          limits: start.limits,
          statusSchema: start.statusSchema,
          env: start.env,
        }),
      close: () => {
        this.residentCloses.push(key);
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    this.prompts.push(request.prompt);
    const verb = async (name: string, input: unknown): Promise<unknown> => {
      const response = await this.app.request(`/api/verbs/${name}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${request.mcp.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(`${name} failed: ${JSON.stringify(body)}`);
      }
      return body;
    };

    // The front desk routes the owner's posts: a task for an existing project, or a new project.
    if (request.spec.agent === "desk") {
      if (!request.prompt.includes("Trigger: owner_post")) {
        return done("nothing to do");
      }
      if (request.prompt.includes("health endpoint")) {
        const task = z.object({ id: z.string() }).parse(
          await verb("create_task", {
            project: "demo",
            title: "Add a health endpoint",
            body: "Requested by the owner at the front desk.",
          }),
        );
        await verb("post_message", {
          channel: "demo/general",
          body: `@eng-1 please take task ${task.id}: add a health endpoint.`,
        });
        return done("routed the request to eng-1 as a task on demo");
      }
      if (request.prompt.includes("new project called api")) {
        await verb("create_project", { slug: "api", name: "Public API" });
        await verb("propose", {
          kind: "member",
          charter: { name: "eng-2", role: "engineer", cli: "codex", memberships: ["api"] },
          rationale: "The owner opened a project with no engineer on it.",
        });
        return done("created the api project and proposed its first engineer");
      }
      return done("answered");
    }

    // The steward reads operations signals and proposes; it never touches tasks.
    if (request.spec.agent === "stew-1") {
      if (request.prompt.includes("Trigger: ops_event") && request.prompt.includes("**backlog**")) {
        await verb("propose", {
          kind: "member",
          charter: {
            name: "eng-2",
            role: "engineer",
            cli: "codex",
            memberships: ["demo"],
            seedInstructions: "Start with the oldest open task.",
          },
          rationale: "The backlog per engineer on demo reached the threshold.",
        });
        return done("proposed a second engineer for demo");
      }
      return done("nothing to do");
    }

    // A claim event names the task; a mention carries it in the message body.
    const taskId =
      /Task in question: ([0-9A-HJKMNP-TV-Z]{26})/.exec(request.prompt)?.[1] ??
      /take task ([0-9A-HJKMNP-TV-Z]{26})/.exec(request.prompt)?.[1];
    if (taskId === undefined || !ULID.test(taskId)) {
      return done("nothing to do");
    }

    if (request.spec.agent === "eng-1") {
      if (request.prompt.includes("task approved")) {
        await verb("close_thread", { thread_id: taskId, summary: "Shipped hello.txt." });
        return done("closed the thread");
      }
      await verb("claim_task", { task_id: taskId });
      await writeFile(path.join(request.spec.cwd, "hello.txt"), "hello from eng-1\n", "utf8");
      const git = (...args: string[]) =>
        execa("git", args, { cwd: request.spec.cwd, env: { ...process.env, ...request.env } });
      await git("add", "hello.txt");
      await git("commit", "-m", "feat: add hello.txt");
      await verb("open_thread", { task_id: taskId });
      await verb("post_message", {
        channel: "demo/general",
        body: "Committed hello.txt on my branch.",
        thread_id: taskId,
      });
      await verb("update_task", { task_id: taskId, status: "in_review", note: "ready for review" });
      return done("submitted hello.txt for review");
    }

    if (request.spec.agent === "rev-1") {
      const log = await execa("git", ["log", "--oneline", "agent/eng-1"], {
        cwd: request.spec.cwd,
      });
      if (!log.stdout.includes("feat: add hello.txt")) {
        throw new Error("reviewer cannot see the engineer's commit");
      }
      await verb("update_task", {
        task_id: taskId,
        status: "done",
        note: "reviewed the diff, tests not required for a text file",
      });
      return done("approved");
    }
    return done("no script");
  }
}

describe("Phase 1 exit criterion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-e2e-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("two agents complete a task end to end with a reviewed merge, with the owner participating by mention", async () => {
    const { board } = await Board.init(dir, { name: "e2e" });
    await board.addProject(OWNER, { slug: "demo" });
    // One agent per CLI: the board must not care which body a citizen runs on.
    await board.addAgent(OWNER, {
      name: "eng-1",
      role: "engineer",
      cli: "codex",
      memberships: ["demo"],
    });
    await board.addAgent(OWNER, {
      name: "rev-1",
      role: "reviewer",
      cli: "claude",
      memberships: ["demo"],
    });

    const app = createApp({ board, version: "test" });
    const backend = new ScriptedBackend(app);
    const runner = new LocalRunner({
      board,
      backends: { claude: backend, codex: backend },
      mcpUrl: "http://127.0.0.1:0/mcp",
    });
    const scheduler = new Scheduler({
      board,
      runner,
      timings: {
        debounceMs: 0,
        ownerDebounceMs: 0,
        heartbeatMs: 3_600_000,
        unclaimedTaskMs: 3_600_000,
      },
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };

    // Onboarding turns for both members fire from the agent.added events.
    await settle();
    expect(backend.prompts.filter((p) => p.includes("This is your first turn")).length).toBe(2);

    const task = await board.createTask(OWNER, {
      project: "demo",
      title: "Add hello.txt",
      body: "One file, one line.",
    });
    const mention = await board.postMessage(OWNER, {
      channel: "demo/general",
      body: `@eng-1 please take task ${task.id}: add hello.txt with a greeting.`,
    });

    await settle(); // eng-1: claim, commit, submit for review
    expect((await board.getTask(OWNER, { task_id: task.id })).status).toBe("in_review");
    await settle(); // rev-1: review and approve
    expect((await board.getTask(OWNER, { task_id: task.id })).status).toBe("done");
    await settle(); // merge lands and eng-1 closes the thread
    await settle();

    const final = await board.getTask(OWNER, { task_id: task.id });
    expect(final.thread).toBe("closed");

    const mainLog = await execa("git", ["log", "--oneline", "main"], {
      cwd: board.paths.repo("demo"),
    });
    expect(mainLog.stdout).toContain("feat: add hello.txt");
    expect(mainLog.stdout).toContain("merge: land agent/eng-1 on main");
    expect(await readFile(path.join(board.paths.repo("demo"), "hello.txt"), "utf8")).toBe(
      "hello from eng-1\n",
    );

    const general = await board.listChannel("demo/general");
    expect(general.some((m) => m.author === "board" && m.body.includes("Merged agent/eng-1"))).toBe(
      true,
    );
    expect(general.some((m) => m.author === "eng-1" && m.body.includes("Thread closed"))).toBe(
      true,
    );

    const types = (await board.readEvents(null)).map((e) => e.type);
    expect(types.filter((t) => t === "turn.completed").length).toBeGreaterThanOrEqual(5);
    expect(types).toContain("merge.completed");
    expect(types).not.toContain("turn.failed");

    const last = await board.readLastTurn("eng-1", "demo");
    expect(last?.exitReason).toBe("completed");
    expect(last?.status?.summary).toBe("closed the thread");
    const rendered = await readFile(
      path.join(board.paths.agent("eng-1"), ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(rendered).toContain("## Role");
    expect(rendered).toContain(board.paths.board);
    // The owner's mention was delivered in a completed turn, so the cursor has moved past it.
    const unread = await board.readInbox({ name: "eng-1", role: "engineer" }, { advance: false });
    expect(unread.messages.map((m) => m.id)).not.toContain(mention.id);
  });
});

describe("Phase 5 exit criterion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-desk-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("the owner posts naming no project and no citizen, and a resident concierge routes it", async () => {
    const { board, ownerToken } = await Board.init(dir, { name: "desk" });
    await board.addProject(OWNER, { slug: "demo" });
    await board.addAgent(OWNER, {
      name: "eng-1",
      role: "engineer",
      cli: "codex",
      memberships: ["demo"],
    });
    await board.addAgent(OWNER, { name: "desk", role: "concierge", cli: "claude" });
    const app = createApp({ board, version: "test" });
    const backend = new ScriptedBackend(app);
    const runner = new LocalRunner({
      board,
      backends: { claude: backend, codex: backend },
      mcpUrl: "http://127.0.0.1:0/mcp",
      residentIdleMs: 60_000,
    });
    const scheduler = new Scheduler({
      board,
      runner,
      timings: {
        debounceMs: 0,
        ownerDebounceMs: 0,
        heartbeatMs: 3_600_000,
        unclaimedTaskMs: 3_600_000,
      },
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };
    const owner = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };

    // Only the engineer onboards; the desk belongs to no project and waits for the owner.
    await settle();
    expect(backend.prompts.filter((p) => p.includes("This is your first turn")).length).toBe(1);

    // A request that names nobody: the desk wakes at once, in the society scope, on a warm session.
    await board.postMessage(OWNER, {
      channel: "general",
      body: "Can someone add a health endpoint? The demo service has none.",
    });
    await settle();
    expect(backend.residentStarts).toEqual(["desk/society"]);
    const deskPrompt = backend.prompts.at(-1) ?? "";
    expect(deskPrompt).toContain("Trigger: owner_post from owner");
    expect(deskPrompt).toContain("## The society");
    expect(deskPrompt).toContain("- eng-1: engineer on codex");
    const tasks = await board.listTasks("demo");
    expect(tasks.map((t) => t.title)).toEqual(["Add a health endpoint"]);
    expect((await board.listChannel("demo/general")).at(-1)?.body).toContain(
      "@eng-1 please take task",
    );
    await settle(); // the mention wakes eng-1, which claims and submits
    expect((await board.getTask(OWNER, { task_id: tasks[0]?.id ?? "" })).status).toBe("in_review");

    // A request that needs a project the society does not have: the same warm session takes it.
    await board.postMessage(OWNER, {
      channel: "general",
      body: "Let's start a new project called api for the public API.",
    });
    await settle();
    expect(backend.residentStarts).toEqual(["desk/society"]);
    expect(backend.residentCloses).toEqual([]);
    expect((await board.readProject("api")).channels).toEqual(["general", "dev"]);
    const proposals = await board.listProposals();
    expect(proposals).toEqual([
      expect.objectContaining({ kind: "member", proposedBy: "desk", status: "proposed" }),
    ]);
    const desk = (await board.listMembers()).find((m) => m.name === "desk");
    expect(desk?.lastTurnOutcome).toContain("owner_post on society: completed");

    // The owner approves over the API, as the UI does, and the new engineer onboards on api.
    const approved = await app.request("/api/verbs/approve", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ proposal_id: proposals[0]?.id }),
    });
    expect(approved.status).toBe(200);
    await settle();
    expect(
      backend.prompts.filter((p) => p.includes("This is your first turn as eng-2")).length,
    ).toBe(1);
    expect((await board.readAgent("eng-2")).memberships).toEqual(["api"]);
    expect((await board.readLastTurn("desk", "society"))?.trigger.kind).toBe("owner_post");
    const types = (await board.readEvents(null)).map((e) => e.type);
    expect(types).not.toContain("turn.failed");
    await runner.close();
    expect(backend.residentCloses).toEqual(["desk/society"]);
  });
});

describe("Phase 4 exit criterion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-gov-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("the steward proposes a member from operations signals and the owner approves over the API", async () => {
    const { board, ownerToken } = await Board.init(dir, { name: "gov" });
    await board.addProject(OWNER, { slug: "demo" });
    for (const [name, role, cli] of [
      ["eng-1", "engineer", "codex"],
      ["rev-1", "reviewer", "claude"],
      ["stew-1", "steward", "claude"],
    ] as const) {
      await board.addAgent(OWNER, { name, role, cli, memberships: ["demo"] });
    }
    const app = createApp({ board, version: "test" });
    const backend = new ScriptedBackend(app);
    const runner = new LocalRunner({
      board,
      backends: { claude: backend, codex: backend },
      mcpUrl: "http://127.0.0.1:0/mcp",
    });
    const scheduler = new Scheduler({
      board,
      runner,
      concurrency: 3,
      timings: {
        debounceMs: 0,
        ownerDebounceMs: 0,
        heartbeatMs: 3_600_000,
        unclaimedTaskMs: 3_600_000,
        opsIntervalMs: 1,
      },
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };
    const owner = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
    const get = async (route: string): Promise<unknown> =>
      (await app.request(route, { headers: owner })).json();

    await settle();
    expect(backend.prompts.filter((p) => p.includes("This is your first turn")).length).toBe(3);

    // Three open tasks for one engineer: depth three, the seed threshold.
    for (const title of ["Add hello.txt", "Add README", "Add a test"]) {
      await board.createTask(OWNER, { project: "demo", title, body: "Small." });
    }
    await settle(); // the operations pass publishes the backlog signal
    await settle(); // the signal wakes the steward, which proposes
    const proposals = z
      .array(
        z.object({ id: z.string(), kind: z.string(), status: z.string(), proposedBy: z.string() }),
      )
      .parse(await get("/api/proposals"));
    expect(proposals).toEqual([
      expect.objectContaining({ kind: "member", status: "proposed", proposedBy: "stew-1" }),
    ]);
    const proposalId = proposals[0]?.id ?? "";
    expect((await board.listChannel("governance")).at(-1)?.body).toContain(
      "member eng-2 as engineer on codex for demo",
    );
    const stewardTurn = await board.readLastTurn("stew-1", "demo");
    expect(stewardTurn?.trigger.kind).toBe("ops_event");

    // The owner approves through the same interface the UI uses.
    const approved = await app.request("/api/verbs/approve", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ proposal_id: proposalId }),
    });
    expect(approved.status).toBe(200);
    expect(
      z.object({ status: z.string() }).parse(await get(`/api/proposals/${proposalId}`)),
    ).toEqual(expect.objectContaining({ status: "provisioned" }));
    const agents = z
      .array(z.object({ name: z.string(), status: z.string(), memberships: z.array(z.string()) }))
      .parse(await get("/api/agents"));
    expect(agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "eng-2", status: "active", memberships: ["demo"] }),
      ]),
    );
    expect(await board.readAgentRoleBody("eng-2")).toContain("Start with the oldest open task.");
    expect((await board.listChannel("decisions")).at(-1)?.body).toContain(
      "Approved member proposal",
    );

    // The new member onboards through the usual dispatch, then the owner retires it over the API.
    await settle();
    expect(
      backend.prompts.filter((p) => p.includes("This is your first turn as eng-2")).length,
    ).toBe(1);
    const retired = await app.request("/api/agents/eng-2/retire", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ reason: "demo over" }),
    });
    expect(retired.status).toBe(200);
    expect((await board.readAgent("eng-2")).status).toBe("retired");
    expect((await board.readProject("demo")).members).not.toContain("eng-2");

    const types = (await board.readEvents(null)).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "ops.signal",
        "proposal.created",
        "proposal.decided",
        "proposal.provisioned",
        "agent.retired",
      ]),
    );
    expect(types).not.toContain("turn.failed");
  });
});
