import { MemberSchema, type TurnHistoryEntry } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import {
  endingOf,
  historyTotals,
  runnersOf,
  tokensDetail,
  tokensLabel,
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
  it("offers a citizen's projects, and the society outside them, whatever its charter", () => {
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
    expect(wakeScopes(member)).toEqual(["lab", "society"]);
    expect(wakeScopes({ ...member, memberships: [] })).toEqual(["society"]);
  });

  it("reads a finished turn's length and ending", () => {
    expect(turnLength(entry())).toBeNull();
    expect(turnLength(entry({ startedAt: "2026-09-29T10:00:00.000Z" }))).toBe("3m");
    expect(endingOf(entry({ exitReason: "timeout" }))).toBe("timed out");
    expect(endingOf(entry({ exitReason: null, outcome: "failed" }))).toBe("failed");
    expect(endingOf(entry({ exitReason: "stopped" }))).toBe("stopped by you");
  });

  it("totals a history, with the tokens of the turns that recorded them", () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 400,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 2_000,
    };
    expect(
      historyTotals([
        entry({ usage }),
        entry({ exitReason: "error", outcome: "failed", usage }),
        // A stop is the user's decision, not a failure; and a turn from before tokens has none.
        entry({ exitReason: "stopped" }),
      ]),
    ).toEqual({
      turns: 3,
      failed: 1,
      usage: {
        inputTokens: 20,
        outputTokens: 800,
        cacheReadTokens: 100_000,
        cacheWriteTokens: 4_000,
      },
      withUsage: 2,
    });
    expect(historyTotals([entry()])).toMatchObject({ usage: null, withUsage: 0 });
  });

  it("counts a turn's whole input, cached or not, and says how it splits", () => {
    const usage = {
      inputTokens: 5_313,
      outputTokens: 1_540,
      cacheReadTokens: 146_048,
      cacheWriteTokens: 0,
    };
    expect(tokensLabel(usage)).toBe("151K in · 1.5K out");
    expect(tokensLabel({ ...usage, inputTokens: 12, cacheReadTokens: 0, outputTokens: 940 })).toBe(
      "12 in · 940 out",
    );
    expect(tokensLabel({ ...usage, cacheReadTokens: 1_234_567 })).toBe("1.2M in · 1.5K out");
    expect(tokensDetail(usage)).toBe(
      "151,361 input tokens: 146,048 read from the cache, 0 written to it, 5,313 neither; 1,540 output tokens",
    );
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
