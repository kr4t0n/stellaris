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
      waitingStages: 0,
      paused: true,
    });
    expect(decision.wake).toBe(false);
  });

  it("gives user mentions top priority", () => {
    const decision = decideWake({
      trigger: trigger("mention", { fromUser: true }),
      digestSize: 0,
      claimsHeld: 0,
      waitingStages: 0,
      paused: false,
    });
    expect(decision).toEqual({ wake: true, reason: "user mention", priority: 2 });
  });

  it("skips heartbeats with nothing unread, held, or waiting for the member", () => {
    const base = { trigger: trigger("heartbeat"), paused: false };
    const idle = { digestSize: 0, claimsHeld: 0, waitingStages: 0 };
    expect(decideWake({ ...base, ...idle }).wake).toBe(false);
    expect(decideWake({ ...base, ...idle, claimsHeld: 1 }).wake).toBe(true);
    expect(decideWake({ ...base, ...idle, digestSize: 3 }).wake).toBe(true);
    expect(decideWake({ ...base, ...idle, waitingStages: 1 }).wake).toBe(true);
  });

  it("always runs reflection and onboarding turns", () => {
    const base = { digestSize: 0, claimsHeld: 0, waitingStages: 0, paused: false };
    expect(decideWake({ ...base, trigger: trigger("reflection") }).wake).toBe(true);
    expect(decideWake({ ...base, trigger: trigger("onboarding") }).wake).toBe(true);
  });

  it("wakes on operations signals in the background", () => {
    expect(
      decideWake({
        trigger: trigger("ops_event"),
        digestSize: 0,
        claimsHeld: 0,
        waitingStages: 0,
        paused: false,
      }),
    ).toEqual({ wake: true, reason: "operations signal", priority: 0 });
  });
});
