import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { LocalRunner } from "@stellaris/runner-core";
import { Scheduler } from "@stellaris/scheduler";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "./app.js";
import { OWNER, ScriptedBackend } from "./testing/scripted-backend.js";

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

describe("Phase 6 exit criterion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-memory-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("an agent carries a lesson and a skill from one project into another, and a promoted skill reaches everyone", async () => {
    const { board, ownerToken } = await Board.init(dir, { name: "memory" });
    await board.addProject(OWNER, { slug: "alpha" });
    await board.addProject(OWNER, { slug: "beta" });
    await board.addAgent(OWNER, {
      name: "mem-1",
      role: "engineer",
      cli: "claude",
      memberships: ["alpha"],
    });
    await board.addAgent(OWNER, { name: "stew-1", role: "steward", cli: "claude" });
    const app = createApp({ board, version: "test" });
    const backend = new ScriptedBackend(app);
    const runner = new LocalRunner({
      board,
      backends: { claude: backend, codex: backend },
      mcpUrl: "http://127.0.0.1:0/mcp",
    });
    // The scheduler runs on its own clock so the reflection cadence and the heartbeat can be reached.
    let clock = Date.now();
    const scheduler = new Scheduler({
      board,
      runner,
      now: () => new Date(clock),
      timings: {
        debounceMs: 0,
        ownerDebounceMs: 0,
        heartbeatMs: 3_600_000,
        unclaimedTaskMs: 3_600_000,
        reflectionMs: 60_000,
      },
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };
    const owner = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };

    // Onboarding on alpha; then a working turn leaves a lesson in the core, a skill, and a project fact.
    await settle();
    await board.requestWake(OWNER, { agent: "mem-1", project: "alpha", reason: "work" });
    await settle();
    expect((await board.listKnowledge("alpha")).map((k) => k.topic)).toEqual(["testing"]);
    expect((await board.listMembers()).find((m) => m.name === "mem-1")?.skills).toEqual([
      "uv-setup",
    ]);
    expect((await board.listChannel("alpha/general")).at(-1)?.body).toContain(
      "Knowledge written: testing",
    );

    // The reflection cadence passes: the agent consolidates, archives, refreshes its profile, and
    // proposes its skill to the society. The trigger is mechanical; the turn is the agent's.
    clock += 60_000;
    await settle();
    const reflection = backend.prompts.findLast((p) => p.includes("## Reflection"));
    expect(reflection).toContain("# Turn for mem-1 on alpha");
    expect(reflection).toContain("Trigger: reflection. scheduled reflection");
    expect(reflection).toContain("- testing: updated by mem-1");
    const proposals = await board.listProposals();
    expect(proposals).toEqual([
      expect.objectContaining({ kind: "skill", proposedBy: "mem-1", status: "proposed" }),
    ]);
    expect((await board.listMembers()).find((m) => m.name === "mem-1")?.profile).toContain(
      "Python projects with uv",
    );

    // The steward's next heartbeat carries the proposal in its digest; it approves, and the board
    // promotes the skill where every citizen's skills index lists it.
    clock += 3_600_000;
    await settle();
    expect((await board.readProposal(proposals[0]?.id ?? "")).status).toBe("provisioned");
    expect((await board.listSocietySkills()).map((s) => [s.name, s.summary])).toEqual([
      ["uv-setup", "Set up a uv project with locked dependencies"],
    ]);
    expect((await board.listChannel("general")).at(-1)?.body).toContain(
      "Skill uv-setup promoted to the society",
    );

    // The owner assigns the agent to beta, as the UI would. Its first turn there loads the lesson,
    // finds the archive by search, sees both skills, and seeds beta's knowledge from what it learned.
    const joined = await app.request("/api/verbs/join_project", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ project: "beta", agent: "mem-1" }),
    });
    expect(joined.status).toBe(200);
    await settle();
    const onboarding = backend.prompts.findLast((p) => p.includes('project "beta"'));
    expect(onboarding).toContain("This is your first turn as mem-1");
    expect(onboarding).toContain("## Knowledge of beta\n\nNone yet.");
    expect((await board.listKnowledge("beta")).map((k) => k.body)).toEqual([
      expect.stringContaining("carried over from alpha"),
    ]);
    const types = (await board.readEvents(null)).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["knowledge.written", "skill.promoted", "proposal.provisioned"]),
    );
    expect(types).not.toContain("turn.failed");
    expect(backend.prompts.filter((p) => p.includes("## Reflection"))).toHaveLength(1);
  });
});
