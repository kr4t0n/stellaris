import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { Scheduler } from "@stellaris/scheduler";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startTestSociety, type TestSociety } from "./testing/harness.js";
import { USER, ScriptedBackend, addWorkRoles } from "./testing/scripted-backend.js";

/** The society each test runs, stopped after it: a server and a runner over the runner protocol. */
let current: TestSociety | null = null;

async function scripted(
  board: Board,
  options: { residentIdleMs?: number } = {},
): Promise<{ society: TestSociety; backend: ScriptedBackend }> {
  let backend: ScriptedBackend | null = null;
  current = await startTestSociety({
    board,
    ...options,
    backends: (app) => {
      backend = new ScriptedBackend(app);
      return { claude: backend, codex: backend };
    },
  });
  if (backend === null) {
    throw new Error("the runner was started without its backend");
  }
  return { society: current, backend };
}

describe("Phase 1 exit criterion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-e2e-"));
  });

  afterEach(async () => {
    await current?.stop();
    current = null;
    await rm(dir, { recursive: true, force: true });
  });

  it("two agents carry a planned task through a gated review and a send-back to a merge, with the user participating by mention", async () => {
    const { board } = await Board.init(dir, { name: "e2e" });
    await board.addProject(USER, { slug: "demo", onDone: "merge" });
    await addWorkRoles(board);
    // One agent per CLI: the board must not care which body a citizen runs on.
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "codex",
      memberships: ["demo"],
    });
    await board.addAgent(USER, {
      name: "rev-1",
      role: "reviewer",
      cli: "claude",
      memberships: ["demo"],
    });

    const { society, backend } = await scripted(board);
    const scheduler = new Scheduler({
      board,
      runner: society.hub,
      timings: {
        debounceMs: 0,
        userDebounceMs: 0,
        heartbeatMs: 3_600_000,
        waitingStageMs: 3_600_000,
      },
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };

    // Onboarding turns for both members fire from the agent.added events.
    await settle();
    expect(backend.prompts.filter((p) => p.includes("This is your first turn")).length).toBe(2);

    // The task is planned when it is filed; its first stage and the user's mention both wake eng-1.
    const task = await board.createTask(USER, {
      project: "demo",
      title: "Add hello.txt",
      body: "One file, one line.",
      stages: [
        { name: "build", role: "engineer" },
        { name: "review", role: "reviewer", gate: true },
      ],
    });
    const mention = await board.postMessage(USER, {
      channel: "demo/general",
      body: `@eng-1 please take task ${task.id}: add hello.txt with a greeting.`,
    });

    await settle(); // eng-1 builds on task/<id> and advances to the review
    expect(await board.getTask(USER, { task_id: task.id })).toMatchObject({
      status: "open",
      stage: "s2",
    });
    await settle(); // rev-1 holds the gate and sends the work back
    expect(await board.getTask(USER, { task_id: task.id })).toMatchObject({
      status: "open",
      stage: "s1",
    });
    await settle(); // the build stage's last holder is woken, reworks, and advances again
    await settle(); // rev-1 approves; the merge waits for its turn to end
    await settle(); // the completion effect lands task/<id> and the task is done

    const final = await board.getTask(USER, { task_id: task.id });
    expect(final.status).toBe("done");
    // The task's thread holds the work's conversation, every handover and send-back, and the
    // landing, and closed when the task ended.
    expect(await board.readThread(task.id)).toMatchObject({ state: "closed", closedBy: "board" });
    expect(
      final.messages.map((m) => [m.author, m.step?.action ?? "said", m.body.trim().split("\n")[0]]),
    ).toEqual([
      ["eng-1", "said", `Committed hello.txt on task/${task.id}.`],
      ["eng-1", "advanced", "built"],
      ["rev-1", "returned", "add a second line"],
      ["eng-1", "advanced", "second line added"],
      ["rev-1", "advanced", "reviewed the diff"],
      ["board", "landed", expect.stringMatching(/^merged into main at [0-9a-f]+\.$/)],
    ]);
    expect(final.stages.map((stage) => stage.completedBy)).toEqual(["eng-1", "rev-1"]);

    // The project lives on the runner that took its first turn, and so does its repository.
    expect((await board.readProject("demo")).runner).toBe("pod");
    const places = society.runner.paths;
    const mainLog = await execa("git", ["log", "--oneline", "main"], { cwd: places.repo("demo") });
    expect(mainLog.stdout).toContain("feat: add hello.txt");
    expect(mainLog.stdout).toContain("feat: add the second line the review asked for");
    expect(mainLog.stdout).toContain(`merge: land task/${task.id} on main`);
    expect(await readFile(path.join(places.repo("demo"), "hello.txt"), "utf8")).toBe(
      "hello from eng-1\nand a second line\n",
    );
    // Each worktree is back on its agent's own branch, so the task branch was free to hand over.
    const head = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: places.worktree("eng-1", "demo"),
    });
    expect(head.stdout).toBe("agent/eng-1");

    const general = await board.listChannel("demo/general");
    expect(
      general.some(
        (m) => m.author === "board" && m.body.includes(`Task ${task.id} "Add hello.txt" is done`),
      ),
    ).toBe(true);
    // The verdicts stayed in the task's thread; the channel has the request and the announcement.
    expect(general.map((m) => m.author)).not.toContain("rev-1");

    const types = (await board.readEvents(null)).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "task.advanced",
        "task.moved",
        "task.completing",
        "merge.completed",
        "task.completed",
      ]),
    );
    expect(types).not.toContain("turn.failed");

    // The runner renders the instructions with its own paths; the board never sees them.
    const rendered = await readFile(
      path.join(places.agent("eng-1"), ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(rendered).toContain("## Role");
    expect(rendered).toContain("## Planning");
    expect(rendered).toContain(places.board);
    expect(rendered).not.toContain("{{stellaris:");
    // The work each turn left is on its record: the task branch and its commit.
    const lastBuild = await board.readLastTurn("eng-1", "demo", task.id);
    expect(lastBuild?.work).toMatchObject({ branch: `task/${task.id}` });
    // The user's mention was delivered in a completed turn, so the cursor has moved past it.
    const unread = await board.readDigest({ name: "eng-1", role: "engineer" }, { advance: false });
    expect(unread.messages.map((m) => m.id)).not.toContain(mention.id);
  });
});

