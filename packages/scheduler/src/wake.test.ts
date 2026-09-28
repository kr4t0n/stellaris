import { describe, expect, it } from "vitest";
import { decideWake } from "./index.js";

describe("decideWake", () => {
  it("never wakes while paused", () => {
    expect(
      decideWake({
        trigger: { kind: "mention", fromOwner: true },
        digestSize: 5,
        claimsHeld: 1,
        paused: true,
      }).wake,
    ).toBe(false);
  });

  it("gives owner mentions top priority", () => {
    const decision = decideWake({
      trigger: { kind: "mention", fromOwner: true },
      digestSize: 0,
      claimsHeld: 0,
      paused: false,
    });
    expect(decision).toEqual({ wake: true, reason: "owner mention", priority: 2 });
  });

  it("skips heartbeats with an empty digest and no claims", () => {
    expect(
      decideWake({ trigger: { kind: "heartbeat" }, digestSize: 0, claimsHeld: 0, paused: false })
        .wake,
    ).toBe(false);
    expect(
      decideWake({ trigger: { kind: "heartbeat" }, digestSize: 0, claimsHeld: 1, paused: false })
        .wake,
    ).toBe(true);
    expect(
      decideWake({ trigger: { kind: "heartbeat" }, digestSize: 3, claimsHeld: 0, paused: false })
        .wake,
    ).toBe(true);
  });

  it("always runs reflection and onboarding turns", () => {
    expect(
      decideWake({ trigger: { kind: "reflection" }, digestSize: 0, claimsHeld: 0, paused: false })
        .wake,
    ).toBe(true);
    expect(
      decideWake({ trigger: { kind: "onboarding" }, digestSize: 0, claimsHeld: 0, paused: false })
        .wake,
    ).toBe(true);
  });
});
