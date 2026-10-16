import { describe, expect, it } from "vitest";
import { turnTarget } from "./TurnControls.js";

const TURN = {
  turnId: "01M3S0000000000000000000AA",
  agent: "concierge-1",
  cli: "claude" as const,
  steerable: true,
  stoppable: true,
};

describe("turnTarget", () => {
  it("posts into a turn's thread, its channel, or the channel it was asked from at home", () => {
    expect(turnTarget({ ...TURN, scope: "lab", thread: "01M3S0000000000000000000BB" })).toEqual({
      threadId: "01M3S0000000000000000000BB",
    });
    expect(turnTarget({ ...TURN, scope: "lab", channel: "dev" })).toEqual({ channel: "lab/dev" });
    expect(turnTarget({ ...TURN, scope: "society", askedIn: "asks" })).toEqual({
      channel: "asks",
    });
    expect(turnTarget({ ...TURN, scope: "society" })).toEqual({ channel: "general" });
  });

  it("posts into a project's channels' turn where it was asked in that project, else its general", () => {
    expect(turnTarget({ ...TURN, scope: "society", place: "lab", askedIn: "lab/dev" })).toEqual({
      channel: "lab/dev",
    });
    // A wake from elsewhere, such as a cron's or a heartbeat's, names no channel of the project.
    expect(turnTarget({ ...TURN, scope: "society", place: "lab", askedIn: "general" })).toEqual({
      channel: "lab/general",
    });
    expect(turnTarget({ ...TURN, scope: "society", place: "lab" })).toEqual({
      channel: "lab/general",
    });
  });
});
