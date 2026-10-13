import { CliQuotaSchema, RunnerSchema, type CliQuotaInput, type Runner } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import {
  QUOTA_STALE_MS,
  quotaLine,
  quotaRows,
  quotaStale,
  quotaWords,
  until,
  windowReading,
} from "./quota.js";

const NOON = Date.parse("2026-10-13T12:00:00.000Z");

function quota(input: Partial<CliQuotaInput> = {}) {
  return CliQuotaSchema.parse({
    observedAt: "2026-10-13T11:55:00.000Z",
    source: "turn",
    status: "allowed",
    ...input,
  });
}

const FIVE_HOUR = {
  key: "five_hour",
  minutes: 300,
  usedPercent: 35,
  resetsAt: "2026-10-13T16:50:00.000Z",
  observedAt: "2026-10-13T11:55:00.000Z",
};

function runner(name: string, quotas: Runner["quotas"], status = "connected"): Runner {
  return RunnerSchema.parse({
    name,
    os: "linux",
    clis: ["claude", "codex"],
    capabilities: [],
    status,
    quotas,
  });
}

describe("quotaStale", () => {
  it("wants numbers never reported, or reported a quarter of an hour ago or more", () => {
    expect(quotaStale(undefined, NOON)).toBe(true);
    const observed = quota({ observedAt: new Date(NOON - QUOTA_STALE_MS + 1).toISOString() });
    expect(quotaStale(observed, NOON)).toBe(false);
    expect(quotaStale(observed, NOON + 1)).toBe(true);
  });
});

describe("quotaRows", () => {
  it("lists each runner's CLIs, and gives runners with the same numbers one row", () => {
    const same = quota({ plan: "max", windows: [FIVE_HOUR] });
    const rows = quotaRows([
      runner("pod", { claude: same }),
      runner(
        "merlin",
        { claude: quota({ ...same, observedAt: "2026-10-13T11:58:00.000Z" }) },
        "disconnected",
      ),
      runner("spare", {
        claude: quota({ plan: "max", windows: [{ ...FIVE_HOUR, usedPercent: 60 }] }),
      }),
    ]);
    expect(
      rows.map((row) => [row.cli, row.runners, row.quota === undefined, row.connected]),
    ).toEqual([
      ["claude", ["pod", "merlin"], false, true],
      ["codex", ["pod"], true, true],
      ["codex", ["merlin"], true, false],
      ["claude", ["spare"], false, true],
      ["codex", ["spare"], true, true],
    ]);
  });
});

describe("readings", () => {
  it("says how long until a time in minutes, hours, or days", () => {
    expect(until(30_000)).toBe("1m");
    expect(until(42 * 60_000)).toBe("42m");
    expect(until((4 * 60 + 12) * 60_000)).toBe("4h 12m");
    expect(until((3 * 24 + 6) * 3_600_000)).toBe("3d 6h");
  });

  it("reads a window's fill, percent, and reset, and one reset since as reset", () => {
    expect(windowReading({ ...FIVE_HOUR }, NOON)).toEqual({
      name: "5h",
      percent: 35,
      label: "35%",
      reset: "resets in 4h 50m",
      high: false,
    });
    expect(windowReading({ ...FIVE_HOUR, usedPercent: 104.4 }, NOON)).toMatchObject({
      percent: 100,
      label: "104%",
      high: true,
    });
    expect(windowReading({ ...FIVE_HOUR, usedPercent: null, resetsAt: null }, NOON)).toMatchObject({
      percent: null,
      label: "?",
      reset: "",
    });
    expect(windowReading({ ...FIVE_HOUR, resetsAt: "2026-10-13T11:59:00.000Z" }, NOON)).toEqual({
      name: "5h",
      percent: null,
      label: "reset",
      reset: "reset since read",
      high: false,
    });
  });

  it("words a limit, a warning, a login without limits, and nothing to say", () => {
    expect(
      quotaWords(quota({ status: "limited", limitedUntil: "2026-10-13T13:00:00.000Z" }), NOON),
    ).toEqual({ level: "limited", words: "limited for 1h 0m", tone: "text-red-300" });
    expect(quotaWords(quota({ status: "limited" }), NOON).words).toBe("limited");
    expect(quotaWords(quota({ windows: [{ ...FIVE_HOUR, usedPercent: 90 }] }), NOON)).toEqual({
      level: "warning",
      words: "near its limit",
      tone: "text-amber-300",
    });
    expect(quotaWords(quota({ status: "none" }), NOON).words).toBe("no plan limits");
    expect(quotaWords(quota({ windows: [FIVE_HOUR] }), NOON).words).toBe("");
  });

  it("puts a citizen's quota on one runner in a line", () => {
    expect(quotaLine(undefined, NOON)).toBe("unknown");
    expect(
      quotaLine(
        quota({
          windows: [
            FIVE_HOUR,
            { ...FIVE_HOUR, key: "seven_day", minutes: 10_080, usedPercent: 85 },
          ],
        }),
        NOON,
      ),
    ).toBe("5h 35% · 7d 85% · near its limit");
    expect(quotaLine(quota({ status: "limited", limitedUntil: null }), NOON)).toBe("limited");
    expect(quotaLine(quota(), NOON)).toBe("no windows reported");
  });
});
