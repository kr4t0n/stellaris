import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "../lib/api.js";
import { askState, asksOf, askTitle, hasUnseenReply } from "./asks.js";

const ASK = "01M3S00000000000000000000A";
const REPLY = "01M3S00000000000000000000R";

function thread(fields: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: ASK,
    channel: "general",
    title: "Who reviews the survey?",
    state: "open",
    openedBy: "user",
    openedAt: "2026-09-30T06:00:00.000Z",
    body: "",
    messages: 2,
    lastMessageId: REPLY,
    lastAuthor: "desk",
    ...fields,
  };
}

describe("asks", () => {
  it("are the topic threads the user opened in the society's general, newest first", () => {
    const newer = thread({ id: "01M3S00000000000000000000B" });
    expect(
      asksOf([
        thread(),
        newer,
        thread({ id: "01M3S00000000000000000000C", openedBy: "desk" }),
        thread({ id: "01M3S00000000000000000000D", channel: "lab/general" }),
        thread({ id: "01M3S00000000000000000000E", subject: { kind: "task", id: ASK } }),
      ]).map((ask) => ask.id),
    ).toEqual([newer.id, ASK]);
  });

  it("are titled by their first line, cut at a word", () => {
    expect(askTitle("  # Merge the phone projects\n\nBoth study phones.")).toBe(
      "Merge the phone projects",
    );
    expect(askTitle("   ")).toBe("Ask");
    const long = askTitle(`${"word ".repeat(30)}end`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).toMatch(/word…$/);
  });

  it("stand where the scheduler and the last post put them", () => {
    const running = [{ agent: "desk", thread: ASK }];
    expect(askState(thread(), running, [])).toEqual({ kind: "answering", who: ["desk"] });
    expect(askState(thread(), [{ agent: "desk" }], running)).toEqual({
      kind: "queued",
      who: ["desk"],
    });
    expect(askState(thread({ lastAuthor: "user" }), [], [])).toEqual({ kind: "waiting" });
    expect(askState(thread(), [], [])).toEqual({ kind: "answered", by: "desk" });
    expect(askState(thread({ state: "closed", closedBy: "desk" }), running, [])).toEqual({
      kind: "closed",
      by: "desk",
    });
  });

  it("mark an open answer until this browser shows it, even before the board was listed", () => {
    expect(hasUnseenReply(thread(), null)).toBe(true);
    expect(hasUnseenReply(thread(), { [ASK]: REPLY })).toBe(false);
    expect(hasUnseenReply(thread({ lastAuthor: "user" }), null)).toBe(false);
    expect(hasUnseenReply(thread({ state: "closed" }), null)).toBe(false);
  });
});
