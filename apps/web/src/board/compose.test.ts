import type { Member, RoleCharter, RunningTurn } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { completeMention, listed, mentionAt, reachedTurns, wakeLine, wakesFor } from "./compose.js";

function member(name: string, role: string, extra: Partial<Member> = {}): Member {
  return {
    name,
    role,
    cli: "claude",
    homeRunner: "server",
    status: "active",
    resident: false,
    skills: [],
    memberships: [],
    subscriptions: [],
    claimsHeld: 0,
    tasksDone: 0,
    createdAt: "2026-09-29T10:00:00.000Z",
    profile: "",
    ...extra,
  };
}

function charter(name: string, wakeTriggers: RoleCharter["wakeTriggers"]): RoleCharter {
  return {
    name,
    purpose: name,
    verbs: [],
    wakeTriggers,
    maxReplicas: 1,
    backlogThreshold: 3,
    societyScope: false,
    resident: false,
    reflects: true,
  };
}

function turn(extra: Partial<RunningTurn>): RunningTurn {
  return {
    turnId: "01M3Q2TTTTTTTTTTTTTTTTTTT1",
    agent: "ada",
    scope: "lab",
    cli: "claude",
    steerable: true,
    stoppable: true,
    ...extra,
  };
}

describe("composing", () => {
  it("finds the mention being typed and completes it", () => {
    expect(mentionAt("hey @ad", 7)).toEqual({ start: 4, prefix: "ad" });
    expect(mentionAt("hey @", 5)).toEqual({ start: 4, prefix: "" });
    expect(mentionAt("mail a@b", 8)).toBeNull();
    expect(mentionAt("hey ada", 7)).toBeNull();
    expect(completeMention("hey @ad, look", 7, 4, "ada")).toEqual({
      text: "hey @ada , look",
      caret: 9,
    });
  });

  it("says whom a post wakes: the front desk, and every active citizen mentioned", () => {
    const members = [
      member("desk", "concierge"),
      member("ada", "researcher"),
      member("old", "researcher", { status: "retired" }),
      member("user", "user", { cli: null }),
    ];
    const roles = [
      charter("concierge", ["user_post", "heartbeat"]),
      charter("researcher", ["heartbeat"]),
    ];
    expect(wakesFor("hello", members, roles)).toEqual(["desk"]);
    expect(wakesFor("@ada and @old and @nobody", members, roles)).toEqual(["desk", "ada"]);
    expect(listed(["desk", "ada"])).toBe("desk and ada");
  });

  it("names whom a post reaches in a turn under way in its conversation, and whom it wakes", () => {
    const members = [
      member("ada", "researcher", { memberships: ["lab"] }),
      member("ref", "referee", { memberships: ["lab"] }),
      member("desk", "concierge"),
    ];
    const turns = [
      turn({}),
      turn({ agent: "ref", thread: "01M3Q2HHHHHHHHHHHHHHHHHHH1" }),
      turn({ agent: "desk", scope: "society", steerable: false }),
    ];
    // ada's home turn in lab takes a post in lab's channels; ref's turn is a thread's.
    expect(
      reachedTurns(["ada", "ref", "desk"], members, turns, { channel: "lab/general" }),
    ).toEqual(["ada"]);
    // A society channel wakes ada in the society scope, where she has no turn.
    expect(reachedTurns(["ada"], members, turns, { channel: "general" })).toEqual([]);
    expect(
      reachedTurns(["ada", "ref"], members, turns, { thread: "01M3Q2HHHHHHHHHHHHHHHHHHH1" }),
    ).toEqual(["ref"]);
    // desk's runner cannot steer: its post waits for a turn of its own.
    expect(reachedTurns(["desk"], members, turns, { channel: "general" })).toEqual([]);

    expect(wakeLine(["ada"], ["desk"])).toBe(
      "Sending reaches ada in the turn under way and wakes desk: a turn each.",
    );
    expect(wakeLine(["ada"], [])).toBe("Sending reaches ada in the turn under way.");
    expect(wakeLine([], ["desk"])).toBe("Sending wakes desk: a turn each.");
    expect(wakeLine([], [])).toBeNull();
  });
});
