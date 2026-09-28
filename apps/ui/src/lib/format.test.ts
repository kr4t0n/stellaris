import { describe, expect, it } from "vitest";
import { describeToolInput, plainValue, shortId, timeAgo } from "./format.js";

describe("format helpers", () => {
  it("renders relative times", () => {
    const now = new Date("2026-09-28T12:00:00.000Z");
    expect(timeAgo("2026-09-28T11:59:50.000Z", now)).toBe("just now");
    expect(timeAgo("2026-09-28T11:45:00.000Z", now)).toBe("15m ago");
    expect(timeAgo("2026-09-28T09:00:00.000Z", now)).toBe("3h ago");
    expect(timeAgo("2026-09-25T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("shortens ids and summarizes tool inputs", () => {
    expect(shortId("01M3M0RWHAJ0ZC1DP5333RM96R")).toBe("3rm96r");
    expect(describeToolInput({ command: "git status" })).toBe("git status");
    expect(describeToolInput({ task_id: "x", note: "n" })).toBe("x");
    expect(describeToolInput("plain")).toBe("plain");
    expect(describeToolInput(null)).toBe("");
  });

  it("renders charter values as readable text", () => {
    expect(plainValue(["demo", "api"])).toBe("demo, api");
    expect(plainValue(3)).toBe("3");
    expect(plainValue(null)).toBe("");
    expect(plainValue({ a: 1 })).toBe('{"a":1}');
  });
});
