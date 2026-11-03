import { describe, expect, it } from "vitest";
import { z } from "zod";
import composeCases from "../../../ios/fixtures/cases/compose.json?raw";
import uploadCases from "../../../ios/fixtures/cases/uploads.json?raw";
import {
  completeMention,
  insertAt,
  listed,
  mentionAt,
  settleUpload,
  uploadingImage,
  uploadPlaceholder,
} from "./compose.js";

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

  // The iOS app's port runs the same table (apps/ios/fixtures/cases).
  it("holds an image's place while it uploads, then puts its markdown there, as the iOS port does", () => {
    const Draft = z.object({ text: z.string(), caret: z.number() });
    const cases = z
      .object({
        placeholders: z
          .object({ name: z.string(), file: z.string(), placeholder: z.string() })
          .array(),
        inserts: z
          .object({
            name: z.string(),
            text: z.string(),
            start: z.number(),
            end: z.number(),
            inserted: z.string(),
            result: Draft,
          })
          .array(),
        settles: z
          .object({
            name: z.string(),
            text: z.string(),
            caret: z.number(),
            placeholder: z.string(),
            markdown: z.string(),
            result: Draft.nullable(),
          })
          .array(),
        numbered: z
          .object({
            name: z.string(),
            file: z.string(),
            text: z.string(),
            held: z.string().array(),
            placeholder: z.string(),
          })
          .array(),
      })
      .parse(JSON.parse(uploadCases));
    expect(cases.settles.length).toBeGreaterThan(5);
    for (const each of cases.placeholders) {
      expect({ name: each.name, placeholder: uploadingImage(each.file) }).toEqual({
        name: each.name,
        placeholder: each.placeholder,
      });
    }
    for (const each of cases.inserts) {
      expect({
        name: each.name,
        result: insertAt(each.text, each.start, each.end, each.inserted),
      }).toEqual({
        name: each.name,
        result: each.result,
      });
    }
    for (const each of cases.numbered) {
      expect({
        name: each.name,
        placeholder: uploadPlaceholder(each.file, each.text, each.held),
      }).toEqual({
        name: each.name,
        placeholder: each.placeholder,
      });
    }
    for (const each of cases.settles) {
      expect({
        name: each.name,
        result: settleUpload(each.text, each.caret, each.placeholder, each.markdown),
      }).toEqual({ name: each.name, result: each.result });
    }
  });

  it("lists names as a sentence", () => {
    expect(listed(["desk", "ada"])).toBe("desk and ada");
  });
});
