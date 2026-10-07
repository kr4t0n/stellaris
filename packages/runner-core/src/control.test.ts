import { describe, expect, it } from "vitest";
import { TurnControl } from "./control.js";

const steer = { id: "0f8b2c55-6b1e-4d6a-9f3e-2a7c1d9e4b10", text: "also add a test" };

describe("TurnControl", () => {
  it("refuses steers while no adapter holds the turn, and after it lets go", async () => {
    const control = new TurnControl();
    expect(await control.steer(steer)).toBe(false);
    const taken: string[] = [];
    const detach = control.attach({
      steer: (input) => {
        taken.push(input.text);
        return Promise.resolve(true);
      },
    });
    expect(await control.steer(steer)).toBe(true);
    detach();
    expect(await control.steer(steer)).toBe(false);
    expect(taken).toEqual(["also add a test"]);
  });

  it("hands a stop asked before the adapter attached to it when it does, and refuses steers after", async () => {
    const control = new TurnControl();
    control.stop();
    expect(control.stopped).toBe(true);
    let stops = 0;
    control.attach({
      steer: () => Promise.resolve(true),
      stop: () => {
        stops += 1;
      },
    });
    control.stop();
    expect(stops).toBe(1);
    expect(await control.steer(steer)).toBe(false);
  });
});
