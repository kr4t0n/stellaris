import { CronFrontmatterSchema, type CronFrontmatter } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { cronGroups, cronPlace, failingCron, schedulePreview } from "./crons.js";

function cron(id: string, fields: Partial<CronFrontmatter> = {}): CronFrontmatter {
  return CronFrontmatterSchema.parse({
    id,
    title: id,
    agent: "ada",
    scope: "lab",
    schedule: { cron: "0 * * * *" },
    createdBy: "user",
    createdAt: "2026-10-10T10:00:00.000Z",
    since: "2026-10-10T10:00:00.000Z",
    ...fields,
  });
}

const A = "01M3Q2AAAAAAAAAAAAAAAAAAA1";
const B = "01M3Q2AAAAAAAAAAAAAAAAAAA2";
const C = "01M3Q2AAAAAAAAAAAAAAAAAAA3";
const D = "01M3Q2AAAAAAAAAAAAAAAAAAA4";

describe("crons in the view", () => {
  it("lists running crons by next fire, then paused, then the latest ended first", () => {
    const groups = cronGroups(
      [
        cron(A, { schedule: { cron: "0 9 * * *" } }),
        cron(B),
        cron(C, { paused: { at: "2026-10-10T10:30:00.000Z", by: "ada" } }),
        cron(D, { ended: { at: "2026-10-10T10:40:00.000Z", by: "user", reason: "done" } }),
      ],
      "UTC",
    );
    expect(groups.active.map((each) => [each.cron.id, each.next?.toISOString()])).toEqual([
      [B, "2026-10-10T11:00:00.000Z"],
      [A, "2026-10-11T09:00:00.000Z"],
    ]);
    expect(groups.paused.map((each) => each.id)).toEqual([C]);
    expect(groups.ended.map((each) => each.id)).toEqual([D]);
  });

  it("names where a cron fires and whether its turns keep failing", () => {
    expect(cronPlace(cron(A, { channel: "dev" }))).toEqual({ kind: "channel", ref: "lab/dev" });
    expect(cronPlace(cron(A, { scope: "society", channel: "ops" }))).toEqual({
      kind: "channel",
      ref: "ops",
    });
    expect(cronPlace(cron(A, { thread: B }))).toEqual({ kind: "thread", id: B });
    expect(cronPlace(cron(A))).toEqual({ kind: "home", scope: "lab" });
    expect(failingCron(cron(A, { failures: 3 }))).toBe(true);
    expect(failingCron(cron(A, { failures: 2 }))).toBe(false);
  });

  it("previews a schedule's next fires, or why the board would refuse it", () => {
    const now = new Date("2026-10-10T00:00:00Z");
    expect(schedulePreview({ cron: "0 9 * * 1-5" }, "Asia/Shanghai", now)).toEqual({
      times: [
        new Date("2026-10-12T01:00:00Z"),
        new Date("2026-10-13T01:00:00Z"),
        new Date("2026-10-14T01:00:00Z"),
      ],
    });
    expect(schedulePreview({ cron: "*/5 * * * *" }, "UTC", now)).toEqual({
      error: expect.stringContaining("at most every 15 minutes"),
    });
    expect(schedulePreview({ cron: "0 0 31 2 *" }, "UTC", now)).toEqual({
      error: "It names no time to come.",
    });
    expect(schedulePreview({ cron: "0 9 * *" }, "UTC", now)).toHaveProperty("error");
    expect(schedulePreview({ cron: "0 9 * * *", timezone: "Mars/Base" }, "UTC", now)).toEqual({
      error: "Mars/Base is not a time zone.",
    });
    expect(schedulePreview({ at: "2026-10-09T00:00:00Z" }, "UTC", now)).toEqual({
      error: "That time has passed.",
    });
  });
});
