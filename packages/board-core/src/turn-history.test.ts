import type { BoardEvent } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { tokenUse } from "./turn-history.js";

const NOW = new Date("2026-10-13T12:00:00.000Z");

let sequence = 0;
function event(ts: string, type: BoardEvent["type"], actor: string, payload: object): BoardEvent {
  sequence += 1;
  return {
    id: `01M4T${String(sequence).padStart(21, "0")}`,
    ts: `2026-${ts}.000Z`,
    type,
    actor,
    payload: { ...payload },
  };
}

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

function ended(
  ts: string,
  agent: string,
  counted: ReturnType<typeof usage> | null,
  type: "turn.completed" | "turn.failed" = "turn.completed",
): BoardEvent {
  return event(ts, type, agent, {
    project: "lab",
    trigger: "mention",
    ...(counted === null ? {} : { usage: counted }),
  });
}

describe("tokenUse", () => {
  const events = [
    // Logged before turns counted tokens, more than a week ago.
    ended("10-01T09:00:00", "ada", null),
    ended("10-07T09:00:00", "ada", usage(10, 1, 100, 5)),
    // A turn whose runner went away before it reported: no count, though it ran.
    ended("10-12T13:00:00", "ada", null, "turn.failed"),
    ended("10-13T08:00:00", "ada", usage(20, 2, 200, 10)),
    ended("10-13T11:00:00", "ada", usage(30, 3), "turn.failed"),
    ended("10-12T11:59:59", "bo", usage(1_000, 50)),
    // Exactly a day before now: the window's start, which counts.
    ended("10-12T12:00:00", "bo", usage(2_000, 60)),
    ended("10-13T10:00:00", "cy", null),
    // An older usage without the cache counts, which read as none.
    event("10-13T10:30:00", "turn.completed", "cy", {
      project: "lab",
      usage: { inputTokens: 7, outputTokens: 1 },
    }),
    // Neither a turn's start nor a malformed end is a finished turn the history lists.
    event("10-13T11:00:00", "turn.started", "ada", { project: "lab", trigger: "mention" }),
    event("10-13T11:30:00", "turn.completed", "ada", { usage: usage(5, 5) }),
    event("10-13T11:40:00", "message.posted", "ada", { channel: "general", mentions: [] }),
  ];

  it("sums each citizen's counted tokens over the last day, and counts the turns with none apart", () => {
    expect(tokenUse(events, "24h", NOW)).toEqual({
      window: "24h",
      since: "2026-10-12T12:00:00.000Z",
      until: "2026-10-13T12:00:00.000Z",
      citizens: [
        { agent: "ada", turns: 3, withUsage: 2, usage: usage(50, 5, 200, 10) },
        { agent: "bo", turns: 1, withUsage: 1, usage: usage(2_000, 60) },
        { agent: "cy", turns: 2, withUsage: 1, usage: usage(7, 1) },
      ],
    });
  });

  it("reaches back a week, or over the whole log", () => {
    expect(tokenUse(events, "7d", NOW).citizens[0]).toEqual({
      agent: "ada",
      turns: 4,
      withUsage: 3,
      usage: usage(60, 6, 300, 15),
    });
    const all = tokenUse(events, "all", NOW);
    expect(all.since).toBeNull();
    expect(all.citizens).toEqual([
      { agent: "ada", turns: 5, withUsage: 3, usage: usage(60, 6, 300, 15) },
      { agent: "bo", turns: 2, withUsage: 2, usage: usage(3_000, 110) },
      { agent: "cy", turns: 2, withUsage: 1, usage: usage(7, 1) },
    ]);
  });

  it("leaves tokens unknown, not zero, when no turn in the window counted them", () => {
    const old = [ended("10-13T09:00:00", "ada", null), ended("10-13T10:00:00", "ada", null)];
    expect(tokenUse(old, "24h", NOW).citizens).toEqual([
      { agent: "ada", turns: 2, withUsage: 0, usage: null },
    ]);
    expect(tokenUse([], "24h", NOW).citizens).toEqual([]);
  });
});
