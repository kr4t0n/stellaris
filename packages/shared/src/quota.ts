import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";

/**
 * A CLI's plan quota as its login on one runner reports it: the rate-limit windows, how much of
 * each is used and when it starts afresh, and any credit balance. Adapters build it from what the
 * CLI streams during a turn or answers when asked, keeping only these fields, so an account id, an
 * email, or an upsell banner the CLI sends never leaves the adapter.
 */

/** A window used this much or more reads as a warning, short of the CLI saying so itself. */
export const QUOTA_WARNING_PERCENT = 80;

/** One rate-limit window of a CLI's plan. */
export const QuotaWindowSchema = z.object({
  /**
   * The CLI's own name for the window: Claude's `five_hour`, `seven_day`, `seven_day_opus`, and
   * `model:<label>` for a model's weekly window; Codex's `primary` and `secondary`.
   */
  key: z.string().min(1).max(80),
  /** What a scoped window counts, as the CLI labels it, such as a model's name. */
  label: z.string().min(1).max(80).optional(),
  /** The window's length in minutes, when known. */
  minutes: z.number().int().positive().nullable().default(null),
  /** How much of the window is used, in percent, or null when the CLI did not say. */
  usedPercent: z.number().nonnegative().nullable().default(null),
  /** When the window starts afresh, when known. */
  resetsAt: IsoDateTimeSchema.nullable().default(null),
  /** When the CLI last reported this window. */
  observedAt: IsoDateTimeSchema,
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;
export type QuotaWindowInput = z.input<typeof QuotaWindowSchema>;

/**
 * What the CLI says of the plan as a whole: `allowed`, `warning` when it warns of a limit near,
 * `limited` when it refuses work until a reset, and `none` for a login that reports no plan limits, such
 * as an API key.
 */
export const QuotaStatusSchema = z.enum(["allowed", "warning", "limited", "none"]);
export type QuotaStatus = z.infer<typeof QuotaStatusSchema>;

/** Codex's credits: whether the plan has any, whether they are unlimited, and the balance. */
export const QuotaCreditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.string().max(40).nullable(),
});
export type QuotaCredits = z.infer<typeof QuotaCreditsSchema>;

/** Claude's extra usage for the billing period, in minor units of `currency` (cents for USD). */
export const QuotaExtraUsageSchema = z.object({
  enabled: z.boolean(),
  monthlyLimit: z.number().nonnegative().nullable(),
  usedCredits: z.number().nonnegative().nullable(),
  currency: z.string().min(1).max(8).nullable(),
});
export type QuotaExtraUsage = z.infer<typeof QuotaExtraUsageSchema>;

export const CliQuotaSchema = z.object({
  /** When the CLI last reported anything here. */
  observedAt: IsoDateTimeSchema,
  /** Whether it came from a turn's stream or from asking the CLI. */
  source: z.enum(["turn", "read"]),
  status: QuotaStatusSchema,
  /** While `limited`: when work can go on, when known, and the window that stopped it. */
  limitedUntil: IsoDateTimeSchema.nullable().default(null),
  limitedBy: z.string().min(1).max(80).nullable().default(null),
  /** The plan's name as the CLI gives it, such as `max` or `pro`. */
  plan: z.string().min(1).max(40).nullable().default(null),
  windows: z.array(QuotaWindowSchema).max(24).default([]),
  credits: QuotaCreditsSchema.nullable().default(null),
  extraUsage: QuotaExtraUsageSchema.nullable().default(null),
});
export type CliQuota = z.infer<typeof CliQuotaSchema>;
export type CliQuotaInput = z.input<typeof CliQuotaSchema>;

/**
 * A newer report merged over what was known. A window keeps its last report until a newer one names
 * it, since a turn's stream carries only some of the windows a read lists and Codex sends sparse
 * updates; the plan, credits, and extra usage keep theirs when the newer report leaves them out.
 * The status is the newer report's.
 */
export function mergeQuota(previous: CliQuota | undefined, next: CliQuota): CliQuota {
  if (previous === undefined) {
    return next;
  }
  const windows = new Map(previous.windows.map((window) => [window.key, window]));
  for (const window of next.windows) {
    windows.set(window.key, window);
  }
  return {
    ...next,
    plan: next.plan ?? previous.plan,
    credits: next.credits ?? previous.credits,
    extraUsage: next.extraUsage ?? previous.extraUsage,
    windows: [...windows.values()],
  };
}

