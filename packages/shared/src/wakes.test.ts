import { describe, expect, it } from "vitest";
import { userPostWakesDesk, type WakeableCitizen } from "./wakes.js";

const citizen = (name: string, extra: Partial<WakeableCitizen> = {}): WakeableCitizen => ({
  name,
  status: "active",
  cli: "claude",
  ...extra,
});

describe("userPostWakesDesk", () => {
  it("leaves a user post to a citizen it names who wakes, and to the desk otherwise", () => {
    expect(userPostWakesDesk("desk", [])).toBe(true);
    expect(userPostWakesDesk("desk", [citizen("ada")])).toBe(false);
    expect(userPostWakesDesk("desk", [citizen("desk"), citizen("ada")])).toBe(false);
    // The desk itself, the user, and a citizen who can't take a turn leave it to the desk.
    expect(userPostWakesDesk("desk", [citizen("desk")])).toBe(true);
    expect(userPostWakesDesk("desk", [citizen("user")])).toBe(true);
    expect(userPostWakesDesk("desk", [citizen("old", { status: "retired" })])).toBe(true);
    expect(userPostWakesDesk("desk", [citizen("ghost", { cli: null })])).toBe(true);
    // Another member of the front desk named is a citizen who wakes.
    expect(userPostWakesDesk("desk-2", [citizen("desk")])).toBe(false);
  });
});
