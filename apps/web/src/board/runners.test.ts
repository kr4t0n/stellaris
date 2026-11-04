import { CliQuotaSchema, NAME_PATTERN, RunnerSchema, type Runner } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import {
  heldClis,
  identityGap,
  offVersion,
  runnerState,
  sameCode,
  suggestRunnerName,
} from "./runners.js";

describe("suggestRunnerName", () => {
  it("takes the hostname's first label as a name", () => {
    expect(suggestRunnerName("Studio-Mac.local", [])).toBe("studio-mac");
    expect(suggestRunnerName("gpu_box 01", [])).toBe("gpu-box-01");
  });

  it("numbers a name the society has already", () => {
    expect(suggestRunnerName("pod", ["pod"])).toBe("pod-2");
    expect(suggestRunnerName("pod", ["pod", "pod-2"])).toBe("pod-3");
  });

  it("always gives a valid name", () => {
    for (const hostname of ["", "---", "_.example.com", "x".repeat(80), "Ünïcode-host"]) {
      expect(suggestRunnerName(hostname, [])).toMatch(NAME_PATTERN);
    }
    expect(suggestRunnerName("", [])).toBe("runner");
    expect(suggestRunnerName("x".repeat(80), ["x".repeat(32)])).toBe(`${"x".repeat(30)}-2`);
  });
});

describe("offVersion", () => {
  it("marks only a known version that differs from the server's", () => {
    expect(offVersion({ version: "0.3.10" }, "0.3.11")).toBe(true);
    expect(offVersion({ version: "0.3.12" }, "0.3.11")).toBe(true);
    expect(offVersion({ version: "0.3.11" }, "0.3.11")).toBe(false);
    expect(offVersion({}, "0.3.11")).toBe(false);
    expect(offVersion({ version: "0.3.10" })).toBe(false);
  });
});

describe("identityGap", () => {
  it("marks only a runner that reported a gap in its account's git identity", () => {
    expect(identityGap({})).toBeNull();
    expect(identityGap({ gitIdentityMissing: [] })).toBeNull();
    expect(identityGap({ gitIdentityMissing: ["name"] })).toEqual({
      label: "no git user.name",
      detail:
        "Its account has no git user.name, so git refuses the commits citizens make themselves on it.",
    });
    expect(identityGap({ gitIdentityMissing: ["email"] })).toEqual({
      label: "no git user.email",
      detail:
        "Its account has no git user.email, so the commits citizens make themselves on it carry an empty address or one git made up.",
    });
    expect(identityGap({ gitIdentityMissing: ["name", "email"] })).toMatchObject({
      label: "no git identity",
      detail: expect.stringMatching(
        /^Its account has no git user\.name or user\.email, so git refuses/,
      ),
    });
  });
});

describe("sameCode", () => {
  it("ignores case and separators", () => {
    expect(sameCode("bcdf-ghjk", "BCDFGHJK")).toBe(true);
    expect(sameCode("BCDF-GHJK", "BCDF-GHJL")).toBe(false);
  });
});

function runner(fields: Partial<Runner> = {}): Runner {
  return RunnerSchema.parse({
    name: "pod",
    os: "linux",
    clis: ["claude", "codex"],
    capabilities: [],
    status: "connected",
    ...fields,
  });
}

/** Claude's quota limited until `limitedUntil`, as reported ten minutes before `NOW`. */
function limited(limitedUntil: string | null) {
  return CliQuotaSchema.parse({
    observedAt: "2026-11-04T07:50:00.000Z",
    source: "read",
    status: "limited",
    limitedUntil,
  });
}

describe("runnerState", () => {
  const NOW = Date.parse("2026-11-04T08:00:00.000Z");
  const pause = { at: "2026-11-04T07:00:00.000Z", by: "user" };

  it("names the CLIs a limit holds beside those the user paused, with when each hold lifts", () => {
    const held = runner({
      pausedClis: { codex: pause },
      quotas: { claude: limited("2026-11-06T04:59:59.574Z") },
    });
    expect(heldClis(held, NOW)).toEqual([
      { cli: "claude", until: "2026-11-06T04:59:59.574Z", paused: false },
    ]);
    expect(runnerState(held, NOW)).toEqual({
      label: "codex paused · claude held",
      detail: "connected; codex paused 1 hour ago; claude held by its limit for 1d 21h",
      tone: "text-amber-300",
    });
    // A limit with no reset holds for half an hour from its report.
    expect(runnerState(runner({ quotas: { claude: limited(null) } }), NOW)).toMatchObject({
      label: "claude held",
      detail: "connected; claude held by its limit for 20m",
    });
  });

  it("leaves a hold the user's pause covers out of the label, and in the detail", () => {
    // The pause holds those turns already, so the label stays as it was before limits held any.
    expect(runnerState(runner({ paused: pause, quotas: { claude: limited(null) } }), NOW)).toEqual({
      label: "paused",
      detail: "connected; paused 1 hour ago; claude held by its limit for 20m",
      tone: "text-amber-300",
    });
    const both = runner({
      pausedClis: { claude: pause },
      quotas: { claude: limited(null), codex: limited(null) },
    });
    expect(heldClis(both, NOW).map((hold) => [hold.cli, hold.paused])).toEqual([
      ["claude", true],
      ["codex", false],
    ]);
    expect(runnerState(both, NOW)).toMatchObject({ label: "claude paused · codex held" });
  });

  it("says nothing of a limit that has lifted, by its reset or by half an hour", () => {
    const later = Date.parse("2026-11-04T08:20:00.000Z");
    expect(runnerState(runner({ quotas: { claude: limited(null) } }), later)).toEqual({
      label: "connected",
      detail: "connected",
      tone: "text-fg-muted",
    });
    const reset = runner({ quotas: { claude: limited("2026-11-04T08:00:00.000Z") } });
    expect(heldClis(reset, NOW)).toEqual([]);
  });

  it("keeps an away runner's label, and its holds in the detail", () => {
    const away = runner({
      status: "disconnected",
      lastSeen: "2026-11-04T07:00:00.000Z",
      quotas: { claude: limited("2026-11-04T09:00:00.000Z") },
    });
    expect(runnerState(away, NOW)).toEqual({
      label: "away",
      detail: "away, last seen 1 hour ago; claude held by its limit for 1h 0m",
      tone: "text-amber-300",
    });
  });
});