describe("Phase 5 exit criterion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-desk-"));
  });

  afterEach(async () => {
    await current?.stop();
    current = null;
    await rm(dir, { recursive: true, force: true });
  });

  it("a citizen sets a cron where it was asked, and the cron wakes it there with its note", async () => {
    const { board } = await Board.init(dir, { name: "e2e" });
    await board.addProject(USER, { slug: "demo", channels: ["general", "dev"] });
    await addWorkRoles(board);
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const { society, backend } = await scripted(board);
    // Only the scheduler's clock jumps ahead, to the cron's time; the board keeps wall time.
    let clock = Date.now();
    const scheduler = new Scheduler({
      board,
      runner: society.hub,
      now: () => new Date(clock),
      timings: {
        debounceMs: 0,
        userDebounceMs: 0,
        heartbeatMs: 3_600_000,
        waitingStageMs: 3_600_000,
      },
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };
    await settle();
    await board.postMessage(USER, {
      channel: "demo/dev",
      body: "@eng-1 please set a cron to check the deploy",
    });
    await settle();
    const [cron] = await board.listCrons();
    expect(cron).toMatchObject({
      agent: "eng-1",
      scope: "demo",
      channel: "dev",
      createdBy: "eng-1",
    });
    if (cron === undefined) {
      return;
    }
    clock += 16 * 60_000;
    await settle();
    const prompt = backend.prompts.at(-1) ?? "";
    expect(prompt).toContain("Trigger: cron");
    expect(prompt).toContain("This turn is in your conversation of demo/dev");
    expect(prompt).toContain("  Read the deploy log and post what changed.");
    expect(await board.readCron(cron.id)).toMatchObject({
      lastRun: { outcome: "completed" },
      failures: 0,
    });
  });

  it("the user posts naming no project and no citizen, and a resident concierge routes it", async () => {
    const { board, userToken } = await Board.init(dir, { name: "desk" });
    await board.addProject(USER, { slug: "demo" });
    await addWorkRoles(board);
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "codex",
      memberships: ["demo"],
    });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    const { society, backend } = await scripted(board, { residentIdleMs: 60_000 });
    const { app } = society;
    const scheduler = new Scheduler({
      board,
      runner: society.hub,
      timings: {
        debounceMs: 0,
        userDebounceMs: 0,
        heartbeatMs: 3_600_000,
        waitingStageMs: 3_600_000,
      },
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };
    const user = { authorization: `Bearer ${userToken}`, "content-type": "application/json" };

    // Only the engineer onboards; the desk belongs to no project and waits for the user.
    await settle();
    expect(backend.prompts.filter((p) => p.includes("This is your first turn")).length).toBe(1);

    // A request that names nobody: the desk wakes at once, in the society scope, on a warm session.
    await board.postMessage(USER, {
      channel: "general",
      body: "Can someone add a health endpoint? The demo service has none.",
    });
    await settle();
    expect(backend.residentStarts).toEqual(["desk/society"]);
    const deskPrompt = backend.prompts.at(-1) ?? "";
    expect(deskPrompt).toContain("Trigger: user_post from user");
    expect(deskPrompt).toContain("## The society");
    expect(deskPrompt).toContain("- eng-1: engineer on codex");
    const tasks = await board.listTasks("demo");
    expect(tasks.map((t) => [t.title, t.stages.map((s) => s.role)])).toEqual([
      ["Add a health endpoint", ["engineer"]],
    ]);
    await settle(); // the stage wakes eng-1, which builds and finishes the only stage
    expect((await board.getTask(USER, { task_id: tasks[0]?.id ?? "" })).status).toBe("done");
    await settle(); // the finished task wakes its creator, the desk, which tells the user
    expect(backend.prompts.at(-1)).toContain("Trigger: task_done");
    expect((await board.listChannel("general")).at(-1)?.body).toContain("its task is done");

    // A request that needs a project the society does not have: the same warm session takes it.
    await board.postMessage(USER, {
      channel: "general",
      body: "Let's start a new project called api for the public API.",
    });
    await settle();
    expect(backend.residentStarts).toEqual(["desk/society"]);
    expect(backend.residentCloses).toEqual([]);
    expect((await board.readProject("api")).channels).toEqual(["general"]);
    const proposals = await board.listProposals();
    expect(proposals).toEqual([
      expect.objectContaining({ kind: "member", proposedBy: "desk", status: "proposed" }),
    ]);
    const desk = (await board.listMembers()).find((m) => m.name === "desk");
    expect(desk?.lastTurnOutcome).toContain("user_post on society: completed");

    // The user approves over the API, and the new engineer onboards on api.
    const approved = await app.request("/api/verbs/approve", {
      method: "POST",
      headers: user,
      body: JSON.stringify({ proposal_id: proposals[0]?.id }),
    });
    expect(approved.status).toBe(200);
    await settle();
    expect(
      backend.prompts.filter((p) => p.includes("This is your first turn as eng-2")).length,
    ).toBe(1);
    expect((await board.readAgent("eng-2")).memberships).toEqual(["api"]);
    // The decision wakes desk as the proposer, not as a post by the user.
    expect((await board.readLastTurn("desk", "society"))?.trigger.kind).toBe("proposal_decided");
    const types = (await board.readEvents(null)).map((e) => e.type);
    expect(types).not.toContain("turn.failed");
    await society.runner.stop();
    expect(backend.residentCloses).toEqual(["desk/society"]);
  });
});

