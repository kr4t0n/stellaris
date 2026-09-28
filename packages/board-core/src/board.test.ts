import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Board, type Actor } from "./index.js";

const OWNER: Actor = { name: "owner", role: "owner" };
const ENG: Actor = { name: "eng-1", role: "engineer" };
const REV: Actor = { name: "rev-1", role: "reviewer" };

describe("Board", () => {
  let dir: string;
  let clock: Date;
  const now = (): Date => clock;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-"));
    clock = new Date("2026-09-28T10:00:00.000Z");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function society() {
    const { board, ownerToken } = await Board.init(
      dir,
      { name: "test society" },
      { now, leaseMs: 60_000 },
    );
    await board.addProject(OWNER, { slug: "demo" });
    const eng = await board.addAgent(OWNER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const rev = await board.addAgent(OWNER, {
      name: "rev-1",
      role: "reviewer",
      cli: "codex",
      memberships: ["demo"],
    });
    return { board, ownerToken, eng, rev };
  }

  it("initializes a society with seed roles, channels, a local runner, and an owner", async () => {
    const { board, ownerToken } = await society();
    expect((await board.society()).channels).toEqual(["general", "ops", "governance", "decisions"]);
    const roles = (await board.listRoles()).map((role) => role.name).toSorted();
    expect(roles).toEqual(["concierge", "engineer", "owner", "reviewer", "steward"]);
    expect(board.resolveToken(ownerToken)).toEqual(OWNER);
    expect(board.resolveToken("stl_not-a-token")).toBeNull();
    expect((await board.readProject("demo")).members.toSorted()).toEqual(["eng-1", "rev-1"]);
    await expect(Board.init(dir, { name: "again" })).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
    });
  });

  it("post, claim, review, close: the Phase 0 exit criterion", async () => {
    const { board, eng } = await society();
    expect(board.resolveToken(eng.token)).toEqual(ENG);

    const brief = await board.postMessage(OWNER, {
      channel: "demo/general",
      body: "Brief: build the thing. @eng-1 please start.",
    });
    expect(brief.mentions).toEqual(["eng-1"]);
    const task = await board.createTask(OWNER, {
      project: "demo",
      title: "Build the thing",
      body: "Details.",
    });

    const inbox = await board.readInbox(ENG);
    expect(inbox.messages.map((m) => m.id)).toEqual([brief.id]);
    expect(inbox.cursor).toBe(brief.id);
    expect((await board.readInbox(ENG)).messages).toEqual([]);

    const claimed = await board.claimTask(ENG, { task_id: task.id });
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimedBy).toBe("eng-1");
    expect(claimed.leaseExpiresAt).toBe("2026-09-28T10:01:00.000Z");
    await expect(board.claimTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "CLAIM_CONFLICT",
    });

    await board.openThread(ENG, { task_id: task.id });
    const threadMessage = await board.postMessage(ENG, {
      channel: "demo/general",
      body: "Working on it.",
      thread_id: task.id,
    });
    expect(threadMessage.thread).toBe(task.id);
    const reviewerInbox = await board.readInbox(REV);
    expect(reviewerInbox.messages.map((m) => m.id)).toEqual([brief.id]);

    await board.updateTask(ENG, { task_id: task.id, status: "in_review", note: "PR ready" });
    await expect(board.updateTask(ENG, { task_id: task.id, status: "done" })).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    const done = await board.updateTask(REV, { task_id: task.id, status: "done" });
    expect(done.status).toBe("done");
    expect(done.leaseExpiresAt).toBeUndefined();
    expect(done.body).toContain("@eng-1: PR ready");

    const summary = await board.closeThread(REV, { thread_id: task.id, summary: "Shipped." });
    expect(summary.task).toBe(task.id);
    expect((await board.getTask(ENG, { task_id: task.id })).thread).toBe("closed");
    expect((await board.listChannel("demo/general")).map((m) => m.id)).toEqual([
      brief.id,
      summary.id,
    ]);
    expect((await board.listThread(task.id)).map((m) => m.id)).toEqual([threadMessage.id]);

    const types = (await board.readEvents(null)).map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "society.initialized",
        "project.added",
        "agent.added",
        "message.posted",
        "task.created",
        "task.claimed",
        "thread.opened",
        "task.updated",
        "thread.closed",
      ]),
    );
  });

  it("treats claims as leases: expired ones can be taken over and are released by the sweep", async () => {
    const { board } = await society();
    const task = await board.createTask(OWNER, { project: "demo", title: "t" });
    await board.claimTask(ENG, { task_id: task.id });
    clock = new Date(clock.getTime() + 61_000);
    const taken = await board.claimTask(REV, { task_id: task.id });
    expect(taken.claimedBy).toBe("rev-1");
    clock = new Date(clock.getTime() + 61_000);
    const expired = await board.expireLeases();
    expect(expired.map((t) => t.id)).toEqual([task.id]);
    const reopened = await board.getTask(OWNER, { task_id: task.id });
    expect(reopened.status).toBe("open");
    expect(reopened.claimedBy).toBeUndefined();
    expect((await board.readEvents(null)).filter((e) => e.type === "lease.expired")).toHaveLength(
      2,
    );
  });

  it("enforces role charters and legal transitions", async () => {
    const { board } = await society();
    await expect(
      board.approve(ENG, { proposal_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const task = await board.createTask(ENG, { project: "demo", title: "t" });
    await expect(board.updateTask(ENG, { task_id: task.id, status: "done" })).rejects.toMatchObject(
      { code: "INVALID_TRANSITION" },
    );
    await expect(
      board.updateTask(ENG, { task_id: task.id, status: "claimed" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(board.postMessage(ENG, { channel: "demo/nope", body: "x" })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await board.claimTask(ENG, { task_id: task.id });
    await expect(board.releaseTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await board.releaseTask(ENG, { task_id: task.id })).status).toBe("open");
  });

  it("validates proposals by kind, forbids self-decisions, and reserves hiring for the owner", async () => {
    const { board } = await society();
    await board.addAgent(OWNER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };

    await expect(
      board.propose(ENG, { kind: "member", charter: { name: "x" } }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const hire = await board.propose(STEW, {
      kind: "member",
      charter: { name: "eng-2", role: "engineer", cli: "codex", memberships: ["demo"] },
      rationale: "Backlog is growing.",
    });
    expect(hire.status).toBe("proposed");
    await expect(board.approve(STEW, { proposal_id: hire.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await board.approve(OWNER, { proposal_id: hire.id })).outcome).toBe("approved");
    expect((await board.readProposal(hire.id)).status).toBe("provisioned");
    await expect(
      board.reject(OWNER, { proposal_id: hire.id, reason: "late" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    const channel = await board.propose(ENG, {
      kind: "channel",
      charter: { project: "demo", name: "design", purpose: "Design discussion" },
    });
    expect((await board.approve(STEW, { proposal_id: channel.id })).outcome).toBe("approved");
  });

  it("provisions what an approval asked for: members, channels, roles, retirements", async () => {
    const { board, eng } = await society();
    await board.addAgent(OWNER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };
    expect((await board.readAgent("stew")).subscriptions).toEqual(
      expect.arrayContaining(["ops", "governance"]),
    );

    // A member proposal becomes an agent with a home, memberships, and seed instructions.
    const hire = await board.propose(STEW, {
      kind: "member",
      charter: {
        name: "eng-2",
        role: "engineer",
        cli: "codex",
        memberships: ["demo"],
        seedInstructions: "Focus on the API layer first.",
      },
      rationale: "Backlog depth is above threshold.",
    });
    expect((await board.listChannel("governance")).at(-1)?.body).toContain(
      `Proposal ${hire.id}: member eng-2 as engineer on codex for demo`,
    );
    await board.approve(OWNER, { proposal_id: hire.id });
    const provisioned = await board.readProposal(hire.id);
    expect(provisioned.status).toBe("provisioned");
    expect(provisioned.provision).toMatchObject({ agent: "eng-2", memberships: ["demo"] });
    const eng2 = await board.readAgent("eng-2");
    expect(eng2.memberships).toEqual(["demo"]);
    expect((await board.readProject("demo")).members).toContain("eng-2");
    expect(await board.readAgentRoleBody("eng-2")).toContain("Focus on the API layer first.");
    const added = (await board.readEvents(null)).find(
      (event) => event.type === "agent.added" && event.payload["name"] === "eng-2",
    );
    expect(added?.payload["proposalId"]).toBe(hire.id);
    expect((await board.listChannel("decisions")).at(-1)?.body).toContain(
      "Approved member proposal",
    );

    // A channel proposal opens the channel with its purpose as the first message.
    const channel = await board.propose(ENG, {
      kind: "channel",
      charter: { project: "demo", name: "design", purpose: "Design discussion" },
    });
    await board.approve(STEW, { proposal_id: channel.id });
    expect((await board.readProject("demo")).channels).toContain("design");
    expect((await board.listChannel("demo/design"))[0]?.body).toContain("Design discussion");
    expect((await board.readProposal(channel.id)).status).toBe("provisioned");

    // A role proposal writes the charter, and the role is usable at once.
    const role = await board.propose(STEW, {
      kind: "role",
      charter: {
        name: "designer",
        purpose: "Owns the visual language.",
        verbs: ["post_message", "read_inbox", "search"],
        repoPermission: "read",
        wakeTriggers: ["mention"],
      },
    });
    await board.approve(OWNER, { proposal_id: role.id });
    expect((await board.readRole("designer")).maxReplicas).toBe(1);
    expect((await board.listRoles()).map((r) => r.name)).toContain("designer");

    // A retirement releases claims, revokes the token, and leaves the projection.
    const task = await board.createTask(OWNER, { project: "demo", title: "t" });
    await board.claimTask(ENG, { task_id: task.id });
    const retirement = await board.propose(STEW, {
      kind: "retirement",
      charter: { agent: "eng-1", reason: "idle for a week" },
    });
    await expect(board.approve(STEW, { proposal_id: retirement.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await board.approve(OWNER, { proposal_id: retirement.id });
    const retired = await board.readAgent("eng-1");
    expect(retired.status).toBe("retired");
    expect(retired.retiredReason).toBe("idle for a week");
    expect((await board.getTask(OWNER, { task_id: task.id })).status).toBe("open");
    expect(board.resolveToken(eng.token)).toBeNull();
    expect((await board.readProject("demo")).members).not.toContain("eng-1");
    expect((await board.projectMembers("demo")).map((a) => a.name)).toEqual([
      "eng-2",
      "owner",
      "rev-1",
    ]);
    expect((await board.listChannel("general")).at(-1)?.body).toContain("Retired eng-1");
    expect((await board.readProposal(retirement.id)).provision).toMatchObject({
      agent: "eng-1",
      releasedTasks: [task.id],
    });

    // A reallocation has nothing to provision; it stays approved on the record.
    const reallocation = await board.propose(STEW, {
      kind: "reallocation",
      charter: { description: "Move rev-1 to the api project." },
    });
    await board.approve(OWNER, { proposal_id: reallocation.id });
    expect((await board.readProposal(reallocation.id)).status).toBe("approved");
  });

  it("refuses proposals that could not be provisioned, and guards direct administration", async () => {
    const { board } = await society();
    await board.addAgent(OWNER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };
    await expect(
      board.propose(STEW, {
        kind: "member",
        charter: { name: "eng-1", role: "engineer", cli: "claude" },
      }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await expect(
      board.propose(STEW, {
        kind: "member",
        charter: { name: "eng-9", role: "wizard", cli: "claude" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      board.propose(STEW, { kind: "retirement", charter: { agent: "owner", reason: "no" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      board.propose(STEW, {
        kind: "channel",
        charter: { project: "demo", name: "general", purpose: "dup" },
      }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });

    // Direct administration: the owner retires and edits charters; the steward may not.
    await expect(board.retireAgent(STEW, { name: "eng-1", reason: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      board.setRoleCharter(STEW, { ...(await board.readRole("engineer")), maxReplicas: 2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const engineer = await board.setRoleCharter(OWNER, {
      ...(await board.readRole("engineer")),
      maxReplicas: 3,
      backlogThreshold: 2,
    });
    expect(engineer.maxReplicas).toBe(3);
    expect((await board.readRole("engineer")).backlogThreshold).toBe(2);

    // A replica is cloned from the newest active member of the role on the project.
    const replica = await board.addReplica(OWNER, { project: "demo", role: "engineer" });
    expect(replica.name).toBe("eng-2");
    expect(replica.cli).toBe("claude");
    expect(replica.memberships).toEqual(["demo"]);
    const scaled = (await board.readEvents(null)).find(
      (event) => event.type === "agent.added" && event.payload["name"] === "eng-2",
    );
    expect(scaled?.payload["scaledFrom"]).toBe("eng-1");
    await board.retireAgent(OWNER, { name: "eng-2", reason: "demo" });
    expect((await board.addReplica(OWNER, { project: "demo", role: "engineer" })).name).toBe(
      "eng-3",
    );
    // A society-wide member of the role is the fallback template; a role with none cannot scale.
    expect((await board.addReplica(OWNER, { project: "demo", role: "steward" })).name).toBe(
      "stew-2",
    );
    await board.setRoleCharter(OWNER, {
      name: "designer",
      purpose: "Owns the visual language.",
      verbs: ["post_message"],
      repoPermission: "read",
      wakeTriggers: ["mention"],
    });
    await expect(
      board.addReplica(OWNER, { project: "demo", role: "designer" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Channels can be added directly by the owner or the steward.
    expect(
      await board.addChannel(STEW, { project: null, name: "random", purpose: "Off topic" }),
    ).toBe("random");
    expect((await board.society()).channels).toContain("random");
    expect((await board.readAgent("owner")).subscriptions).toContain("random");

    // Runner state changes are recorded and signalled; signals are readable back.
    const runner = await board.markRunner("local", { status: "connected", clis: ["claude"] });
    expect(runner.status).toBe("connected");
    await board.publishSignal({
      kind: "backlog",
      key: "backlog:demo:engineer",
      summary: "demo: 4 open or claimed tasks for 1 engineer",
      value: 4,
      threshold: 3,
      project: "demo",
      role: "engineer",
    });
    const signals = await board.listSignals();
    expect(signals.map((record) => record.signal.kind)).toEqual(["runner", "backlog"]);
    expect((await board.listChannel("ops")).at(-1)?.body).toContain("**backlog** demo: 4 open");
    const types = (await board.readEvents(null)).map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining(["runner.changed", "ops.signal", "role.added", "channel.added"]),
    );
  });

  it("searches messages and tasks, and only the owner can pause", async () => {
    const { board } = await society();
    await board.postMessage(ENG, { channel: "demo/dev", body: "The pagination cursor is base64." });
    await board.createTask(ENG, { project: "demo", title: "Fix pagination", body: "cursor bug" });
    const hits = await board.search(ENG, { query: "pagination" });
    expect(hits.map((hit) => hit.kind).toSorted()).toEqual(["message", "task"]);
    expect(await board.isPaused()).toBe(false);
    await board.setPaused(OWNER, true);
    expect(await board.isPaused()).toBe(true);
    await expect(board.setPaused(ENG, false)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reopens with the token index intact, seeding roles an older build did not know", async () => {
    const { board, eng } = await society();
    await rm(board.paths.role("concierge"));
    await rm(board.paths.members(), { recursive: true, force: true });
    const reopened = await Board.open(dir);
    expect(reopened.resolveToken(eng.token)).toEqual(ENG);
    expect((await reopened.readRole("concierge")).resident).toBe(true);
    expect((await reopened.listRoles()).map((role) => role.name)).toContain("concierge");
    const seeded = (await reopened.readEvents(null)).filter(
      (event) => event.type === "role.added" && event.payload["seeded"] === true,
    );
    expect(seeded.map((event) => event.payload["name"])).toEqual(["concierge"]);
    await expect(Board.open(path.join(dir, "nowhere"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("runs the front desk: projects and membership as verbs, and a roster that dispatch can read", async () => {
    const { board } = await society();
    await board.addAgent(OWNER, { name: "desk", role: "concierge", cli: "claude" });
    const DESK: Actor = { name: "desk", role: "concierge" };

    // Only roles chartered for it open projects; the society scope is reserved.
    await expect(
      board.createProject(ENG, { slug: "api", name: "Public API" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(board.createProject(DESK, { slug: "society" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const api = await board.createProject(DESK, { slug: "api", name: "Public API" });
    expect(api.channels).toEqual(["general", "dev"]);
    expect((await board.readAgent("owner")).memberships).toContain("api");

    // Citizens join themselves; the front desk adds others; an engineer may not.
    expect((await board.joinProject(ENG, { project: "api" })).memberships).toEqual(["demo", "api"]);
    await expect(board.joinProject(ENG, { project: "api", agent: "rev-1" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const rev = await board.joinProject(DESK, { project: "api", agent: "rev-1" });
    expect(rev.memberships).toContain("api");
    expect(rev.subscriptions).toContain("api/general");
    expect((await board.readProject("api")).members.toSorted()).toEqual(["eng-1", "rev-1"]);
    expect((await board.readEvents(null)).filter((e) => e.type === "agent.joined")).toHaveLength(2);
    // Joining twice is a no-op, leaving releases the claims held there.
    expect((await board.joinProject(ENG, { project: "api" })).memberships).toEqual(["demo", "api"]);
    const task = await board.createTask(OWNER, { project: "api", title: "t" });
    await board.claimTask(ENG, { task_id: task.id });
    const left = await board.leaveProject(ENG, { project: "api" });
    expect(left.memberships).toEqual(["demo"]);
    expect(left.subscriptions).not.toContain("api/general");
    expect((await board.getTask(OWNER, { task_id: task.id })).status).toBe("open");
    expect((await board.readProject("api")).members).toEqual(["rev-1"]);

    // The roster: identity, reach, availability, and the citizen's own profile.
    const members = await board.listMembers();
    expect(members.map((m) => m.name).toSorted()).toEqual(["desk", "eng-1", "owner", "rev-1"]);
    const desk = members.find((m) => m.name === "desk");
    expect(desk).toMatchObject({ role: "concierge", resident: true, memberships: [] });
    expect(desk?.profile).toContain("# Profile");
    const eng = members.find((m) => m.name === "eng-1");
    expect(eng).toMatchObject({ memberships: ["demo"], claimsHeld: 0, tasksDone: 0 });
    const demoTask = await board.createTask(OWNER, { project: "demo", title: "d" });
    await board.claimTask(ENG, { task_id: demoTask.id });
    expect((await board.listMembers()).find((m) => m.name === "eng-1")?.claimsHeld).toBe(1);
    await board.updateTask(ENG, { task_id: demoTask.id, status: "in_review" });
    await board.updateTask(REV, { task_id: demoTask.id, status: "done" });
    const after = (await board.listMembers()).find((m) => m.name === "eng-1");
    expect(after).toMatchObject({ claimsHeld: 0, tasksDone: 1 });

    // Society-scope wakes are for roles that may work outside projects.
    await expect(
      board.requestWake(OWNER, { agent: "desk", project: "society", reason: "dev" }),
    ).resolves.toMatchObject({ type: "wake.requested" });
    await expect(
      board.requestWake(OWNER, { agent: "eng-1", project: "society", reason: "dev" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // Turn tokens can be extended for a resident session and revoked when it closes.
    const token = board.issueTurnToken("desk", "concierge", 1_000);
    expect(board.extendTurnToken(token, 60_000)).toBe(true);
    clock = new Date(clock.getTime() + 30_000);
    expect(board.resolveToken(token)).toEqual(DESK);
    board.revokeTurnToken(token);
    expect(board.resolveToken(token)).toBeNull();
  });

  it("resolves a relative data directory, so worktree and home paths never depend on a cwd", async () => {
    const relative = path.relative(process.cwd(), dir);
    expect(path.isAbsolute(relative)).toBe(false);
    const { board } = await Board.init(relative, { name: "relative" });
    expect(board.paths.dataDir).toBe(dir);
    expect(path.isAbsolute(board.paths.worktree("eng-1", "demo"))).toBe(true);
    expect(board.paths.repo("demo")).toBe(path.join(dir, "repos", "demo"));
    expect((await Board.open(relative)).paths.agent("eng-1")).toBe(
      path.join(dir, "agents", "eng-1"),
    );
  });
});
