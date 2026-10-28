import { describe, expect, it } from "vitest";
import { z } from "zod";
import composeCases from "../../../ios/fixtures/cases/compose.json?raw";
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

  // The iOS app's port runs the same table (apps/ios/fixtures/cases).
  it("agrees with the case table the iOS port runs", () => {
    const cases = z
      .object({
        name: z.string(),
        text: z.string(),
        caret: z.number(),
        mention: z.object({ start: z.number(), prefix: z.string() }).nullable(),
        completed: z.object({ name: z.string(), text: z.string(), caret: z.number() }).optional(),
      })
      .array()
      .parse(JSON.parse(composeCases));
    expect(cases.length).toBeGreaterThan(10);
    expect(
      cases.map((each) => {
        const mention = mentionAt(each.text, each.caret);
        const name = each.completed?.name;
        return {
          name: each.name,
          mention,
          completed:
            mention === null || name === undefined
              ? undefined
              : { name, ...completeMention(each.text, each.caret, mention.start, name) },
        };
      }),
    ).toEqual(
      cases.map((each) => ({ name: each.name, mention: each.mention, completed: each.completed })),
    );
  });

  it("lists names as a sentence", () => {
    expect(listed(["desk", "ada"])).toBe("desk and ada");
  });
});
