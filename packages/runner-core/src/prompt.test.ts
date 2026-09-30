import { TaskFrontmatterSchema, TriggerSchema } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { buildTurnPrompt } from "./prompt.js";

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
    expect(prompt).toContain("## Stages you hold\n\nNone.");
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
            members: ["eng-1"],
            approvers: ["user"],
            requiredCapabilities: [],
            createdAt: "2026-09-28T10:00:00.000Z",
            defaultPlan: [
              { name: "build", role: "engineer", gate: false },
              { name: "review", role: "reviewer", gate: true },
            ],
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
    expect(prompt).toContain(
      '- demo "Demo": channels general, dev; members eng-1; on done merge; default plan build (engineer), review (gate, reviewer)',
    );
    expect(prompt).toContain(
      "- eng-1: engineer on codex (gpt-5-codex); active; projects demo; follows general, demo/general; skills uv-setup; 1 claim(s) held; 3 done; last turn 2026-09-28T11:00:00.000Z mention on demo: completed, shipped the endpoint. Profile: Backend work in Python; send me API tasks.",
    );
  });

  it("shows the stages an agent holds and the ones waiting for it, each with the rest of its plan", () => {
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
    const prompt = buildTurnPrompt({
      dispatch: {
        agent: "res-1",
        project: "lab",
        trigger: TriggerSchema.parse({
          kind: "stage",
          from: "desk",
          reason:
            'stage "experiment" of task 01ARZ3NDEKTSV4RRFFQ69G5FAV "Churn model" is waiting for you',
          taskId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        }),
        priority: 1,
        onboarding: false,
      },
      messages: [],
      heldClaims: [task("01ARZ3NDEKTSV4RRFFQ69G5FAW", "Pricing", "s2", "res-1")],
      waitingStages: [task("01ARZ3NDEKTSV4RRFFQ69G5FAV", "Churn model", "s1")],
      project: {
        slug: "lab",
        name: "Lab",
        repo: null,
        defaultBranch: "main",
        channels: ["general"],
        members: ["res-1"],
        approvers: ["user"],
        requiredCapabilities: [],
        createdAt: ts,
        defaultPlan: [],
        onDone: "merge",
      },
      lastTurn: null,
      onboarding: null,
    });
    expect(prompt).toContain("A stage is waiting for you: claim it with claim_task");
    expect(prompt).toContain("Never merge or fast-forward main yourself.");
    expect(prompt).toContain(
      '- 01ARZ3NDEKTSV4RRFFQ69G5FAW "Pricing": write-up (yours, 2 of 3); next: referee review (gate, editor); lease until 2026-09-29T10:00:00.000Z',
    );
    expect(prompt).toContain(
      '## Stages waiting for you\n\n- 01ARZ3NDEKTSV4RRFFQ69G5FAV "Churn model": experiment (open to researcher, 1 of 3); next: write-up (researcher), referee review (gate, editor)',
    );
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
    });
    expect(prompt).toContain("Trigger: ops_event from board. demo: 4 open");
    expect(prompt).toContain("Operations signals arrived");
    expect(prompt).toContain("propose");
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
});
