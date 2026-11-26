import type { Member, PostPlace, RoleCharter } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { wakesFor as wakesForPost } from "./wakes.js";

// A new thread's first message, as the new-thread form sends it, on a project's channel and on the
// society's asks channel, where it is an ask.
const elsewhere: PostPlace = { channel: "lab/general", opensThread: true };
const ask: PostPlace = { channel: "asks", opensThread: true };
const wakesFor = (text: string, members: readonly Member[], roles: readonly RoleCharter[]) =>
  wakesForPost(text, members, roles, elsewhere);

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
  it("says whom a post wakes: every active citizen mentioned, else the front desk", () => {
    const members = [
      member("desk", "concierge"),
      member("ada", "researcher"),
      member("old", "researcher", { status: "retired" }),
      member("ghost", "researcher", { cli: null }),
      member("user", "user", { cli: null }),
    ];
    const roles = [
      charter("concierge", ["user_post", "heartbeat"]),
      charter("researcher", ["heartbeat"]),
    ];
    expect(wakesFor("hello", members, roles)).toEqual(["desk"]);
    expect(wakesFor("@ada and @old and @nobody", members, roles)).toEqual(["ada"]);
    // Naming the desk wakes it once.
    expect(wakesFor("@desk who takes this?", members, roles)).toEqual(["desk"]);
    expect(wakesFor("@desk and @ada", members, roles)).toEqual(["ada", "desk"]);
    // Names that wake nobody leave the post to the desk.
    const texts = ["@klin a look?", "@old a look?", "@ghost a look?", "@user note"];
    expect(texts.map((text) => [text, wakesFor(text, members, roles)])).toEqual(
      texts.map((text) => [text, ["desk"]]),
    );
  });

  it("wakes nobody for a name in code, as the board decides it", () => {
    const members = [member("desk", "concierge"), member("ada", "researcher")];
    const roles = [charter("concierge", ["user_post"]), charter("researcher", ["heartbeat"])];
    expect(wakesFor("Run `@ada --fix`:\n\n```\n@ada\n```", members, roles)).toEqual(["desk"]);
    expect(wakesFor("Log:\n\n~~~\n@ada\n\nstill code, @ada", members, roles)).toEqual(["desk"]);
    expect(wakesFor("`@ada` means you, @ada", members, roles)).toEqual(["ada"]);
    // Indentation alone makes code, so the form reads the text as it is sent.
    expect(wakesFor("    @ada please run it", members, roles)).toEqual(["desk"]);
    expect(wakesFor("@ada please run it", members, roles)).toEqual(["ada"]);
  });

  it("says an ask wakes the front desk whatever it names, and a reply in its thread does not", () => {
    const members = [
      member("desk", "concierge"),
      member("ada", "researcher"),
      member("old", "researcher", { status: "retired" }),
    ];
    const roles = [charter("concierge", ["user_post"]), charter("researcher", ["heartbeat"])];
    const cases: Array<[string, PostPlace]> = [
      ["@ada a look?", ask],
      ["@desk and @ada", ask],
      ["@desk who takes this?", ask],
      ["@old a look?", ask],
      ["hello", ask],
      ["@ada a look?", { channel: "asks", opensThread: false }],
      ["@ada a look?", { channel: "lab/asks", opensThread: true }],
      ["@ada a look?", elsewhere],
    ];
    expect(
      cases.map(([text, place]) => [text, place, wakesForPost(text, members, roles, place)]),
    ).toEqual([
      ["@ada a look?", ask, ["desk", "ada"]],
      ["@desk and @ada", ask, ["desk", "ada"]],
      ["@desk who takes this?", ask, ["desk"]],
      ["@old a look?", ask, ["desk"]],
      ["hello", ask, ["desk"]],
      ["@ada a look?", { channel: "asks", opensThread: false }, ["ada"]],
      ["@ada a look?", { channel: "lab/asks", opensThread: true }, ["ada"]],
      ["@ada a look?", elsewhere, ["ada"]],
    ]);
  });
});
