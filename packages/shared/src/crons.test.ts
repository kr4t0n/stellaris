import { describe, expect, it } from "vitest";
import {
  canonicalTimeZone,
  CronFrontmatterSchema,
  cronStoppedAt,
  CronScheduleSchema,
  fireTimes,
  localTime,
  nextFire,
  shortestGapMs,
  VerbInputs,
  type CronFrontmatter,
} from "./index.js";

/** A cron set at ten in the morning, UTC, with nothing fired yet. */
function cron(fields: Partial<CronFrontmatter> = {}): CronFrontmatter {
  return CronFrontmatterSchema.parse({
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    title: "Check",
    agent: "eng-1",
    scope: "demo",
    schedule: { cron: "0 * * * *" },
    createdBy: "eng-1",
    createdAt: "2026-10-10T10:00:00.000Z",
    since: "2026-10-10T10:00:00.000Z",
    ...fields,
  });
}

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** How the turn of a cron's latest fire ended, and when. */
const run = (outcome: "completed" | "failed" | "stopped", at: string) => ({
  lastRun: { turnId: "01ARZ3NDEKTSV4RRFFQ69G5FAW", at, outcome },
});

describe("crons", () => {
  it("reads an expression in its own zone, else the society's", () => {
    const weekdays = CronScheduleSchema.parse({ cron: "0 9 * * 1-5" });
    const after = new Date("2026-10-10T00:00:00Z");
    expect(
      fireTimes(weekdays, "Asia/Shanghai", after, 2).map((date) => date.toISOString()),
    ).toEqual(["2026-10-12T01:00:00.000Z", "2026-10-13T01:00:00.000Z"]);
    const zoned = CronScheduleSchema.parse({ cron: "0 9 * * 1-5", timezone: "Europe/Berlin" });
    expect(iso(fireTimes(zoned, "Asia/Shanghai", after, 1)[0] ?? null)).toBe(
      "2026-10-12T07:00:00.000Z",
    );
    expect(shortestGapMs(weekdays, "UTC", after)).toBe(24 * 3_600_000);
    expect(
      shortestGapMs(CronScheduleSchema.parse({ at: "2026-10-11T00:00:00Z" }), "UTC", after),
    ).toBeNull();
  });

  it("fires after its schedule took effect, at most once for times it missed, and a floor after its last fire", () => {
    expect(iso(nextFire(cron(), "UTC"))).toBe("2026-10-10T11:00:00.000Z");
    // Fired at 11:00, a few seconds late; 12:00 is next, not 11:00 again.
    expect(iso(nextFire(cron({ lastFiredAt: "2026-10-10T11:00:04.000Z" }), "UTC"))).toBe(
      "2026-10-10T12:00:00.000Z",
    );
    // Back after a pause long past 12:00 and 13:00, it fired once at 13:40; 14:00 is next.
    expect(iso(nextFire(cron({ lastFiredAt: "2026-10-10T13:40:00.000Z" }), "UTC"))).toBe(
      "2026-10-10T14:00:00.000Z",
    );
    // Every fifteen minutes stays every fifteen minutes after a fire that came late.
    const quarterly = cron({
      schedule: { cron: "*/15 * * * *" },
      lastFiredAt: "2026-10-10T10:15:02.000Z",
    });
    expect(iso(nextFire(quarterly, "UTC"))).toBe("2026-10-10T10:30:00.000Z");
    expect(iso(nextFire(cron({ lastSkippedAt: "2026-10-10T11:00:00.000Z" }), "UTC"))).toBe(
      "2026-10-10T12:00:00.000Z",
    );
    const paused = { at: "2026-10-10T10:30:00.000Z", by: "eng-1" };
    expect(nextFire(cron({ paused }), "UTC")).toBeNull();
    const ended = { at: "2026-10-10T10:30:00.000Z", by: "eng-1", reason: "done" };
    expect(nextFire(cron({ ended }), "UTC")).toBeNull();
  });

  it("fires a one-time cron once, at its time or at once when that passed while it was paused", () => {
    const once = { schedule: { at: "2026-10-10T12:00:00.000Z" } };
    expect(iso(nextFire(cron(once), "UTC"))).toBe("2026-10-10T12:00:00.000Z");
    expect(nextFire(cron({ ...once, lastFiredAt: "2026-10-10T12:00:01.000Z" }), "UTC")).toBeNull();
  });

  it("counts a cron pending until it is paused, ended, or its latest fire's turn failed, whichever came first", () => {
    const paused = { paused: { at: "2026-10-10T12:00:00.000Z", by: "eng-1" } };
    const ended = { ended: { at: "2026-10-10T13:00:00.000Z", by: "eng-1", reason: "done" } };
    expect(cronStoppedAt(cron())).toBeNull();
    expect(cronStoppedAt(cron(paused))).toBe("2026-10-10T12:00:00.000Z");
    expect(cronStoppedAt(cron(ended))).toBe("2026-10-10T13:00:00.000Z");
    expect(cronStoppedAt(cron({ ...paused, ...ended }))).toBe("2026-10-10T12:00:00.000Z");
    expect(cronStoppedAt(cron(run("failed", "2026-10-10T11:02:00.000Z")))).toBe(
      "2026-10-10T11:02:00.000Z",
    );
    // A completed turn, or one the user stopped, leaves it pending.
    expect(cronStoppedAt(cron(run("completed", "2026-10-10T11:02:00.000Z")))).toBeNull();
    expect(cronStoppedAt(cron(run("stopped", "2026-10-10T11:02:00.000Z")))).toBeNull();
    // A failure before a pause stopped it first; a turn that failed after the pause, later.
    expect(cronStoppedAt(cron({ ...paused, ...run("failed", "2026-10-10T11:02:00.000Z") }))).toBe(
      "2026-10-10T11:02:00.000Z",
    );
    expect(cronStoppedAt(cron({ ...paused, ...run("failed", "2026-10-10T12:02:00.000Z") }))).toBe(
      "2026-10-10T12:00:00.000Z",
    );
  });

  it("takes time zones by their IANA names, as Intl canonicalizes them, and five fields only", () => {
    expect(canonicalTimeZone("asia/shanghai")).toBe("Asia/Shanghai");
    expect(canonicalTimeZone("Mars/Olympus")).toBeNull();
    const input = VerbInputs.create_cron;
    expect(
      input.parse({ title: "t", note: "n", cron: "0 9 * * *", timezone: "utc" }),
    ).toMatchObject({ timezone: "UTC" });
    expect(input.safeParse({ title: "t", note: "n", cron: "0 0 9 * * *" }).success).toBe(false);
    expect(input.safeParse({ title: "t", note: "n", at: "tomorrow" }).success).toBe(false);
    expect(localTime(new Date("2026-10-10T01:00:00Z"), "Asia/Shanghai")).toBe(
      "Saturday 2026-10-10 09:00",
    );
  });
});
