import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MEMBER_VERBS } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Board, SYSTEM_ACTOR, type Actor } from "./index.js";

const USER: Actor = { name: "user", role: "user" };
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
    const { board, userToken } = await Board.init(
      dir,
      { name: "test society" },
      { now, leaseMs: 60_000 },
    );
    await board.addProject(USER, { slug: "demo" });
    for (const role of ["engineer", "reviewer"]) {
      await board.setRoleCharter(USER, {
        name: role,
        purpose: `The ${role} of the test society.`,
        verbs: [...MEMBER_VERBS],
        wakeTriggers: ["heartbeat"],
      });
    }
    const eng = await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const rev = await board.addAgent(USER, {
      name: "rev-1",
      role: "reviewer",
      cli: "codex",
      memberships: ["demo"],
    });
    return { board, userToken, eng, rev };
  }

  it("initializes a society with seed roles, channels, the server runner, and a user", async () => {
    const { board, userToken } = await society();
    expect((await board.society()).channels).toEqual(["general", "ops", "governance", "decisions"]);
    const roles = (await board.listRoles()).map((role) => role.name).toSorted();
    expect(roles).toEqual(["concierge", "engineer", "reviewer", "steward", "user"]);
    expect(board.resolveToken(userToken)).toEqual(USER);
    expect(board.resolveToken("stl_not-a-token")).toBeNull();
    expect((await board.readProject("demo")).members.toSorted()).toEqual(["eng-1", "rev-1"]);
    await expect(Board.init(dir, { name: "again" })).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
    });
  });

  it("post, claim, review, close: the Phase 0 exit criterion", async () => {
    const { board, eng } = await society();
    expect(board.resolveToken(eng.token)).toEqual(ENG);

    const brief = await board.postMessage(USER, {
      channel: "demo/general",
      body: "Brief: build the thing. @eng-1 please start.",
    });
    expect(brief.mentions).toEqual(["eng-1"]);
    const task = await board.createTask(USER, {
      project: "demo",
      title: "Build the thing",
      body: "Details.",
      stages: [
        { name: "build", role: "engineer" },
        { name: "review", role: "reviewer", gate: true },
      ],
    });
    expect(task.stages.map((stage) => [stage.id, stage.name])).toEqual([
      ["s1", "build"],
      ["s2", "review"],
    ]);
    expect(task).toMatchObject({ status: "open", stage: "s1", onDone: "none" });

    const inbox = await board.readInbox(ENG);
    expect(inbox.messages.map((m) => m.id)).toEqual([brief.id]);
    expect(inbox.cursor).toBe(brief.id);
    expect((await board.readInbox(ENG)).messages).toEqual([]);

    await expect(board.claimTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
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

    const reviewing = await board.advanceTask(ENG, { task_id: task.id, note: "PR ready" });
    expect(reviewing).toMatchObject({ status: "open", stage: "s2" });
    expect(reviewing.claimedBy).toBeUndefined();
    await expect(board.claimTask(ENG, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await board.claimTask(REV, { task_id: task.id });
    const done = await board.advanceTask(REV, { task_id: task.id });
    expect(done.status).toBe("done");
    expect(done.leaseExpiresAt).toBeUndefined();
    expect(done.body).toContain("@eng-1: build: PR ready");
    expect(done.stages.map((stage) => stage.completedBy)).toEqual(["eng-1", "rev-1"]);

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
        "task.advanced",
        "task.completed",
        "thread.closed",
      ]),
    );
  });

  it("treats claims as leases: expired ones can be taken over and are released by the sweep", async () => {
    const { board } = await society();
    const task = await board.createTask(USER, { project: "demo", title: "t" });
    await board.claimTask(ENG, { task_id: task.id });
    clock = new Date(clock.getTime() + 61_000);
    const taken = await board.claimTask(REV, { task_id: task.id });
    expect(taken.claimedBy).toBe("rev-1");
    clock = new Date(clock.getTime() + 61_000);
    const expired = await board.expireLeases();
    expect(expired.map((t) => t.id)).toEqual([task.id]);
    const reopened = await board.getTask(USER, { task_id: task.id });
    expect(reopened.status).toBe("open");
    expect(reopened.claimedBy).toBeUndefined();
    expect((await board.readEvents(null)).filter((e) => e.type === "lease.expired")).toHaveLength(
      2,
    );
  });

  it("enforces role charters and the lifecycle's ends", async () => {
    const { board } = await society();
    await expect(
      board.approve(ENG, { proposal_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      board.createTask(ENG, {
        project: "demo",
        title: "gated",
        stages: [{ name: "check", gate: true }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const task = await board.createTask(ENG, { project: "demo", title: "t" });
    expect(task.stages.map((stage) => stage.name)).toEqual(["work"]);
    await expect(board.advanceTask(ENG, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(board.updateTask(ENG, { task_id: task.id, stage: "s1" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(board.postMessage(ENG, { channel: "demo/nope", body: "x" })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await board.claimTask(ENG, { task_id: task.id });
    await expect(board.releaseTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await board.releaseTask(ENG, { task_id: task.id })).status).toBe("open");
    await board.claimTask(ENG, { task_id: task.id });
    expect((await board.advanceTask(ENG, { task_id: task.id })).status).toBe("done");
    await expect(board.claimTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    const other = await board.createTask(ENG, { project: "demo", title: "u" });
    await expect(
      board.updateTask(REV, { task_id: other.id, status: "abandoned" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await board.updateTask(ENG, { task_id: other.id, status: "abandoned" })).status).toBe(
      "abandoned",
    );
  });

  it("runs a plan: stages advance and return, members reshape what is ahead, and gates stay guarded", async () => {
    const { board } = await society();
    for (const role of ["researcher", "editor"]) {
      await board.setRoleCharter(USER, {
        name: role,
        purpose: `A ${role}.`,
        verbs: [...MEMBER_VERBS],
        wakeTriggers: [],
      });
    }
    const lab = await board.addProject(USER, {
      slug: "lab",
      defaultPlan: [
        { name: "experiment", role: "researcher", gate: false },
        { name: "write-up", role: "researcher", gate: false },
        { name: "referee review", role: "editor", gate: true },
      ],
    });
    expect(lab.onDone).toBe("none");
    for (const [name, role] of [
      ["res-1", "researcher"],
      ["ed-1", "editor"],
      ["ed-2", "editor"],
    ] as const) {
      await board.addAgent(USER, { name, role, cli: "claude", memberships: ["lab"] });
    }
    const RES: Actor = { name: "res-1", role: "researcher" };
    const ED1: Actor = { name: "ed-1", role: "editor" };
    const ED2: Actor = { name: "ed-2", role: "editor" };

    // The project's default plan applies when the creator gives none.
    const task = await board.createTask(USER, { project: "lab", title: "Churn model" });
    expect(task.stages.map((s) => `${s.id}:${s.name}:${s.gate}`)).toEqual([
      "s1:experiment:false",
      "s2:write-up:false",
      "s3:referee review:true",
    ]);
    await board.claimTask(RES, { task_id: task.id });
    await board.advanceTask(RES, { task_id: task.id, note: "baseline done" });

    // Another round is one more stage, inserted mid-flight by the researcher itself.
    const replanned = await board.planTask(RES, {
      task_id: task.id,
      stages: [
        { name: "second experiment", role: "researcher" },
        { id: "s2", name: "write-up", role: "researcher" },
        { id: "s3", name: "referee review", role: "editor", gate: true },
      ],
    });
    expect(replanned.stage).toBe("s4");
    expect(replanned.stages.map((s) => s.id)).toEqual(["s1", "s4", "s2", "s3"]);

    // The member a gate checks cannot drop, clear, add, move, or reassign one.
    const refused = [
      [
        { id: "s4", name: "second experiment" },
        { id: "s2", name: "write-up" },
      ],
      [
        { id: "s4", name: "second experiment" },
        { id: "s2", name: "write-up" },
        { id: "s3", name: "referee review", role: "editor" },
      ],
      [
        { id: "s4", name: "second experiment" },
        { id: "s2", name: "write-up" },
        { id: "s3", name: "referee review", role: "editor", gate: true },
        { name: "second opinion", gate: true },
      ],
      [
        { id: "s4", name: "second experiment" },
        { id: "s3", name: "referee review", role: "editor", gate: true },
        { id: "s2", name: "write-up" },
      ],
      [
        { id: "s4", name: "second experiment" },
        { id: "s2", name: "write-up" },
        { id: "s3", name: "referee review", role: "researcher", gate: true },
      ],
    ];
    for (const stages of refused) {
      await expect(board.planTask(RES, { task_id: task.id, stages })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    await expect(
      board.planTask(RES, { task_id: task.id, stages: [{ id: "s1", name: "again" }] }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // The user inserts an unassigned audit; anyone in the project may hold it.
    const audited = await board.planTask(USER, {
      task_id: task.id,
      stages: [
        { id: "s4", name: "second experiment", role: "researcher" },
        { name: "data audit" },
        { id: "s2", name: "write-up", role: "researcher" },
        { id: "s3", name: "referee review", role: "editor", gate: true },
      ],
    });
    expect(audited.stages.map((s) => s.id)).toEqual(["s1", "s4", "s5", "s2", "s3"]);
    await board.claimTask(RES, { task_id: task.id });
    await board.advanceTask(RES, { task_id: task.id });
    await board.claimTask(ED1, { task_id: task.id });
    await board.advanceTask(ED1, { task_id: task.id });
    await board.claimTask(RES, { task_id: task.id });
    await board.advanceTask(RES, { task_id: task.id });

    // The gate is an independent check: ed-1 held the audit, so ed-2 referees.
    await expect(board.claimTask(RES, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(board.claimTask(ED1, { task_id: task.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await board.claimTask(ED2, { task_id: task.id });
    const sentBack = await board.updateTask(ED2, {
      task_id: task.id,
      stage: "s2",
      note: "the write-up skips the ablation",
    });
    expect(sentBack).toMatchObject({ status: "open", stage: "s2" });
    expect(sentBack.stages.find((s) => s.id === "s2")?.completedBy).toBeUndefined();
    await board.claimTask(RES, { task_id: task.id });
    await board.advanceTask(RES, { task_id: task.id, note: "ablation added" });
    await board.claimTask(ED2, { task_id: task.id });
    const done = await board.advanceTask(ED2, { task_id: task.id });
    expect(done.status).toBe("done");

    const members = await board.listMembers();
    for (const name of ["res-1", "ed-1", "ed-2"]) {
      expect(members.find((m) => m.name === name)?.tasksDone).toBe(1);
    }
    const types = (await board.readEvents(null)).map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining(["task.planned", "task.moved", "task.advanced", "task.completed"]),
    );
  });

  it("runs completion effects: a merge project completes through the board, and a failure reopens the last stage", async () => {
    const { board } = await society();
    await expect(
      board.configureProject(ENG, { project: "demo", on_done: "merge" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const configured = await board.configureProject(USER, {
      project: "demo",
      on_done: "merge",
      default_plan: [{ name: "build", role: "engineer" }],
    });
    expect(configured).toMatchObject({ onDone: "merge" });

    const task = await board.createTask(USER, { project: "demo", title: "Add hello.txt" });
    expect(task.onDone).toBe("merge");
    await expect(
      board.planTask(ENG, {
        task_id: task.id,
        stages: [{ id: "s1", name: "build" }],
        on_done: "none",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await board.claimTask(ENG, { task_id: task.id });
    const completing = await board.advanceTask(ENG, { task_id: task.id });
    expect(completing).toMatchObject({ status: "open", completing: true });
    await expect(board.claimTask(REV, { task_id: task.id })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });

    const reopened = await board.finishCompletion(SYSTEM_ACTOR, {
      taskId: task.id,
      ok: false,
      detail: "conflict in hello.txt",
    });
    expect(reopened).toMatchObject({ status: "open", completing: false, stage: "s1" });
    expect(reopened.stages[0]?.completedBy).toBeUndefined();
    await board.claimTask(ENG, { task_id: task.id });
    await board.advanceTask(ENG, { task_id: task.id });
    const done = await board.finishCompletion(SYSTEM_ACTOR, {
      taskId: task.id,
      ok: true,
      detail: "merged",
    });
    expect(done.status).toBe("done");
    const events = await board.readEvents(null);
    expect(events.filter((e) => e.type === "task.completing")).toHaveLength(2);
    expect(events.find((e) => e.type === "task.reopened")?.payload["detail"]).toBe(
      "conflict in hello.txt",
    );
    expect(events.find((e) => e.type === "task.completed")?.payload["createdBy"]).toBe("user");
  });

  it("validates proposals by kind, forbids self-decisions, and reserves hiring for the user", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
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
    expect((await board.approve(USER, { proposal_id: hire.id })).outcome).toBe("approved");
    expect((await board.readProposal(hire.id)).status).toBe("provisioned");
    await expect(
      board.reject(USER, { proposal_id: hire.id, reason: "late" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    const channel = await board.propose(ENG, {
      kind: "channel",
      charter: { project: "demo", name: "design", purpose: "Design discussion" },
    });
    expect((await board.approve(STEW, { proposal_id: channel.id })).outcome).toBe("approved");
  });

  it("provisions what an approval asked for: members, channels, roles, retirements", async () => {
    const { board, eng } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
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
    await board.approve(USER, { proposal_id: hire.id });
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
        wakeTriggers: ["heartbeat"],
      },
    });
    await board.approve(USER, { proposal_id: role.id });
    expect((await board.readRole("designer")).maxReplicas).toBe(1);
    expect((await board.listRoles()).map((r) => r.name)).toContain("designer");

    // A retirement releases claims, revokes the token, and leaves the projection.
    const task = await board.createTask(USER, { project: "demo", title: "t" });
    await board.claimTask(ENG, { task_id: task.id });
    const retirement = await board.propose(STEW, {
      kind: "retirement",
      charter: { agent: "eng-1", reason: "idle for a week" },
    });
    await expect(board.approve(STEW, { proposal_id: retirement.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await board.approve(USER, { proposal_id: retirement.id });
    const retired = await board.readAgent("eng-1");
    expect(retired.status).toBe("retired");
    expect(retired.retiredReason).toBe("idle for a week");
    expect((await board.getTask(USER, { task_id: task.id })).status).toBe("open");
    expect(board.resolveToken(eng.token)).toBeNull();
    expect((await board.readProject("demo")).members).not.toContain("eng-1");
    expect((await board.projectMembers("demo")).map((a) => a.name)).toEqual([
      "eng-2",
      "rev-1",
      "user",
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
    await board.approve(USER, { proposal_id: reallocation.id });
    expect((await board.readProposal(reallocation.id)).status).toBe("approved");
  });

  it("refuses proposals that could not be provisioned, and guards direct administration", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
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
      board.propose(STEW, { kind: "retirement", charter: { agent: "user", reason: "no" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      board.propose(STEW, {
        kind: "channel",
        charter: { project: "demo", name: "general", purpose: "dup" },
      }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });

    // Direct administration: the user retires and edits charters; the steward may not.
    await expect(board.retireAgent(STEW, { name: "eng-1", reason: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      board.setRoleCharter(STEW, { ...(await board.readRole("engineer")), maxReplicas: 2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const engineer = await board.setRoleCharter(USER, {
      ...(await board.readRole("engineer")),
      purpose: "Builds and ships, tests first.",
      maxReplicas: 3,
      backlogThreshold: 2,
    });
    expect(engineer.maxReplicas).toBe(3);
    expect((await board.readRole("engineer")).backlogThreshold).toBe(2);
    // The change reaches the members' own role files, which is what their turns render.
    expect(await board.readAgentRoleBody("eng-1")).toContain("Builds and ships, tests first.");

    // A replica is cloned from the newest active member of the role on the project.
    const replica = await board.addReplica(USER, { project: "demo", role: "engineer" });
    expect(replica.name).toBe("eng-2");
    expect(replica.cli).toBe("claude");
    expect(replica.memberships).toEqual(["demo"]);
    const scaled = (await board.readEvents(null)).find(
      (event) => event.type === "agent.added" && event.payload["name"] === "eng-2",
    );
    expect(scaled?.payload["scaledFrom"]).toBe("eng-1");
    await board.retireAgent(USER, { name: "eng-2", reason: "demo" });
    expect((await board.addReplica(USER, { project: "demo", role: "engineer" })).name).toBe(
      "eng-3",
    );
    // A society-wide member of the role is the fallback template; a role with none cannot scale.
    expect((await board.addReplica(USER, { project: "demo", role: "steward" })).name).toBe(
      "stew-2",
    );
    await board.setRoleCharter(USER, {
      name: "designer",
      purpose: "Owns the visual language.",
      verbs: ["post_message"],
      wakeTriggers: [],
    });
    await expect(
      board.addReplica(USER, { project: "demo", role: "designer" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Channels can be added directly by the user or the steward.
    expect(
      await board.addChannel(STEW, { project: null, name: "random", purpose: "Off topic" }),
    ).toBe("random");
    expect((await board.society()).channels).toContain("random");
    expect((await board.readAgent("user")).subscriptions).toContain("random");

    // Runner state changes are recorded and signalled; signals are readable back.
    const runner = await board.markRunner("server", { status: "connected", clis: ["claude"] });
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

  it("searches messages and tasks, and only the user can pause", async () => {
    const { board } = await society();
    await board.postMessage(ENG, { channel: "demo/dev", body: "The pagination cursor is base64." });
    await board.createTask(ENG, { project: "demo", title: "Fix pagination", body: "cursor bug" });
    const hits = await board.search(ENG, { query: "pagination" });
    expect(hits.map((hit) => hit.kind).toSorted()).toEqual(["message", "task"]);
    expect(await board.isPaused()).toBe(false);
    await board.setPaused(USER, true);
    expect(await board.isPaused()).toBe(true);
    await expect(board.setPaused(ENG, false)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reopens with the token index intact, aligning seed roles an older build wrote differently", async () => {
    const { board, eng } = await society();
    await board.addAgent(USER, {
      name: "stew",
      role: "steward",
      cli: "claude",
      seedInstructions: "Read the ops channel first.",
    });
    await rm(board.paths.role("concierge"));
    await rm(board.paths.members(), { recursive: true, force: true });
    // A charter written before a verb existed: the user's other edits must survive the grant.
    const steward = await board.readRole("steward");
    await board.setRoleCharter(USER, {
      ...steward,
      verbs: steward.verbs.filter((verb) => verb !== "write_knowledge"),
      maxReplicas: 4,
    });
    // A charter written before a field existed: the seed's value applies, not the schema's default.
    const stewardFile = board.paths.role("steward");
    await writeFile(
      stewardFile,
      (await readFile(stewardFile, "utf8")).replace("societyScope: true\n", ""),
      "utf8",
    );
    // The user charter is nobody's to edit, so it is the seed's in full.
    const userFile = board.paths.role("user");
    await writeFile(
      userFile,
      (await readFile(userFile, "utf8")).replace("reflects: false\n", "reflects: true\n"),
      "utf8",
    );
    const reopened = await Board.open(dir);
    expect(reopened.resolveToken(eng.token)).toEqual(ENG);
    expect((await reopened.readRole("concierge")).resident).toBe(true);
    expect((await reopened.listRoles()).map((role) => role.name)).toContain("concierge");
    const granted = await reopened.readRole("steward");
    expect(granted.verbs).toContain("write_knowledge");
    expect(granted.maxReplicas).toBe(4);
    expect(granted.societyScope).toBe(true);
    expect((await reopened.readRole("user")).reflects).toBe(false);
    const seeded = (await reopened.readEvents(null)).filter(
      (event) => event.type === "role.added" && event.payload["seeded"] === true,
    );
    expect(
      seeded.map((event) => [
        event.payload["name"],
        event.payload["verbsAdded"],
        event.payload["fieldsAligned"],
      ]),
    ).toEqual([
      ["user", [], ["reflects"]],
      ["steward", ["write_knowledge"], ["societyScope"]],
      ["concierge", undefined, undefined],
    ]);
    // The members' own role files follow, seed instructions included.
    const stewRole = await reopened.readAgentRoleBody("stew");
    expect(stewRole).toContain("# stew, steward");
    expect(stewRole).toContain("## Seed instructions\n\nRead the ops channel first.");
    // Opening again aligns nothing more.
    await Board.open(dir);
    expect(
      (await reopened.readEvents(null)).filter(
        (event) => event.type === "role.added" && event.payload["seeded"] === true,
      ),
    ).toHaveLength(3);
    await expect(Board.open(path.join(dir, "nowhere"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("runs the front desk: projects and membership as verbs, and a roster that dispatch can read", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
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
    expect((await board.readAgent("user")).memberships).toContain("api");

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
    const task = await board.createTask(USER, { project: "api", title: "t" });
    await board.claimTask(ENG, { task_id: task.id });
    const left = await board.leaveProject(ENG, { project: "api" });
    expect(left.memberships).toEqual(["demo"]);
    expect(left.subscriptions).not.toContain("api/general");
    expect((await board.getTask(USER, { task_id: task.id })).status).toBe("open");
    expect((await board.readProject("api")).members).toEqual(["rev-1"]);

    // The roster: identity, reach, availability, and the citizen's own profile.
    const members = await board.listMembers();
    expect(members.map((m) => m.name).toSorted()).toEqual(["desk", "eng-1", "rev-1", "user"]);
    const desk = members.find((m) => m.name === "desk");
    expect(desk).toMatchObject({ role: "concierge", resident: true, memberships: [] });
    expect(desk?.profile).toContain("# Profile");
    const eng = members.find((m) => m.name === "eng-1");
    expect(eng).toMatchObject({ memberships: ["demo"], claimsHeld: 0, tasksDone: 0 });
    const demoTask = await board.createTask(USER, { project: "demo", title: "d" });
    await board.claimTask(ENG, { task_id: demoTask.id });
    expect((await board.listMembers()).find((m) => m.name === "eng-1")?.claimsHeld).toBe(1);
    await board.advanceTask(ENG, { task_id: demoTask.id });
    const after = (await board.listMembers()).find((m) => m.name === "eng-1");
    expect(after).toMatchObject({ claimsHeld: 0, tasksDone: 1 });

    // The roster carries the configured model and the model the last turn reported.
    await board.addAgent(USER, { name: "eng-3", role: "engineer", cli: "codex", model: "gpt-5" });
    expect((await board.listMembers()).find((m) => m.name === "eng-3")).toMatchObject({
      model: "gpt-5",
    });
    const turn = {
      agent: "eng-1",
      project: "demo",
      runner: "server",
      cli: "claude" as const,
      session: "s",
      trigger: { kind: "manual" as const, fromUser: true, reason: "dev" },
      startedAt: "2026-09-28T10:05:00.000Z",
      endedAt: "2026-09-28T10:06:00.000Z",
      exitReason: "completed" as const,
      status: null,
      error: null,
      usage: null,
      costUsd: 0.2,
      toolCalls: 1,
      model: "claude-opus-5-5",
    };
    await board.beginTurn(turn);
    await board.finishTurn(turn);
    expect((await board.listMembers()).find((m) => m.name === "eng-1")).toMatchObject({
      lastModel: "claude-opus-5-5",
    });
    const completedEvent = (await board.readEvents(null)).findLast(
      (event) => event.type === "turn.completed",
    );
    expect(completedEvent?.payload["model"]).toBe("claude-opus-5-5");

    // Society-scope wakes are for roles that may work outside projects.
    await expect(
      board.requestWake(USER, { agent: "desk", project: "society", reason: "dev" }),
    ).resolves.toMatchObject({ type: "wake.requested" });
    await expect(
      board.requestWake(USER, { agent: "eng-1", project: "society", reason: "dev" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // Turn tokens can be extended for a resident session and revoked when it closes.
    const token = board.issueTurnToken("desk", "concierge", 1_000);
    expect(board.extendTurnToken(token, 60_000)).toBe(true);
    clock = new Date(clock.getTime() + 30_000);
    expect(board.resolveToken(token)).toEqual(DESK);
    board.revokeTurnToken(token);
    expect(board.resolveToken(token)).toBeNull();
  });

  it("shares knowledge and skills: write_knowledge, skill promotion, and search over the archive", async () => {
    const { board } = await society();
    await board.addAgent(USER, { name: "stew", role: "steward", cli: "claude" });
    const STEW: Actor = { name: "stew", role: "steward" };

    // Project knowledge needs membership; society knowledge needs the steward or the user.
    const written = await board.writeKnowledge(ENG, {
      project: "demo",
      topic: "testing",
      body: "Run `uv run pytest -q`; fixtures live under tests/fixtures.",
    });
    expect(written).toMatchObject({ project: "demo", topic: "testing", updatedBy: "eng-1" });
    await expect(
      board.writeKnowledge(ENG, { project: null, topic: "norms", body: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await board.addProject(USER, { slug: "other" });
    await expect(
      board.writeKnowledge(ENG, { project: "other", topic: "t", body: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await board.writeKnowledge(STEW, {
      project: null,
      topic: "norms",
      body: "Summaries close threads. Silence is allowed.",
    });
    expect(await board.readSocietyNorms()).toContain("Silence is allowed");
    expect((await board.listKnowledge("demo")).map((k) => k.topic)).toEqual(["testing"]);
    expect((await board.listChannel("demo/general")).at(-1)?.body).toContain(
      "Knowledge written: testing",
    );
    await board.writeKnowledge(ENG, {
      project: "demo",
      topic: "testing",
      body: "Run `uv run pytest -q` (updated).",
    });
    expect((await board.listKnowledge("demo"))[0]?.body).toContain("(updated)");
    expect((await board.listChannel("demo/general")).at(-1)?.body).toContain("Knowledge updated");

    // A citizen's own skill and archive are searchable by that citizen only, and the roster lists its skills.
    await mkdir(board.paths.agentSkill("eng-1", "uv-setup"), { recursive: true });
    await writeFile(
      board.paths.agentSkillFile("eng-1", "uv-setup"),
      "---\nname: uv-setup\ndescription: Set up a uv project with locked dependencies\n---\n# uv setup\n\nRun uv sync --locked before the tests.\n",
      "utf8",
    );
    await writeFile(
      path.join(board.paths.agentMemory("eng-1"), "python.md"),
      "# Python\n\nThe user prefers ruff over black.\n",
      "utf8",
    );
    expect((await board.search(ENG, { query: "ruff" })).map((h) => [h.kind, h.ref])).toEqual([
      ["memory", "memory/python.md"],
    ]);
    expect(await board.search(REV, { query: "ruff" })).toEqual([]);
    expect((await board.search(ENG, { query: "locked" })).map((h) => h.ref)).toEqual([
      "skills/uv-setup",
    ]);
    expect((await board.listAgentSkills("eng-1")).map((s) => [s.name, s.summary])).toEqual([
      ["uv-setup", "Set up a uv project with locked dependencies"],
    ]);
    const turn = {
      agent: "eng-1",
      project: "demo",
      runner: "server",
      cli: "claude" as const,
      session: "s",
      trigger: { kind: "reflection" as const, fromUser: false, reason: "scheduled" },
      startedAt: "2026-09-28T10:05:00.000Z",
      endedAt: "2026-09-28T10:06:00.000Z",
      exitReason: "completed" as const,
      status: null,
      error: null,
      usage: null,
      costUsd: 0,
      toolCalls: 0,
      model: null,
    };
    await board.beginTurn(turn);
    await board.finishTurn(turn);
    expect((await board.listMembers()).find((m) => m.name === "eng-1")?.skills).toEqual([
      "uv-setup",
    ]);

    // Promotion: a skill proposal the steward approves lands under the society's skills, for everyone.
    const proposal = await board.propose(ENG, {
      kind: "skill",
      charter: {
        name: "uv-setup",
        summary: "Set up a uv project with locked dependencies",
        body: "Run uv sync --locked before the tests.",
      },
      rationale: "Every Python project here needs it.",
    });
    await board.approve(STEW, { proposal_id: proposal.id });
    expect((await board.readProposal(proposal.id)).status).toBe("provisioned");
    expect((await board.listSocietySkills()).map((s) => [s.name, s.scope])).toEqual([
      ["uv-setup", "society"],
    ]);
    // The announcement posts quote the summary, so search for a phrase only the body carries.
    expect((await board.search(REV, { query: "uv sync" })).map((h) => h.ref)).toEqual([
      "society/skills/uv-setup",
    ]);
    expect((await board.listChannel("general")).at(-1)?.body).toContain("Skill uv-setup promoted");

    // A reflection can be requested ahead of the cadence.
    const wake = await board.requestWake(USER, {
      agent: "eng-1",
      project: "demo",
      reason: "reflect now",
      kind: "reflection",
    });
    expect(wake.payload["kind"]).toBe("reflection");
  });

  it("resolves a relative data directory, so worktree and home paths never depend on a cwd", async () => {
    const relative = path.relative(process.cwd(), dir);
    expect(path.isAbsolute(relative)).toBe(false);
    const { board } = await Board.init(relative, { name: "relative" });
    expect(board.paths.dataDir).toBe(dir);
    expect((await board.listRoles()).map((role) => role.name).toSorted()).toEqual([
      "concierge",
      "steward",
      "user",
    ]);
    expect(path.isAbsolute(board.paths.worktree("eng-1", "demo"))).toBe(true);
    expect(board.paths.repo("demo")).toBe(path.join(dir, "repos", "demo"));
    expect((await Board.open(relative)).paths.agent("eng-1")).toBe(
      path.join(dir, "agents", "eng-1"),
    );
  });
});
