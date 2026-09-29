import type { Member, RoleCharter } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { completeMention, listed, mentionAt, wakesFor } from "./compose.js";

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
});
