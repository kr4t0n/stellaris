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

/** One of Antigravity's buckets, which all reset at 15:50 here. */
function agyWindow(key: string, label: string, minutes: number, usedPercent: number) {
  return {
    key,
    label,
    minutes,
    usedPercent,
    resetsAt: "2026-10-13T15:50:00.000Z",
    observedAt: "2026-10-13T11:55:00.000Z",
  };
}

/** One of Antigravity's pools, spent until `limitedUntil` unless that is null. */
function agyPool(key: string, limitedUntil: string | null) {
  return {
    key,
    limited: limitedUntil !== null,
    limitedUntil,
    observedAt: "2026-10-13T11:55:00.000Z",
  };
}

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

  it("shows a percent rounded down, so its label reads 80% exactly when it turns amber", () => {
    expect(windowReading({ ...FIVE_HOUR, usedPercent: 79.6 }, NOON)).toMatchObject({
      label: "79%",
      high: false,
    });
    expect(windowReading({ ...FIVE_HOUR, usedPercent: 80 }, NOON)).toMatchObject({
      label: "80%",
      high: true,
    });
  });

  it("words a limit, a warning, a login without limits, and nothing to say", () => {
    expect(
      quotaWords(quota({ status: "limited", limitedUntil: "2026-10-13T13:00:00.000Z" }), NOON),
    ).toEqual({ level: "limited", words: "limited for 1h 0m", tone: "text-red-300" });
    expect(quotaWords(quota({ status: "limited" }), NOON).words).toBe("limited");
    expect(quotaWords(quota({ windows: [{ ...FIVE_HOUR, usedPercent: 90 }] }), NOON)).toEqual({
      level: "warning",
      words: "near a limit",
      tone: "text-amber-300",
    });
    expect(quotaWords(quota({ status: "none" }), NOON).words).toBe("no plan limits reported");
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
    ).toBe("5h 35% · 7d 85% · near a limit");
    expect(quotaLine(quota({ status: "limited", limitedUntil: null }), NOON)).toBe("limited");
    expect(quotaLine(quota(), NOON)).toBe("no windows reported");
  });

  it("words and lines a citizen's quota by its model's pool, as its turns are held", () => {
    // Antigravity's read with its third-party pool spent until 15:50, which warns for the login.
    const spent = quota({
      source: "read",
      status: "warning",
      windows: [
        agyWindow("gemini-weekly", "Gemini Models", 10_080, 12),
        agyWindow("gemini-5h", "Gemini Models", 300, 30),
        agyWindow("3p-weekly", "Claude and GPT models", 10_080, 50),
        agyWindow("3p-5h", "Claude and GPT models", 300, 100),
      ],
      pools: [agyPool("gemini", null), agyPool("3p", "2026-10-13T15:50:00.000Z")],
    });
    // The CLI as a whole, as the runners view reads it, is near a limit.
    expect(quotaWords(spent, NOON).words).toBe("near a limit");
    expect(quotaWords(spent, NOON, "3p")).toEqual({
      level: "limited",
      words: "limited for 3h 50m",
      tone: "text-red-300",
    });
    expect(quotaLine(spent, NOON, "3p")).toBe("limited for 3h 50m");
    expect(quotaWords(spent, NOON, "gemini")).toEqual({
      level: "ok",
      words: "",
      tone: "text-fg-muted",
    });
    expect(quotaLine(spent, NOON, "gemini")).toBe("7d gemini models 12% · gemini models 30%");
    // A pool spent with no reset reads as limited without a time, as long as it holds.
    const unknown = quota({
      status: "warning",
      pools: [{ key: "3p", limited: true, observedAt: "2026-10-13T11:55:00.000Z" }],
    });
    expect(quotaWords(unknown, NOON, "3p").words).toBe("limited");
    expect(quotaWords(unknown, NOON + 25 * 60_000, "3p").words).toBe("near a limit");
    // While the login and the pool both hold, the later end does.
    const both = quota({
      ...spent,
      status: "limited",
      limitedUntil: "2026-10-13T13:00:00.000Z",
    });
    expect(quotaWords(both, NOON, "3p").words).toBe("limited for 3h 50m");
    expect(quotaWords(both, NOON, "gemini").words).toBe("limited for 1h 0m");
    expect(quotaWords(both, NOON).words).toBe("limited for 1h 0m");
  });
});
