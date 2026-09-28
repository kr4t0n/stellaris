import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse.js";

describe("createSseParser", () => {
  it("assembles messages across chunk boundaries and ignores comments", () => {
    const parser = createSseParser();
    expect(parser.feed('id: 1\nevent: turn\ndata: {"a":')).toEqual([]);
    expect(parser.feed("1}\n\n: keep-alive\n\nevent: ping\ndata: \n\n")).toEqual([
      { id: "1", event: "turn", data: '{"a":1}' },
      { id: null, event: "ping", data: "" },
    ]);
  });

  it("joins multi-line data and defaults the event name", () => {
    const parser = createSseParser();
    expect(parser.feed("data: one\ndata: two\n\n")).toEqual([
      { id: null, event: "message", data: "one\ntwo" },
    ]);
    expect(parser.feed("\r\n")).toEqual([]);
  });
});