describe("Phase 4 exit criterion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-gov-"));
  });

  afterEach(async () => {
    await current?.stop();
    current = null;
    await rm(dir, { recursive: true, force: true });
  });

  it("the steward proposes a member from operations signals and the user approves over the API", async () => {
    const { board, userToken } = await Board.init(dir, { name: "gov" });
    await board.addProject(USER, { slug: "demo" });
    await addWorkRoles(board);
    for (const [name, role, cli] of [
      ["eng-1", "engineer", "codex"],
      ["rev-1", "reviewer", "claude"],
    ] as const) {
      await board.addAgent(USER, { name, role, cli, memberships: ["demo"] });
    }
    // The steward is a society role: in no project, it watches them all from outside.
    await board.addAgent(USER, { name: "stew-1", role: "steward", cli: "claude" });
    const { society, backend } = await scripted(board);
    const { app } = society;
    const scheduler = new Scheduler({
      board,
      runner: society.hub,
      concurrency: 3,
      timings: {
        debounceMs: 0,
        userDebounceMs: 0,
        heartbeatMs: 3_600_000,
        waitingStageMs: 3_600_000,
        opsIntervalMs: 1,
      },
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };
    const user = { authorization: `Bearer ${userToken}`, "content-type": "application/json" };
    const get = async (route: string): Promise<unknown> =>
      (await app.request(route, { headers: user })).json();

    await settle();
    expect(backend.prompts.filter((p) => p.includes("This is your first turn")).length).toBe(2);

    // Three stages for the engineer role and one engineer: depth three, the threshold.
    for (const title of ["Add hello.txt", "Add README", "Add a test"]) {
      await board.createTask(USER, {
        project: "demo",
        title,
        body: "Small.",
        stages: [{ name: "build", role: "engineer" }],
      });
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
    // The proposal's pitch opens its thread in governance.
    expect((await board.listThread(proposalId)).at(0)?.body).toContain(
      "member eng-2 as engineer on codex for demo",
    );
    const stewardTurn = await board.readLastTurn("stew-1", "society");
    expect(stewardTurn?.trigger.kind).toBe("ops_event");

    // The user approves over the API.
    const approved = await app.request("/api/verbs/approve", {
      method: "POST",
      headers: user,
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
    // The decision is the thread's last post, and it closed the thread.
    expect((await board.listThread(proposalId)).at(-1)).toMatchObject({
      author: "user",
      step: { action: "approved" },
      body: expect.stringContaining("Approved: member eng-2"),
    });
    expect((await board.readThread(proposalId)).state).toBe("closed");

    // The new member onboards through the usual dispatch, then the user retires it over the API.
    await settle();
    expect(
      backend.prompts.filter((p) => p.includes("This is your first turn as eng-2")).length,
    ).toBe(1);
    const retired = await app.request("/api/agents/eng-2/retire", {
      method: "POST",
      headers: user,
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
    await current?.stop();
    current = null;
    await rm(dir, { recursive: true, force: true });
  });

  it("an agent carries a lesson and a skill from one project into another, and a promoted skill reaches everyone", async () => {
    const { board, userToken } = await Board.init(dir, { name: "memory" });
    await board.addProject(USER, { slug: "alpha" });
    await addWorkRoles(board);
    await board.addProject(USER, { slug: "beta" });
    await board.addAgent(USER, {
      name: "mem-1",
      role: "engineer",
      cli: "claude",
      memberships: ["alpha"],
    });
    await board.addAgent(USER, { name: "stew-1", role: "steward", cli: "claude" });
    const { society, backend } = await scripted(board);
    const { app } = society;
    // The scheduler runs on its own clock so the reflection cadence and the heartbeat can be reached.
    let clock = Date.now();
    const scheduler = new Scheduler({
      board,
      runner: society.hub,
      now: () => new Date(clock),
      timings: {
        debounceMs: 0,
        userDebounceMs: 0,
        heartbeatMs: 3_600_000,
        waitingStageMs: 3_600_000,
        reflectionMs: 60_000,
      },
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };
    const user = { authorization: `Bearer ${userToken}`, "content-type": "application/json" };

    // Onboarding on alpha; then a working turn leaves a lesson in the core, a skill, and a project fact.
    await settle();
    await board.requestWake(USER, { agent: "mem-1", project: "alpha", reason: "work" });
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

    // The user assigns the agent to beta over the API. Its first turn there loads the lesson,
    // finds the archive by search, sees both skills, and seeds beta's knowledge from what it learned.
    const joined = await app.request("/api/verbs/join_project", {
      method: "POST",
      headers: user,
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
