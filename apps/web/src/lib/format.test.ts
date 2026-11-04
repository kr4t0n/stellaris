import { describe, expect, it } from "vitest";
import { z } from "zod";
import paragraphCases from "../../../ios/fixtures/cases/first-paragraph.json?raw";
import { firstParagraph } from "./format.js";

describe("firstParagraph", () => {
  // The iOS app's port runs the same table (apps/ios/fixtures/cases).
  it("agrees with the case table the iOS port runs", () => {
    const cases = z
      .object({
        name: z.string(),
        markdown: z.string(),
        limit: z.number().optional(),
        paragraph: z.string(),
      })
      .array()
      .parse(JSON.parse(paragraphCases));
    expect(cases.length).toBeGreaterThan(10);
    expect(
      cases.map((each) => ({
        name: each.name,
        paragraph:
          each.limit === undefined
            ? firstParagraph(each.markdown)
            : firstParagraph(each.markdown, each.limit),
      })),
    ).toEqual(cases.map((each) => ({ name: each.name, paragraph: each.paragraph })));
  });
});
