import { describe, expect, it } from "vitest";
import {
  CliQuotaSchema,
  lapsedLimit,
  limitHold,
  limitLapsed,
  mergeQuota,
  poolHolds,
  quotaChanged,
  quotaLevel,
  quotaPool,
  sameQuotaNumbers,
  windowName,
  windowPool,
  type CliQuota,
  type CliQuotaInput,
  type QuotaWindowInput,
} from "./quota.js";
import {
  heldOn,
  RunnerHelloSchema,
  RunnerSchema,
  runnerSyncing,
  syncedFiles,
  TurnOutcomeSchema,
  type Runner,
} from "./index.js";

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

describe("limitHold", () => {
  it("holds a CLI's turns until the reset its limit gave, and not from that instant", () => {
    const limited = quota({ status: "limited", limitedUntil: "2026-10-13T13:00:00.000Z" });
    expect(limitHold(limited, NOW)).toEqual({ until: "2026-10-13T13:00:00.000Z", known: true });
    expect(limitHold(limited, new Date("2026-10-13T12:59:59.999Z"))).not.toBeNull();
    expect(limitHold(limited, new Date("2026-10-13T13:00:00.000Z"))).toBeNull();
  });

  it("holds a limit with no reset for half an hour from its report", () => {
    const limited = quota({ status: "limited" });
    expect(limitHold(limited, NOW)).toEqual({ until: "2026-10-13T12:30:00.000Z", known: false });
    expect(limitHold(limited, new Date("2026-10-13T12:29:59.999Z"))).not.toBeNull();
    expect(limitHold(limited, new Date("2026-10-13T12:30:00.000Z"))).toBeNull();
    // Still read as limited all the same, as the CLI said, and lapsed: one turn may try it.
    const lapsedAt = new Date("2026-10-13T12:30:00.000Z");
    expect(quotaLevel(limited, lapsedAt)).toBe("limited");
    expect(limitLapsed(limited, NOW)).toBe(false);
    expect(limitLapsed(limited, lapsedAt)).toBe(true);
    // A limit with a reset never lapses so: at the reset it has lifted.
    const known = quota({ status: "limited", limitedUntil: "2026-10-13T13:00:00.000Z" });
    expect(limitLapsed(known, new Date("2026-10-13T13:00:00.000Z"))).toBe(false);
  });

  it("holds nothing short of a limit, nor a usage read's limit with extra usage turned on", () => {
    for (const status of ["allowed", "warning", "none"] as const) {
      expect(limitHold(quota({ status }), NOW)).toBeNull();
      expect(limitLapsed(quota({ status }), new Date("2026-10-13T13:00:00.000Z"))).toBe(false);
    }
    const extra = {
      source: "read",
      status: "limited",
      limitedUntil: "2026-10-13T13:00:00.000Z",
      extraUsage: { enabled: true, monthlyLimit: 5_000, usedCredits: 0, currency: "USD" },
    } as const;
    expect(limitHold(quota(extra), NOW)).toBeNull();
    expect(
      limitHold(quota({ ...extra, extraUsage: { ...extra.extraUsage, enabled: false } }), NOW),
    ).not.toBeNull();
    // A turn's own limit already leaves out what extra usage covered, so it holds, extra usage on.
    expect(limitHold(quota({ ...extra, source: "turn" }), NOW)).toEqual({
      until: "2026-10-13T13:00:00.000Z",
      known: true,
    });
  });

  it("holds the turns of the CLI it limits on its runner, beside the user's pauses", () => {
    const pod: Runner = RunnerSchema.parse({
      name: "pod",
      os: "linux",
      clis: ["claude", "codex"],
      capabilities: [],
      status: "connected",
      quotas: { claude: quota({ status: "limited", limitedUntil: "2026-10-13T13:00:00.000Z" }) },
    });
    expect(heldOn([pod], "pod", { cli: "claude" }, NOW)).toBe(true);
    expect(heldOn([pod], "pod", { cli: "codex" }, NOW)).toBe(false);
    expect(heldOn([pod], "pod", { cli: "claude" }, new Date("2026-10-13T13:00:00.000Z"))).toBe(
      false,
    );
    expect(heldOn([pod], undefined, { cli: "claude" }, NOW)).toBe(false);
    const paused = { ...pod, pausedClis: { codex: { at: AT, by: "user" } } };
    expect(heldOn([paused], "pod", { cli: "codex" }, NOW)).toBe(true);
  });

  it("holds every CLI of a connected runner while it syncs its board copy, and nothing once it is done or away", () => {
    const sync = {
      phase: "copying" as const,
      files: 6_200,
      totalFiles: 15_152,
      bytes: 11_000_000,
      totalBytes: 27_000_000,
      attempt: 1,
      startedAt: AT,
      updatedAt: AT,
    };
    const pod: Runner = RunnerSchema.parse({
      name: "pod",
      os: "linux",
      clis: ["claude", "codex"],
      capabilities: [],
      status: "connected",
      sync,
    });
    expect(runnerSyncing(pod)).toEqual(sync);
    expect(heldOn([pod], "pod", { cli: "claude" }, NOW)).toBe(true);
    expect(heldOn([pod], "pod", { cli: "codex" }, NOW)).toBe(true);
    for (const settled of [
      { ...pod, sync: { ...sync, phase: "done" as const, finishedAt: AT } },
      { ...pod, status: "disconnected" as const },
      { ...pod, sync: undefined },
    ]) {
      expect(runnerSyncing(settled)).toBeUndefined();
      expect(heldOn([settled], "pod", { cli: "claude" }, NOW)).toBe(false);
    }
    expect(syncedFiles(sync)).toBe("6,200 / 15,152 files");
    expect(syncedFiles({ ...sync, files: 1_234_567, totalFiles: null })).toBe("1,234,567 files");
    expect(syncedFiles({ ...sync, phase: "starting", files: 0, totalFiles: null })).toBeNull();
    expect(syncedFiles({ ...sync, phase: "listing", files: 0, totalFiles: null })).toBeNull();
  });
});

