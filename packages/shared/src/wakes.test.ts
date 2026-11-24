import { describe, expect, it } from "vitest";
import { isAsk, userPostWakesDesk, type PostPlace, type WakeableCitizen } from "./wakes.js";

const citizen = (name: string, extra: Partial<WakeableCitizen> = {}): WakeableCitizen => ({
  name,
  status: "active",
  cli: "claude",
  ...extra,
});

// A post at the top of a channel, a reply in an ask's thread, and an ask.
const channel: PostPlace = { channel: "demo/general", opensThread: false };
const reply: PostPlace = { channel: "asks", opensThread: false };
const ask: PostPlace = { channel: "asks", opensThread: true };

describe("userPostWakesDesk", () => {
  it("leaves a user post to a citizen it names who wakes, and to the desk otherwise", () => {
    expect(userPostWakesDesk("desk", [], channel)).toBe(true);
    expect(userPostWakesDesk("desk", [citizen("ada")], channel)).toBe(false);
    expect(userPostWakesDesk("desk", [citizen("desk"), citizen("ada")], channel)).toBe(false);
    // The desk itself, the user, and a citizen who can't take a turn leave it to the desk.
    expect(userPostWakesDesk("desk", [citizen("desk")], channel)).toBe(true);
    expect(userPostWakesDesk("desk", [citizen("user")], channel)).toBe(true);
    expect(userPostWakesDesk("desk", [citizen("old", { status: "retired" })], channel)).toBe(true);
    expect(userPostWakesDesk("desk", [citizen("ghost", { cli: null })], channel)).toBe(true);
    // Another member of the front desk named is a citizen who wakes.
    expect(userPostWakesDesk("desk-2", [citizen("desk")], channel)).toBe(false);
  });

  it("wakes the desk for an ask whatever it names, and for a reply in its thread as for any post", () => {
    expect(userPostWakesDesk("desk", [citizen("ada")], ask)).toBe(true);
    expect(userPostWakesDesk("desk", [citizen("desk"), citizen("ada")], ask)).toBe(true);
    expect(userPostWakesDesk("desk", [], ask)).toBe(true);
    expect(userPostWakesDesk("desk", [citizen("ada")], reply)).toBe(false);
    expect(userPostWakesDesk("desk", [], reply)).toBe(true);
  });
});

describe("isAsk", () => {
  it("takes the first message of a thread on the society's asks channel alone", () => {
    const places: PostPlace[] = [
      ask,
      reply,
      channel,
      { channel: "asks", opensThread: false },
      { channel: "general", opensThread: true },
      { channel: "demo/asks", opensThread: true },
      { channel: null, opensThread: true },
    ];
    expect(places.map((place) => [place, isAsk(place)])).toEqual(
      places.map((place, index) => [place, index === 0]),
    );
  });
});