/** Whether a window still counts: one whose reset has passed has started afresh since it was read. */
export function windowCurrent(window: QuotaWindow, now: Date): boolean {
  return window.resetsAt === null || Date.parse(window.resetsAt) > now.getTime();
}

/**
 * How a CLI's quota reads now: `limited` while a limit holds, `warning` when the CLI warns or a
 * current window is at `QUOTA_WARNING_PERCENT` or more, `none` for a login without plan limits.
 */
export type QuotaLevel = "ok" | "warning" | "limited" | "none";

export function quotaLevel(quota: CliQuota, now: Date): QuotaLevel {
  if (quota.status === "none") {
    return "none";
  }
  if (
    quota.status === "limited" &&
    (quota.limitedUntil === null || Date.parse(quota.limitedUntil) > now.getTime())
  ) {
    return "limited";
  }
  const high = quota.windows.some(
    (window) =>
      windowCurrent(window, now) &&
      window.usedPercent !== null &&
      window.usedPercent >= QUOTA_WARNING_PERCENT,
  );
  return quota.status === "warning" || high ? "warning" : "ok";
}

const WINDOW_NAMES: Readonly<Record<string, string>> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "7d opus",
  seven_day_sonnet: "7d sonnet",
  seven_day_oauth_apps: "7d apps",
  seven_day_overage_included: "7d extra",
  overage: "extra usage",
};

/**
 * A window's short name in lowercase: Claude's by its key or label, a model's name as `7d fable`,
 * and Codex's by its length, as `5h` or `7d`.
 */
export function windowName(window: QuotaWindow): string {
  if (window.label !== undefined) {
    const label = window.label.toLowerCase();
    return window.minutes === 10_080 ? `7d ${label}` : label;
  }
  const named = WINDOW_NAMES[window.key];
  if (named !== undefined) {
    return named;
  }
  if (window.minutes !== null) {
    return window.minutes % 1_440 === 0
      ? `${window.minutes / 1_440}d`
      : window.minutes % 60 === 0
        ? `${window.minutes / 60}h`
        : `${window.minutes}m`;
  }
  return window.key;
}

/** What a reader compares two reports by: each window's whole percent and reset to the minute. */
function readings(quota: CliQuota): string {
  const windows = quota.windows
    .map(
      (window) =>
        `${window.key}=${window.usedPercent === null ? "?" : Math.round(window.usedPercent)}@${
          window.resetsAt === null ? "?" : Math.round(Date.parse(window.resetsAt) / 60_000)
        }`,
    )
    .toSorted();
  return windows.join(",");
}

/**
 * Whether a newer report changes what a reader would see: the status, the limit, the plan, the
 * credits, or a window's whole percent or reset minute. A report that only confirms the numbers
 * changes when they were seen and nothing else.
 */
export function quotaChanged(previous: CliQuota | undefined, next: CliQuota): boolean {
  if (previous === undefined) {
    return true;
  }
  return (
    previous.status !== next.status ||
    previous.limitedUntil !== next.limitedUntil ||
    previous.plan !== next.plan ||
    previous.credits?.balance !== next.credits?.balance ||
    previous.extraUsage?.usedCredits !== next.extraUsage?.usedCredits ||
    readings(previous) !== readings(next)
  );
}

/**
 * Whether two runners' reports of one CLI show the same numbers: the same plan, status, and limit,
 * and the same windows, each at the same whole percent and resetting the same minute. Two logins
 * rarely match like that, so the runners view shows such reports once, as most likely one login;
 * nothing reads an account's identity. A reset time is what makes a match telling, so reports
 * whose windows name none, as two idle logins' may, never match.
 */
export function sameQuotaNumbers(a: CliQuota, b: CliQuota): boolean {
  return (
    a.windows.some((window) => window.resetsAt !== null) &&
    a.plan === b.plan &&
    a.status === b.status &&
    a.limitedUntil === b.limitedUntil &&
    readings(a) === readings(b)
  );
}
