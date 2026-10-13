import { describe, expect, it } from "vitest";
import { completeMention, listed, mentionAt } from "./compose.js";

describe("composing", () => {
  it("finds the mention being typed and completes it", () => {
    expect(mentionAt("hey @ad", 7)).toEqual({ start: 4, prefix: "ad" });
    expect(mentionAt("hey @", 5)).toEqual({ start: 4, prefix: "" });
    expect(mentionAt("mail a@b", 8)).toBeNull();
    expect(mentionAt("hey ada", 7)).toBeNull();
    expect(completeMention("hey @ad, look", 7, 4, "ada")).toEqual({
      text: "hey @ada , look",
      caret: 9,
    });
  });

  it("lists names as a sentence", () => {
    expect(listed(["desk", "ada"])).toBe("desk and ada");
  });
});
