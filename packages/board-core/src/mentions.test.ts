import { describe, expect, it } from "vitest";
import { postMentions, within } from "./mentions.js";

describe("within", () => {
  it("returns what the work returns, nothing once it runs past its time, and is free again after", () => {
    expect(within(() => 42, 1_000)).toBe(42);
    let spins = 0;
    expect(
      within(() => {
        for (;;) {
          spins += 1;
        }
      }, 50),
    ).toBeUndefined();
    expect(spins).toBeGreaterThan(0);
    expect(within(() => "next", 1_000)).toBe("next");
  });

  it("passes on any other failure, one with a code of its own included", () => {
    expect(() =>
      within(() => {
        throw new Error("boom");
      }, 1_000),
    ).toThrow("boom");
    expect(() =>
      within(() => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }, 1_000),
    ).toThrow("disk full");
  });
});

describe("postMentions", () => {
  it("counts the names outside code, and every name when the parse would hold the board too long", () => {
    expect(postMentions("Run `@eng-1 --fix`, then @rev-1")).toEqual(["rev-1"]);
    // Thousands of list items nested on one line take micromark seconds to parse.
    expect(postMentions(`${"- ".repeat(4096)}\`@eng-1\` @rev-1`)).toEqual(["eng-1", "rev-1"]);
  });
});
