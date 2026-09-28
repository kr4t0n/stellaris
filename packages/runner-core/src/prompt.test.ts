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
          from: "owner",
          fromOwner: true,
          reason: "mentioned by owner",
        }),
        priority: 2,
        onboarding: false,
      },
      messages: [
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          author: "owner",
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
      },
      onboarding: null,
    });
    expect(prompt).toContain("Trigger: mention from owner. mentioned by owner");
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
});
