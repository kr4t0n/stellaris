import type { Member, RoleCharter } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { wakesFor } from "./wakes.js";

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

describe("wakes", () => {
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
  });

  it("wakes nobody for a name in code, as the board decides it", () => {
    const members = [member("desk", "concierge"), member("ada", "researcher")];
    const roles = [charter("concierge", ["user_post"]), charter("researcher", ["heartbeat"])];
    expect(wakesFor("Run `@ada --fix`:\n\n```\n@ada\n```", members, roles)).toEqual(["desk"]);
    expect(wakesFor("Log:\n\n~~~\n@ada\n\nstill code, @ada", members, roles)).toEqual(["desk"]);
    expect(wakesFor("`@ada` means you, @ada", members, roles)).toEqual(["desk", "ada"]);
    // Indentation alone makes code, so the form reads the text as it is sent.
    expect(wakesFor("    @ada please run it", members, roles)).toEqual(["desk"]);
    expect(wakesFor("@ada please run it", members, roles)).toEqual(["desk", "ada"]);
  });
});
