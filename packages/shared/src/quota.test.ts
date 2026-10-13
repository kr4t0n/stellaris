import { describe, expect, it } from "vitest";
import {
  CliQuotaSchema,
  mergeQuota,
  quotaChanged,
  quotaLevel,
  sameQuotaNumbers,
  windowName,
  type CliQuota,
  type CliQuotaInput,
  type QuotaWindowInput,
} from "./quota.js";
import { RunnerHelloSchema, RunnerSchema, TurnOutcomeSchema } from "./index.js";

const AT = "2026-10-13T12:00:00.000Z";
const NOW = new Date(AT);

function window(input: Partial<QuotaWindowInput> & { key: string }): QuotaWindowInput {
  return { observedAt: AT, ...input };
}

function quota(input: Partial<CliQuotaInput> = {}): CliQuota {
  return CliQuotaSchema.parse({ observedAt: AT, source: "turn", status: "allowed", ...input });
}

describe("CliQuotaSchema", () => {
  it("keeps only the fields it names, so an account id the CLI sent never passes", () => {
    const parsed = CliQuotaSchema.parse({
      observedAt: AT,
      source: "read",
      status: "allowed",
      accountId: "acct-should-not-pass",
      plan: "pro",
      windows: [{ key: "primary", observedAt: AT, usedPercent: 2, email: "x@example.com" }],
      credits: { hasCredits: true, unlimited: false, balance: "10", accountId: "acct" },
    });
    expect(JSON.stringify(parsed)).not.toContain("acct");
    expect(JSON.stringify(parsed)).not.toContain("example.com");
    expect(parsed.windows[0]).toEqual({
      key: "primary",
      minutes: null,
      usedPercent: 2,
      resetsAt: null,
      observedAt: AT,
    });
  });

  it("is optional on the runner record, the outcome, and the hello, for runners from before", () => {
    const runner = RunnerSchema.parse({
      name: "pod",
      os: "linux",
      clis: ["claude"],
      capabilities: [],
      status: "connected",
    });
    expect(runner.quotas).toBeUndefined();
    const hello = RunnerHelloSchema.parse({
      protocol: 1,
      version: "0.3.21",
      os: "linux",
      clis: ["claude"],
      slots: null,
    });
    expect(hello.quotaReads).toBe(false);
    const outcome = TurnOutcomeSchema.parse({
      exitReason: "completed",
      status: null,
      error: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
      session: "s",
      model: null,
      work: null,
    });
    expect(outcome.quota).toBeUndefined();
  });

  it("holds each CLI's quota on the runner record by CLI", () => {
    const runner = RunnerSchema.parse({
      name: "pod",
      os: "linux",
      clis: ["claude", "codex"],
      capabilities: [],
      status: "connected",
      quotas: { codex: quota({ windows: [window({ key: "primary", usedPercent: 2 })] }) },
    });
    expect(runner.quotas?.codex?.windows[0]?.usedPercent).toBe(2);
    expect(runner.quotas?.claude).toBeUndefined();
  });
});

describe("mergeQuota", () => {
  it("keeps windows the newer report leaves out, and the plan and credits it does not name", () => {
    const read = quota({
      source: "read",
      plan: "max",
      windows: [
        window({ key: "five_hour", usedPercent: 10 }),
        window({ key: "seven_day_opus", usedPercent: 40 }),
      ],
      extraUsage: { enabled: true, monthlyLimit: 5000, usedCredits: 120, currency: "USD" },
    });
    const later = "2026-10-13T12:30:00.000Z";
    const turn = quota({
      observedAt: later,
      status: "warning",
      windows: [window({ key: "five_hour", usedPercent: 35, observedAt: later })],
    });
    const merged = mergeQuota(read, turn);
    expect(merged.status).toBe("warning");
    expect(merged.source).toBe("turn");
    expect(merged.observedAt).toBe(later);
    expect(merged.plan).toBe("max");
    expect(merged.extraUsage?.usedCredits).toBe(120);
    expect(merged.windows.map((each) => [each.key, each.usedPercent, each.observedAt])).toEqual([
      ["five_hour", 35, later],
      ["seven_day_opus", 40, AT],
    ]);
  });

  it("takes the newer report whole when nothing was known", () => {
    const next = quota({ plan: "pro" });
    expect(mergeQuota(undefined, next)).toBe(next);
  });
});

