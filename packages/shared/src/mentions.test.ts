import { describe, expect, it } from "vitest";
import { MENTION_PATTERN, mentionsAnywhere, mentionsIn } from "./mentions.js";

describe("mentionsIn", () => {
  it("reads names outside words and addresses, once each, sorted", () => {
    expect(mentionsIn("@rev-1 and @eng-1, then @eng-1 again")).toEqual(["eng-1", "rev-1"]);
    expect(mentionsIn("mail a@b.c, or @@eng-1, or @Eng-1")).toEqual([]);
    expect(mentionsIn("no names here")).toEqual([]);
  });

  it("finds code as CommonMark does: spans of any run, fences of either kind, indented blocks", () => {
    expect(mentionsIn("```` a ``` @eng-1 ````")).toEqual([]);
    expect(mentionsIn("a span `across\n@eng-1 lines`")).toEqual([]);
    expect(mentionsIn("``unmatched` @eng-1")).toEqual(["eng-1"]);
    expect(mentionsIn("\\`escaped` @eng-1")).toEqual(["eng-1"]);
    expect(mentionsIn("~~~~\n~~~\n@eng-1\n~~~~\n@rev-1")).toEqual(["rev-1"]);
    expect(mentionsIn("para\n\n\t@eng-1")).toEqual([]);
    expect(mentionsIn("a\r\n```\r\n@eng-1\r\n```\r\n@rev-1")).toEqual(["rev-1"]);
  });

  it("finds code inside lists and quotes, by their indentation", () => {
    expect(mentionsIn("- item\n\n      @eng-1\n- @rev-1")).toEqual(["rev-1"]);
    expect(mentionsIn("- item\n\n    @eng-1")).toEqual(["eng-1"]);
    expect(mentionsIn("1. ```\n   @eng-1\n   ```\n2. @rev-1")).toEqual(["rev-1"]);
    expect(mentionsIn(">     @eng-1\n\n@rev-1")).toEqual(["rev-1"]);
    expect(mentionsIn("> ```\n> @eng-1\n\n@rev-1")).toEqual(["rev-1"]);
  });

  it("reads GFM as the interface renders it: tables and footnotes", () => {
    expect(mentionsIn("| a | b |\n| - | - |\n| `@eng-1` | @rev-1 |")).toEqual(["rev-1"]);
    expect(mentionsIn("[^1]: a note\n\n    @eng-1, the note's own paragraph")).toEqual(["eng-1"]);
  });

  it("lets a link destination, an HTML tag, or an autolink take its backticks before a span does", () => {
    expect(mentionsIn("[a](`@eng-1`)")).toEqual(["eng-1"]);
    expect(mentionsIn('<a title="`">`@eng-1`')).toEqual([]);
    expect(mentionsIn("<https://x.y/`@eng-1`>")).toEqual(["eng-1"]);
    expect(mentionsIn("[`a](u)` @eng-1")).toEqual(["eng-1"]);
  });

  it("reads a backtick right after a bare URL as code, as GitHub does, and a footnote call as text", () => {
    expect(mentionsIn("see http://x.y/`@eng-1` and @rev-1")).toEqual(["rev-1"]);
    expect(mentionsIn("www.x.y/`@eng-1`")).toEqual([]);
    expect(mentionsIn("[^1] `@eng-1` @rev-1\n\n[^1]: a note")).toEqual(["rev-1"]);
  });

  it("finds code where it is when a byte order mark leads the post", () => {
    expect(mentionsIn("\uFEFF@eng-1`x` please")).toEqual(["eng-1"]);
    expect(mentionsIn("\uFEFF@eng-10`npm test`")).toEqual(["eng-10"]);
    expect(mentionsIn("\uFEFF`@eng-1` and @rev-1")).toEqual(["rev-1"]);
  });

  it("counts every name, code included, when asked for all of them", () => {
    expect(mentionsAnywhere("`@eng-1` and @rev-1, then @eng-1")).toEqual(["eng-1", "rev-1"]);
  });

  it("leaves the shared pattern ready for the next search", () => {
    mentionsIn("`@eng-1` @rev-1");
    expect(MENTION_PATTERN.lastIndex).toBe(0);
  });
});
