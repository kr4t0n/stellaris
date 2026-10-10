import { TaskFrontmatterSchema, TriggerSchema } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { buildTurnPrompt } from "./prompt.js";

/** A project as the board lists it, placed on a runner or not yet. */
function listedProject(slug: string, runner?: string) {
  return {
    slug,
    name: slug,
    repo: null,
    defaultBranch: "main",
    channels: ["general"],
    archivedChannels: [],
    members: [],
    approvers: [],
    requiredCapabilities: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    onDone: "none" as const,
    ...(runner === undefined ? {} : { runner }),
  };
}

describe("buildTurnPrompt", () => {
  it("carries the trigger, held claims, unread messages with thread titles, and a failed-turn note", () => {
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "eng-1",
        project: "demo",
        trigger: TriggerSchema.parse({
          kind: "mention",
          from: "user",
          fromUser: true,
          reason: "mentioned by user",
        }),
        priority: 2,
        onboarding: false,
      },
      messages: [
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          author: "user",
          channel: "demo/general",
          ts: "2026-09-28T10:00:00.000Z",
          mentions: ["eng-1"],
          body: "@eng-1 please start on the scaffold",
        },
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          author: "rev-1",
          channel: "demo/dev",
          thread: "01ARZ3NDEKTSV4RRFFQ69G5FAT",
          ts: "2026-09-28T10:01:00.000Z",
          mentions: [],
          body: "vitest, I think",
        },
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          author: "rev-1",
          channel: "demo/general",
          thread: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
          step: { action: "returned", stage: "s2", to: "s1" },
          ts: "2026-09-28T10:02:00.000Z",
          mentions: [],
          body: "Add a second line.",
        },
      ],
      threads: new Map([
        [
          "01ARZ3NDEKTSV4RRFFQ69G5FAT",
          {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAT",
            channel: "demo/dev",
            title: "Which runner?",
            state: "open",
            openedBy: "eng-1",
            openedAt: "2026-09-28T09:59:00.000Z",
            body: "",
          },
        ],
      ]),
      heldClaims: [],
      lastTurn: {
        agent: "eng-1",
        project: "demo",
        runner: "server",
        cli: "claude",
        session: "s",
        trigger: TriggerSchema.parse({ kind: "heartbeat" }),
        startedAt: "2026-09-28T09:00:00.000Z",
        endedAt: "2026-09-28T09:01:00.000Z",
        exitReason: "timeout",
        status: null,
        error: null,
        usage: null,
        costUsd: 0,
        toolCalls: 3,
        model: null,
      },
      onboarding: null,
    });
    expect(prompt).toContain("Trigger: mention from user. mentioned by user");
    expect(prompt).toContain("Your previous turn did not finish");
    expect(prompt).toContain("## Unread messages (3)");
    expect(prompt).toContain(
      'demo/dev thread "Which runner?" (01ARZ3NDEKTSV4RRFFQ69G5FAT) from @rev-1 (message',
    );
    // A task verb's note says what the step did.
    expect(prompt).toContain(
      "thread 01ARZ3NDEKTSV4RRFFQ69G5FAY from @rev-1, who sent the task back from s2 to s1 (message",
    );
    expect(prompt).toContain("please start on the scaffold");
    // A home turn names its conversation and carries no stages: those are their tasks' business.
    expect(prompt).toContain("This turn is in your home conversation for demo");
    expect(prompt).not.toContain("Stages you hold");
    expect(prompt).not.toContain("Stages waiting for you");
    expect(prompt).not.toContain("First turn");
  });

  it("adds the onboarding preamble on a first turn", () => {
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "eng-1",
        project: "demo",
        trigger: TriggerSchema.parse({ kind: "onboarding", reason: "joined" }),
        priority: 1,
        onboarding: true,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: {
        agentName: "eng-1",
        roleSummary: "Builds things.",
        project: "demo",
        worktree: "/tmp/wt",
      },
    });
    expect(prompt).toContain("This is your first turn as eng-1");
    expect(prompt).toContain("Nothing new.");
  });

  it("gives the front desk the roster and the project list, and frames a user post as routing", () => {
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "desk",
        project: "society",
        trigger: TriggerSchema.parse({
          kind: "user_post",
          from: "user",
          fromUser: true,
          reason: "the user posted in general",
        }),
        priority: 2,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      societyView: {
        projects: [
          {
            slug: "demo",
            name: "Demo",
            repo: null,
            defaultBranch: "main",
            channels: ["general", "dev"],
            archivedChannels: [],
            members: ["eng-1"],
            approvers: ["user"],
            requiredCapabilities: [],
            createdAt: "2026-09-28T10:00:00.000Z",
            onDone: "merge",
          },
        ],
        members: [
          {
            name: "eng-1",
            role: "engineer",
            cli: "codex",
            homeRunner: "server",
            status: "active",
            resident: false,
            skills: ["uv-setup"],
            memberships: ["demo"],
            subscriptions: ["general", "demo/general"],
            lastModel: "gpt-5-codex",
            claimsHeld: 1,
            tasksDone: 3,
            lastTurnAt: "2026-09-28T11:00:00.000Z",
            lastTurnOutcome: "mention on demo: completed, shipped the endpoint",
            createdAt: "2026-09-28T10:00:00.000Z",
            profile: "# Profile\n\nBackend work in Python; send me API tasks.\n",
          },
        ],
      },
    });
    expect(prompt).toContain("Trigger: user_post from user. the user posted in general");
    expect(prompt).toContain(
      "Route it: answer where it was posted, in its thread when it came in one",
    );
    expect(prompt).toContain("## The society");
    // Asks run side by side, so the front desk looks for proposals another ask already made.
    expect(prompt).toContain(
      "look at the proposals still waiting under {{stellaris:board}}/society/proposals/",
    );
    expect(prompt).toContain('- demo "Demo": channels general, dev; members eng-1; on done merge');
    expect(prompt).toContain(
      "- eng-1: engineer on codex (gpt-5-codex); active; projects demo; follows general, demo/general; skills uv-setup; 1 claim(s) held; 3 done; last turn 2026-09-28T11:00:00.000Z mention on demo: completed, shipped the endpoint. Profile: Backend work in Python; send me API tasks.",
    );
  });

  it("gives a task's conversation its task, and the stage held or waiting with the rest of its plan", () => {
    const ts = "2026-09-29T10:00:00.000Z";
    const task = (id: string, title: string, stage: string, claimedBy?: string) => ({
      ...TaskFrontmatterSchema.parse({
        id,
        project: "lab",
        title,
        status: claimedBy === undefined ? "open" : "claimed",
        createdBy: "desk",
        createdAt: ts,
        updatedAt: ts,
        ...(claimedBy === undefined ? {} : { claimedBy, leaseExpiresAt: ts }),
        blockedBy: [],
        requiredCapabilities: [],
        stages: [
          { id: "s1", name: "experiment", role: "researcher" },
          { id: "s2", name: "write-up", role: "researcher" },
          { id: "s3", name: "referee review", role: "editor", gate: true },
        ],
        stage,
        stageSince: ts,
        stageSeq: 3,
        onDone: "merge",
      }),
      body: "",
    });
    const project = {
      slug: "lab",
      name: "Lab",
      repo: null,
      defaultBranch: "main",
      channels: ["general"],
      archivedChannels: [],
      members: ["res-1"],
      approvers: ["user"],
      requiredCapabilities: [],
      createdAt: ts,
      onDone: "merge" as const,
    };
    const threadOf = (id: string, title: string) => ({
      id,
      channel: "lab/general",
      title,
      subject: { kind: "task" as const, id },
      state: "open" as const,
      openedBy: "desk",
      openedAt: ts,
      body: "",
    });
    const churn = task("01ARZ3NDEKTSV4RRFFQ69G5FAV", "Churn model", "s1");
    const waiting = buildTurnPrompt({
      dispatch: {
        agent: "res-1",
        project: "lab",
        thread: { id: churn.id, task: true },
        trigger: TriggerSchema.parse({
          kind: "stage",
          from: "desk",
          reason:
            'stage "experiment" of task 01ARZ3NDEKTSV4RRFFQ69G5FAV "Churn model" is waiting for you',
          taskId: churn.id,
        }),
        priority: 1,
        onboarding: false,
      },
      messages: [],
      conversation: { thread: threadOf(churn.id, churn.title), task: churn, fresh: true },
      heldClaims: [],
      waitingStages: [churn],
      project,
      lastTurn: null,
      onboarding: null,
    });
    expect(waiting).toContain("A stage is waiting for you: claim it with claim_task");
    expect(waiting).toContain("Never merge or fast-forward main yourself.");
    expect(waiting).toContain(
      `This turn is in the thread "Churn model" on lab/general, about task ${churn.id}.`,
    );
    expect(waiting).toContain(
      '## Stages waiting for you\n\n- 01ARZ3NDEKTSV4RRFFQ69G5FAV "Churn model": experiment (open to researcher, 1 of 3); next: write-up (researcher), referee review (gate, editor)',
    );
    expect(waiting).toContain("## Stages you hold\n\nNone.");
    // A new conversation is shown its thread so far, not only what is unread.
    expect(waiting).toContain("## The thread so far (0)");

    const pricing = task("01ARZ3NDEKTSV4RRFFQ69G5FAW", "Pricing", "s2", "res-1");
    const held = buildTurnPrompt({
      dispatch: {
        agent: "res-1",
        project: "lab",
        thread: { id: pricing.id, task: true },
        trigger: TriggerSchema.parse({ kind: "heartbeat", reason: "heartbeat" }),
        priority: 0,
        onboarding: false,
      },
      messages: [],
      conversation: { thread: threadOf(pricing.id, pricing.title), task: pricing, fresh: false },
      heldClaims: [pricing],
      project,
      lastTurn: null,
      onboarding: null,
    });
    expect(held).toContain(
      '- 01ARZ3NDEKTSV4RRFFQ69G5FAW "Pricing": write-up (yours, 2 of 3); next: referee review (gate, editor); lease until 2026-09-29T10:00:00.000Z',
    );
    expect(held).toContain("## Unread messages (0)");
  });

  it("frames a turn triggered by operations signals as a decision about proposing", () => {
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "stew-1",
        project: "demo",
        trigger: TriggerSchema.parse({
          kind: "ops_event",
          from: "board",
          reason: "demo: 4 open or claimed task(s) for 1 engineer(s)",
        }),
        priority: 0,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      signals: [
        {
          ts: "2026-09-30T06:00:00.000Z",
          signal: {
            kind: "backlog",
            key: "backlog:demo:engineer",
            summary: "demo: 4 open or claimed task(s) for 1 engineer(s)",
            value: 4,
            threshold: 3,
            project: "demo",
          },
        },
      ],
    });
    expect(prompt).toContain("Trigger: ops_event from board. demo: 4 open");
    expect(prompt).toContain(
      "Operations signals arrived; they are listed under Operations signals",
    );
    expect(prompt).toContain("propose");
    // The signals themselves are in the prompt, not in a channel's posts.
    expect(prompt).toContain(
      "- [2026-09-30T06:00:00.000Z] backlog: demo: 4 open or claimed task(s) for 1 engineer(s) (value 4, threshold 3; project demo)",
    );
    const none = buildTurnPrompt({
      dispatch: {
        agent: "stew-1",
        project: "demo",
        trigger: TriggerSchema.parse({ kind: "heartbeat" }),
        priority: 0,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      signals: [],
    });
    expect(none).toContain("## Operations signals\n\nNone since your last turn here.");
    // Roles that read no signals get no section at all.
    const reader = buildTurnPrompt({
      dispatch: {
        agent: "eng-1",
        project: "demo",
        trigger: TriggerSchema.parse({ kind: "heartbeat" }),
        priority: 0,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
    });
    expect(reader).not.toContain("## Operations signals");
  });

  it("shows a society role every runner, what it offers, and the projects living on it", () => {
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "desk",
        project: "society",
        trigger: TriggerSchema.parse({ kind: "user_post", fromUser: true }),
        priority: 2,
        onboarding: false,
      },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      societyView: { projects: [listedProject("lab", "pod"), listedProject("new")], members: [] },
      runners: {
        runners: [
          {
            name: "pod",
            os: "linux",
            clis: ["claude", "codex"],
            capabilities: [],
            status: "connected",
          },
          {
            name: "laptop",
            os: "darwin",
            clis: ["claude"],
            capabilities: ["gpu", "xcode"],
            status: "disconnected",
            lastSeen: "2026-10-01T09:00:00.000Z",
          },
        ],
        projects: [listedProject("lab", "pod"), listedProject("new")],
      },
    });
    expect(prompt).toContain("## Runners");
    expect(prompt).toContain(
      "required_capabilities must name capabilities exactly as a runner below offers them",
    );
    expect(prompt).toContain(
      "- pod: connected; linux; CLIs claude, codex; offers nothing beyond its CLIs; projects lab",
    );
    expect(prompt).toContain(
      "- laptop: away since 2026-10-01T09:00:00.000Z; darwin; CLIs claude; offers gpu, xcode; no projects",
    );
    // The front desk's project list says where each project lives.
    expect(prompt).toContain("on done none; on runner pod");
    expect(prompt).toContain("on done none; not placed on a runner yet");
  });

  it("tells a turn outside projects when it was asked from a project the citizen is not in", () => {
    const base = { messages: [], heldClaims: [], lastTurn: null, onboarding: null };
    const asked = (channel: string, project = "society"): string =>
      buildTurnPrompt({
        ...base,
        dispatch: {
          agent: "sage",
          project,
          trigger: TriggerSchema.parse({ kind: "mention", from: "user", channel }),
          priority: 2,
          onboarding: false,
        },
      });
    expect(asked("lab/general")).toContain(
      "You were asked in lab/general, in project lab, which you are not a member of",
    );
    expect(asked("lab/general")).toContain("join it with join_project");
    // Asked in a society channel, or in its own project, there is nothing to explain.
    expect(asked("general")).not.toContain("You were asked in");
    expect(asked("lab/general", "lab")).not.toContain("You were asked in");
  });

  it("frames a reflection turn as memory work and lists the scope's knowledge topics", () => {
    const dispatch = {
      agent: "eng-1",
      project: "demo",
      trigger: TriggerSchema.parse({ kind: "reflection", reason: "scheduled reflection" }),
      priority: 0,
      onboarding: false,
    };
    const empty = buildTurnPrompt({
      dispatch,
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      knowledge: { dir: "/data/board/projects/demo/knowledge", topics: [] },
    });
    expect(empty).toContain("## Reflection");
    expect(empty).toContain("take no new work");
    expect(empty).toContain("skills/<name>/SKILL.md");
    expect(empty).toContain("memoryUpdated: true");
    expect(empty).toContain("## Knowledge of demo\n\nNone yet.");

    const listed = buildTurnPrompt({
      dispatch: { ...dispatch, trigger: TriggerSchema.parse({ kind: "heartbeat" }) },
      messages: [],
      heldClaims: [],
      lastTurn: null,
      onboarding: null,
      knowledge: {
        dir: "/data/board/projects/demo/knowledge",
        topics: [
          {
            topic: "testing",
            project: "demo",
            updatedBy: "eng-1",
            updatedAt: "2026-09-28T10:00:00.000Z",
            body: "Run the tests with uv.",
          },
        ],
      },
    });
    expect(listed).not.toContain("## Reflection");
    expect(listed).toContain("Topics under /data/board/projects/demo/knowledge");
    expect(listed).toContain("- testing: updated by eng-1 at 2026-09-28T10:00:00.000Z");
    expect(listed).not.toContain("Run the tests with uv.");
  });

  it("makes reconciling a home's conflict copies the first step of a reflection", () => {
    const dispatch = {
      agent: "eng-1",
      project: "demo",
      trigger: TriggerSchema.parse({ kind: "reflection", reason: "scheduled reflection" }),
      priority: 0,
      onboarding: false,
    };
    const base = { messages: [], heldClaims: [], lastTurn: null, onboarding: null };
    const conflict = {
      path: "memory/core.md.conflict-0000ABCD",
      file: "memory/core.md",
      since: "2026-09-30T08:00:00.000Z",
    };
    expect(buildTurnPrompt({ ...base, dispatch })).not.toContain("Reconcile first");

    const reflection = buildTurnPrompt({ ...base, dispatch, conflicts: [conflict] });
    expect(reflection).toContain("then:\n- Reconcile first: merge each copy");
    expect(reflection.indexOf("Reconcile first")).toBeLessThan(reflection.indexOf("Consolidate"));
    expect(reflection).toContain(
      "- memory/core.md.conflict-0000ABCD, beside memory/core.md, since 2026-09-30T08:00:00.000Z",
    );

    // Any other turn lists the copies without the reflection's step.
    const heartbeat = buildTurnPrompt({
      ...base,
      dispatch: { ...dispatch, trigger: TriggerSchema.parse({ kind: "heartbeat" }) },
      conflicts: [conflict],
    });
    expect(heartbeat).toContain("## Edits to reconcile in your home");
    expect(heartbeat).not.toContain("Reconcile first");
  });
});