describe("quotaLevel", () => {
  it("reads a limit as holding until its reset, and as over once the reset has passed", () => {
    const limited = quota({ status: "limited", limitedUntil: "2026-10-13T13:00:00.000Z" });
    expect(quotaLevel(limited, NOW)).toBe("limited");
    expect(quotaLevel(limited, new Date("2026-10-13T13:00:00.000Z"))).toBe("ok");
    expect(quotaLevel(quota({ status: "limited" }), NOW)).toBe("limited");
  });

  it("warns at 80% of a current window, or when the CLI warns", () => {
    const at = (usedPercent: number, resetsAt: string | null = null): CliQuota =>
      quota({ windows: [window({ key: "five_hour", usedPercent, resetsAt })] });
    expect(quotaLevel(at(79.9), NOW)).toBe("ok");
    expect(quotaLevel(at(80), NOW)).toBe("warning");
    // A window that has reset since it was read no longer counts.
    expect(quotaLevel(at(95, "2026-10-13T11:59:59.000Z"), NOW)).toBe("ok");
    // At its reset instant, a window has started afresh.
    expect(quotaLevel(at(95, AT), NOW)).toBe("ok");
    expect(quotaLevel(at(95, "2026-10-13T12:00:01.000Z"), NOW)).toBe("warning");
    expect(quotaLevel(quota({ status: "warning" }), NOW)).toBe("warning");
  });

  it("says when a login has no plan limits", () => {
    expect(quotaLevel(quota({ status: "none" }), NOW)).toBe("none");
  });
});

function name(input: Partial<QuotaWindowInput> & { key: string }): string {
  return windowName(quota({ windows: [window(input)] }).windows[0]!);
}

describe("windowName", () => {
  it("names Claude's windows by key and label, and Codex's by length", () => {
    expect(name({ key: "five_hour", minutes: 300 })).toBe("5h");
    expect(name({ key: "seven_day_opus", minutes: 10_080 })).toBe("7d Opus");
    expect(name({ key: "model:Fable", label: "Fable", minutes: 10_080 })).toBe("7d Fable");
    expect(name({ key: "primary", minutes: 10_080 })).toBe("7d");
    expect(name({ key: "secondary", minutes: 300 })).toBe("5h");
    expect(name({ key: "primary", minutes: 90 })).toBe("90m");
    expect(name({ key: "primary" })).toBe("primary");
  });
});

describe("quotaChanged and sameQuotaNumbers", () => {
  const base = quota({
    plan: "pro",
    windows: [window({ key: "primary", usedPercent: 2.2, resetsAt: "2026-10-20T05:11:58.000Z" })],
  });

  it("counts a whole percent, a reset minute, the status, or the credits as a change", () => {
    expect(quotaChanged(undefined, base)).toBe(true);
    expect(quotaChanged(base, quota({ ...base, observedAt: "2026-10-13T12:05:00.000Z" }))).toBe(
      false,
    );
    expect(
      quotaChanged(base, quota({ ...base, windows: [{ ...base.windows[0]!, usedPercent: 2.4 }] })),
    ).toBe(false);
    expect(
      quotaChanged(base, quota({ ...base, windows: [{ ...base.windows[0]!, usedPercent: 3 }] })),
    ).toBe(true);
    expect(
      quotaChanged(
        base,
        quota({
          ...base,
          windows: [{ ...base.windows[0]!, resetsAt: "2026-10-20T05:13:00.000Z" }],
        }),
      ),
    ).toBe(true);
    expect(quotaChanged(base, quota({ ...base, status: "limited" }))).toBe(true);
    expect(
      quotaChanged(
        base,
        quota({ ...base, credits: { hasCredits: true, unlimited: false, balance: "9" } }),
      ),
    ).toBe(true);
  });

  it("matches two runners' reports only on the same windows, percents, resets, and plan", () => {
    const other = quota({ ...base, observedAt: "2026-10-13T12:07:00.000Z", source: "read" });
    expect(sameQuotaNumbers(base, other)).toBe(true);
    expect(sameQuotaNumbers(base, quota({ ...other, plan: "plus" }))).toBe(false);
    // One runner's turn met the limit and the other has not run since: they report different things.
    expect(sameQuotaNumbers(base, quota({ ...other, status: "limited" }))).toBe(false);
    expect(
      sameQuotaNumbers(
        base,
        quota({ ...other, windows: [{ ...other.windows[0]!, usedPercent: 7 }] }),
      ),
    ).toBe(false);
    // Two reports with no windows say nothing about whose they are.
    expect(sameQuotaNumbers(quota(), quota())).toBe(false);
  });
});
