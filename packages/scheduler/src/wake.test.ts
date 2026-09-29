import { TriggerSchema } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { decideWake } from "./wake.js";

const trigger = (kind: string, extra: Record<string, unknown> = {}) =>
  TriggerSchema.parse({ kind, ...extra });

describe("decideWake", () => {
  it("never wakes while paused", () => {
    const decision = decideWake({
      trigger: trigger("mention", { fromUser: true }),
      digestSize: 5,
      claimsHeld: 1,
      paused: true,
    });
    expect(decision.wake).toBe(false);
  });

  it("gives user mentions top priority", () => {
    const decision = decideWake({
      trigger: trigger("mention", { fromUser: true }),
      digestSize: 0,
      claimsHeld: 0,
      paused: false,
    });
    expect(decision).toEqual({ wake: true, reason: "user mention", priority: 2 });
  });

  it("skips heartbeats with an empty digest and no claims", () => {
    const base = { trigger: trigger("heartbeat"), paused: false };
    expect(decideWake({ ...base, digestSize: 0, claimsHeld: 0 }).wake).toBe(false);
    expect(decideWake({ ...base, digestSize: 0, claimsHeld: 1 }).wake).toBe(true);
    expect(decideWake({ ...base, digestSize: 3, claimsHeld: 0 }).wake).toBe(true);
  });

  it("always runs reflection and onboarding turns", () => {
    const base = { digestSize: 0, claimsHeld: 0, paused: false };
    expect(decideWake({ ...base, trigger: trigger("reflection") }).wake).toBe(true);
    expect(decideWake({ ...base, trigger: trigger("onboarding") }).wake).toBe(true);
  });

  it("wakes on operations signals in the background", () => {
    expect(
      decideWake({ trigger: trigger("ops_event"), digestSize: 0, claimsHeld: 0, paused: false }),
    ).toEqual({ wake: true, reason: "operations signal", priority: 0 });
  });
});