/**
 * Antigravity's pools as its read names them, and a turn's refusal of one: the shapes of one
 * login on 2026-11-26, where a third-party refusal left the Gemini models running.
 */
describe("pools", () => {
  const open = quota({
    source: "read",
    status: "allowed",
    pools: [
      { key: "gemini", label: "Gemini Models", limited: false, observedAt: AT },
      { key: "3p", label: "Claude and GPT models", limited: false, observedAt: AT },
    ],
  });
  const refused = (key: string, limitedUntil: string | null, at: string = AT): CliQuota =>
    quota({
      observedAt: at,
      status: "warning",
      pools: [{ key, limited: true, limitedUntil, observedAt: at }],
    });
  const RESET = "2026-10-13T15:50:00.000Z";

  it("names Antigravity's pool by the citizen's model, Gemini's with none set, and none for the other CLIs", () => {
    expect(quotaPool("antigravity", "gemini-4-neon")).toBe("gemini");
    expect(quotaPool("antigravity", "gemini-3.8-flash")).toBe("gemini");
    expect(quotaPool("antigravity", undefined)).toBe("gemini");
    expect(quotaPool("antigravity", "claude-sonnet-4-6")).toBe("3p");
    expect(quotaPool("antigravity", "gpt-oss-120b")).toBe("3p");
    expect(quotaPool("claude", "opus")).toBeNull();
    expect(quotaPool("codex", "gpt-6-astra")).toBeNull();
    expect(quotaPool(null, undefined)).toBeNull();
  });

  it("holds a pool's turns until its reset while the other pool's go", () => {
    const limited = mergeQuota(open, refused("3p", RESET));
    expect(limitHold(limited, NOW, "3p")).toEqual({ until: RESET, known: true });
    expect(limitHold(limited, NOW, "gemini")).toBeNull();
    expect(limitHold(limited, NOW)).toBeNull();
    expect(limitHold(limited, new Date(RESET), "3p")).toBeNull();
    // The read's label stays on the pool the refusal named by its key alone.
    expect(poolHolds(limited, NOW)).toEqual([
      { pool: "3p", label: "Claude and GPT models", until: RESET, known: true },
    ]);
    expect(quotaChanged(open, limited)).toBe(true);
    expect(quotaChanged(limited, mergeQuota(limited, refused("3p", RESET)))).toBe(false);
  });

  it("keeps a pool's limit through a read until a read finds that pool clear", () => {
    const limited = mergeQuota(open, refused("3p", RESET));
    // A read that names the other pool spent, or this one still spent, leaves it held.
    const geminiSpent = quota({
      source: "read",
      status: "warning",
      pools: [{ key: "gemini", limited: true, limitedUntil: RESET, observedAt: AT }],
    });
    expect(limitHold(mergeQuota(limited, geminiSpent), NOW, "3p")).toEqual({
      until: RESET,
      known: true,
    });
    const bothSpent = quota({
      source: "read",
      status: "limited",
      limitedUntil: "2026-10-13T14:00:00.000Z",
      pools: [
        { key: "gemini", limited: true, limitedUntil: "2026-10-13T14:00:00.000Z", observedAt: AT },
        { key: "3p", limited: true, limitedUntil: RESET, observedAt: AT },
      ],
    });
    // The login frees with the first pool, while the other's stays held to its own reset.
    const afterBoth = mergeQuota(limited, bothSpent);
    expect(limitHold(afterBoth, new Date("2026-10-13T14:00:00.000Z"), "gemini")).toBeNull();
    expect(limitHold(afterBoth, new Date("2026-10-13T14:00:00.000Z"), "3p")).toEqual({
      until: RESET,
      known: true,
    });
    // A read that finds the pool clear lifts it.
    expect(limitHold(mergeQuota(limited, open), NOW, "3p")).toBeNull();
  });

  it("holds every pool while the whole login is limited, as a refusal naming no pool it knows reports", () => {
    const login = quota({ status: "limited", limitedUntil: RESET });
    expect(limitHold(login, NOW, "gemini")).toEqual({ until: RESET, known: true });
    expect(limitHold(login, NOW, "3p")).toEqual({ until: RESET, known: true });
    // While both hold, the later end does.
    const later = mergeQuota(refused("3p", "2026-10-13T18:00:00.000Z"), login);
    expect(limitHold(later, NOW, "3p")).toEqual({ until: "2026-10-13T18:00:00.000Z", known: true });
  });

  it("lets one turn try a pool's limit with no reset once its half hour is over, by that report", () => {
    const limited = mergeQuota(open, refused("3p", null));
    expect(limitHold(limited, NOW, "3p")).toEqual({
      until: "2026-10-13T12:30:00.000Z",
      known: false,
    });
    const lapsedAt = new Date("2026-10-13T12:30:00.000Z");
    expect(lapsedLimit(limited, NOW, "3p")).toBeNull();
    expect(lapsedLimit(limited, lapsedAt, "3p")).toEqual({ key: "3p", observedAt: AT });
    expect(limitLapsed(limited, lapsedAt, "gemini")).toBe(false);
    expect(limitLapsed(limited, lapsedAt)).toBe(false);
    // The login's own lapse is keyed apart from any pool's.
    expect(lapsedLimit(quota({ status: "limited" }), lapsedAt, "3p")).toEqual({
      key: "",
      observedAt: AT,
    });
  });

  it("holds a citizen's turns on a runner by its model's pool", () => {
    const pod: Runner = RunnerSchema.parse({
      name: "pod",
      os: "linux",
      clis: ["claude", "antigravity"],
      capabilities: [],
      status: "connected",
      quotas: { antigravity: mergeQuota(open, refused("3p", RESET)) },
    });
    expect(heldOn([pod], "pod", { cli: "antigravity", model: "claude-sonnet-4-6" }, NOW)).toBe(
      true,
    );
    expect(heldOn([pod], "pod", { cli: "antigravity", model: "gemini-4-neon" }, NOW)).toBe(false);
    expect(heldOn([pod], "pod", { cli: "antigravity" }, NOW)).toBe(false);
    expect(heldOn([pod], "pod", { cli: "claude", model: "claude-sonnet-4-6" }, NOW)).toBe(false);
    // A CLI with no pools holds every citizen on it, whatever its model, as before pools.
    const claude = {
      ...pod,
      quotas: { claude: quota({ status: "limited", limitedUntil: RESET }) },
    };
    for (const model of [undefined, "opus", "gemini-4-neon"]) {
      expect(heldOn([claude], "pod", { cli: "claude", model }, NOW)).toBe(true);
    }
  });

  it("reads a citizen's level by its model's pool: its own limit, and only the login's windows and its own pool's", () => {
    // A read with the third-party pool spent, which warns for the login as a whole.
    const thirdPartySpent = (gemini5h: number): CliQuota =>
      quota({
        source: "read",
        status: "warning",
        windows: [
          window({ key: "gemini-5h", usedPercent: gemini5h, resetsAt: "2026-10-13T14:00:00.000Z" }),
          window({ key: "3p-5h", usedPercent: 100, resetsAt: RESET }),
        ],
        pools: [
          { key: "gemini", limited: false, observedAt: AT },
          { key: "3p", limited: true, limitedUntil: RESET, limitedBy: "3p-5h", observedAt: AT },
        ],
      });
    const spent = thirdPartySpent(30);
    expect(windowPool(spent, spent.windows[0]!)).toBe("gemini");
    expect(windowPool(spent, spent.windows[1]!)).toBe("3p");
    expect(quotaLevel(spent, NOW)).toBe("warning");
    expect(quotaLevel(spent, NOW, "3p")).toBe("limited");
    expect(quotaLevel(spent, NOW, "gemini")).toBe("ok");
    expect(quotaLevel(thirdPartySpent(80), NOW, "gemini")).toBe("warning");
    // A pool spent with no reset holds, and so reads, for half an hour from its report.
    const unknown = mergeQuota(open, refused("3p", null));
    expect(quotaLevel(unknown, new Date("2026-10-13T12:29:59.000Z"), "3p")).toBe("limited");
    expect(quotaLevel(unknown, new Date("2026-10-13T12:30:00.000Z"), "3p")).toBe("warning");
    expect(quotaLevel(unknown, NOW, "gemini")).toBe("ok");
    // The login's own warning, with no pool spent, and its limit read for every pool.
    expect(quotaLevel(quota({ status: "warning", pools: open.pools }), NOW, "gemini")).toBe(
      "warning",
    );
    expect(quotaLevel(quota({ status: "limited", limitedUntil: RESET }), NOW, "gemini")).toBe(
      "limited",
    );
    // A window whose stem names no pool the quota reports is the login's, as every window is of a
    // report with no pools, such as a runner's from before pools.
    const before = quota({ status: "warning", windows: spent.windows });
    expect(windowPool(before, before.windows[1]!)).toBeNull();
    expect(quotaLevel(before, NOW, "gemini")).toBe("warning");
    const claude = quota({ windows: [window({ key: "five_hour" })] });
    expect(windowPool(claude, claude.windows[0]!)).toBeNull();
  });
});

function name(input: Partial<QuotaWindowInput> & { key: string }): string {
  return windowName(quota({ windows: [window(input)] }).windows[0]!);
}

describe("windowName", () => {
  it("names Claude's windows by key and label, and Codex's by length", () => {
    expect(name({ key: "five_hour", minutes: 300 })).toBe("5h");
    expect(name({ key: "seven_day_opus", minutes: 10_080 })).toBe("7d opus");
    // A model's name, as the CLI gives it, reads in lowercase like the rest.
    expect(name({ key: "model:Fable", label: "Fable", minutes: 10_080 })).toBe("7d fable");
    expect(name({ key: "model:Fable", label: "Fable", minutes: 1_440 })).toBe("fable");
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
    // Two reports with no windows say nothing about whose they are, nor do idle windows with no reset.
    expect(sameQuotaNumbers(quota(), quota())).toBe(false);
    const idle = quota({ windows: [window({ key: "five_hour", usedPercent: 0 })] });
    expect(sameQuotaNumbers(idle, quota({ ...idle }))).toBe(false);
  });
});
