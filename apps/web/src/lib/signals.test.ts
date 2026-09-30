import { describe, expect, it } from "vitest";
import type { SignalRecord } from "./api.js";
import { holdingNow, signalFacts, wakesReaders } from "./signals.js";

function record(id: string, key: string): SignalRecord {
  return {
    id,
    ts: "2026-09-30T06:00:00.000Z",
    signal: { kind: "role_gap", key, summary: "s", value: 1 },
  };
}

describe("the operations log", () => {
  it("marks only the newest entry of each condition that still holds", () => {
    const records = [
      record("01M3S00000000000000000000A", "role_gap:lab:referee"),
      record("01M3S00000000000000000000B", "backlog:lab:researcher"),
      record("01M3S00000000000000000000C", "role_gap:lab:referee"),
    ];
    expect(holdingNow(records, ["role_gap:lab:referee"])).toEqual(
      new Set(["01M3S00000000000000000000C"]),
    );
    expect(holdingNow(records, [])).toEqual(new Set());
  });

  it("says which kinds wake the steward and what a signal concerns, without its numbers", () => {
    expect(wakesReaders("role_gap")).toBe(true);
    expect(wakesReaders("runner")).toBe(false);
    expect(wakesReaders("turn_cost")).toBe(false);
    expect(
      signalFacts({
        kind: "backlog",
        key: "backlog:lab:researcher",
        summary: "s",
        value: 4,
        threshold: 3,
        project: "lab",
        role: "researcher",
      }),
    ).toEqual(["lab", "role researcher", "wakes the steward"]);
    expect(signalFacts({ kind: "runner", key: "runner:server", summary: "s", value: 1 })).toEqual(
      [],
    );
  });
});
