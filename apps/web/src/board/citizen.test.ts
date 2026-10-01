import { MemberSchema, RoleCharterSchema, type TurnHistoryEntry } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import {
  costLabel,
  endingOf,
  historyTotals,
  runnersOf,
  turnLength,
  wakeScopes,
  withoutTitle,
} from "./citizen.js";

function entry(overrides: Partial<TurnHistoryEntry> = {}): TurnHistoryEntry {
  return {
    id: "01M3Q2CCCCCCCCCCCCCCCCCCC1",
    ts: "2026-09-29T10:03:20.000Z",
    outcome: "completed",
    project: "lab",
    trigger: "stage",
    exitReason: "completed",
    costUsd: 0.42,
    model: "claude-opus-5-5",
    summary: "done",
    error: null,
    ...overrides,
  };
}

describe("citizen", () => {
  it("offers a citizen's projects, and the society only when its charter allows it", () => {
    const member = {
      ...MemberSchema.parse({
        name: "desk",
        role: "concierge",
        cli: "claude",
        homeRunner: "server",
        status: "active",
        memberships: ["lab"],
        subscriptions: [],
        createdAt: "2026-09-29T08:00:00.000Z",
      }),
      profile: "",
    };
    const charter = RoleCharterSchema.parse({ name: "concierge", purpose: "p", verbs: [] });
    expect(wakeScopes(member, charter)).toEqual(["lab"]);
    expect(wakeScopes(member, { ...charter, societyScope: true })).toEqual(["lab", "society"]);
  });

  it("reads a finished turn's length, ending, and cost", () => {
    expect(turnLength(entry())).toBeNull();
    expect(turnLength(entry({ startedAt: "2026-09-29T10:00:00.000Z" }))).toBe("3m");
    expect(endingOf(entry({ exitReason: "timeout" }))).toBe("timed out");
    expect(endingOf(entry({ exitReason: null, outcome: "failed" }))).toBe("failed");
    expect(costLabel(entry(), "claude")).toBe("$0.42");
    expect(costLabel(entry({ costUsd: 0 }), "codex")).toBe("unmetered");
  });

  it("totals a history", () => {
    expect(
      historyTotals([entry(), entry({ exitReason: "error", outcome: "failed", costUsd: 0.1 })]),
    ).toEqual({ turns: 2, failed: 1, costUsd: 0.52 });
  });

  it("drops a leading heading that repeats the section's title", () => {
    expect(withoutTitle("# Core memory\n\n- one", "Core memory")).toBe("- one");
    expect(withoutTitle("# Notes\n\n- one", "Core memory")).toBe("# Notes\n\n- one");
  });

  it("names the runners a citizen's turns run on, its pin and its projects' places", () => {
    const base = MemberSchema.parse({
      name: "sage",
      role: "researcher",
      cli: "claude",
      status: "active",
      memberships: ["model-research", "lab"],
      subscriptions: [],
      createdAt: "2026-10-01T12:48:00.000Z",
    });
    const sage = { ...base, profile: "" };
    // A project member that works outside no project has no pin, yet runs where its projects live.
    expect(runnersOf(sage, new Map([["model-research", "pod"]]))).toEqual({
      label: "on pod",
      detail: "model-research: pod; lab: placed on its first turn",
    });
    expect(
      runnersOf(
        { ...sage, homeRunner: "laptop" },
        new Map([
          ["model-research", "pod"],
          ["lab", "pod"],
        ]),
      ),
    ).toEqual({
      label: "on laptop, pod",
      detail: "outside projects: laptop; model-research: pod; lab: pod",
    });
    expect(runnersOf({ ...sage, memberships: [] }, new Map())).toEqual({
      label: "no runner yet",
      detail: "pinned to a runner on its first turn",
    });
  });
});
