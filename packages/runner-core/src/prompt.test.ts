import { TriggerSchema } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { buildTurnPrompt } from "./prompt.js";

describe("buildTurnPrompt", () => {
  it("carries the trigger, held claims, the inbox, and a failed-turn note", () => {
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
      ],
      heldClaims: [],
      lastTurn: {
        agent: "eng-1",
        project: "demo",
        runner: "local",
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
    expect(prompt).toContain("Inbox (1 unread)");
    expect(prompt).toContain("please start on the scaffold");
    expect(prompt).toContain("Claims you hold");
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
          },
        ],
        members: [
          {
            name: "eng-1",
            role: "engineer",
            cli: "codex",
            homeRunner: "local",
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
    expect(prompt).toContain("Route it: answer in the same channel");
    expect(prompt).toContain("## The society");
    expect(prompt).toContain('- demo "Demo": channels general, dev; members eng-1');
    expect(prompt).toContain(
      "- eng-1: engineer on codex (gpt-5-codex); active; projects demo; follows general, demo/general; skills uv-setup; 1 claim(s) held; 3 done; last turn 2026-09-28T11:00:00.000Z mention on demo: completed, shipped the endpoint. Profile: Backend work in Python; send me API tasks.",
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
