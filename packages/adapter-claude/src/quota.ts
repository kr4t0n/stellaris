import { CliQuotaSchema, mergeQuota, type CliQuota } from "@stellaris/shared";
import { z } from "zod";

/**
 * Claude Code's plan quota, from the two places it reports one: the `rate_limit_event` a turn
 * streams when the rate-limit state changes, and the usage read behind `/usage`. Only plan limits
 * of a claude.ai login show up; an API key, Bedrock, or Vertex reports none.
 */

/** A window as read, before the schema checks it. */
interface Reading {
  readonly key: string;
  readonly label?: string;
  readonly minutes: number | null;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
  readonly observedAt: string;
}

const MINUTES: Readonly<Record<string, number>> = { five_hour: 300 };
const WEEK = 10_080;

/**
 * The windows that count every model's use, so the login stops when one of them is spent. A
 * scoped window, such as `seven_day_opus` or a model's own weekly window, stops only its model,
 * and turns on the others go on.
 */
const LOGIN_WINDOWS: ReadonlySet<string> = new Set(["five_hour", "seven_day"]);

function minutesOf(key: string): number | null {
  return MINUTES[key] ?? (key.startsWith("seven_day") || key.startsWith("model:") ? WEEK : null);
}

/** A time as an ISO string, or null for one that is no date or out of an ISO string's years. */
function isoAt(ms: number): string | null {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  return Number.isNaN(date.getTime()) || year < 1970 || year > 9999 ? null : date.toISOString();
}

function fromEpoch(seconds: number | undefined): string | null {
  return seconds === undefined || !Number.isFinite(seconds) ? null : isoAt(seconds * 1_000);
}

function fromIso(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : isoAt(Date.parse(value));
}

/**
 * The event's `rate_limit_info`, read loosely: `unifiedWindows` is not in the SDK's public type, and
 * each window's `utilization` there is a fraction of one, as the CLI reads it from the API's
 * `anthropic-ratelimit-unified-*-utilization` headers.
 */
const RateLimitInfoSchema = z.object({
  status: z.enum(["allowed", "allowed_warning", "rejected"]),
  resetsAt: z.number().optional(),
  rateLimitType: z.string().min(1).max(80).optional(),
  overageStatus: z.string().optional(),
  isUsingOverage: z.boolean().optional(),
  unifiedWindows: z
    .record(
      z.string().min(1).max(80),
      z.object({ utilization: z.number().optional(), resetsAt: z.number().optional() }),
    )
    .optional(),
});

/**
 * The quota a turn's `rate_limit_event` reports, or null for one that does not parse or falls
 * outside what a quota may hold, so a CLI release that changes the event costs its report, never
 * the turn. A refusal limits the login only when it names a window every model counts and no extra
 * usage covers it; one of a scoped window, or one extra usage takes over, is a warning, with the
 * window shown used up.
 */
export function quotaFromRateLimit(raw: unknown, at: Date): CliQuota | null {
  const parsed = RateLimitInfoSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const info = parsed.data;
  const observedAt = at.toISOString();
  const windows: Reading[] = Object.entries(info.unifiedWindows ?? {}).map(([key, window]) => ({
    key,
    minutes: minutesOf(key),
    usedPercent: window.utilization === undefined ? null : Math.max(0, window.utilization * 100),
    resetsAt: fromEpoch(window.resetsAt),
    observedAt,
  }));
  const rejected = info.status === "rejected";
  // The window that binds is named even when the event lists no windows of its own.
  if (
    info.rateLimitType !== undefined &&
    !windows.some((window) => window.key === info.rateLimitType)
  ) {
    windows.push({
      key: info.rateLimitType,
      minutes: minutesOf(info.rateLimitType),
      usedPercent: rejected ? 100 : null,
      resetsAt: fromEpoch(info.resetsAt),
      observedAt,
    });
  }
  const overage =
    info.isUsingOverage === true ||
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning";
  const limited =
    rejected &&
    !overage &&
    (info.rateLimitType === undefined || LOGIN_WINDOWS.has(info.rateLimitType));
  const parsedQuota = CliQuotaSchema.safeParse({
    observedAt,
    source: "turn",
    status: limited
      ? "limited"
      : rejected || info.status === "allowed_warning"
        ? "warning"
        : "allowed",
    limitedUntil: limited ? fromEpoch(info.resetsAt) : null,
    limitedBy: limited ? (info.rateLimitType ?? null) : null,
    windows,
  });
  return parsedQuota.success ? parsedQuota.data : null;
}

/**
 * A turn the API refused for the plan's limit: the CLI ends it with a synthetic assistant message
 * marked `rate_limit`, whose text says when the limit lifts. The quota is limited from then on,
 * until the reset a `rejected` rate-limit event gave, when it gave one.
 */
export function limitedQuota(known: CliQuota | undefined, at: Date): CliQuota {
  if (known?.status === "limited") {
    return known;
  }
  return mergeQuota(
    known,
    CliQuotaSchema.parse({
      observedAt: at.toISOString(),
      source: "turn",
      status: "limited",
    }),
  );
}

const UsageWindowSchema = z
  .object({ utilization: z.number().nullable(), resets_at: z.string().nullable() })
  .nullable()
  .optional();

/**
 * The usage read's answer (`SDKControlGetUsageResponse`), read loosely since the SDK marks it
 * experimental: its windows' `utilization` is already a percentage.
 */
const UsageReadSchema = z.object({
  subscription_type: z.string().min(1).max(40).nullable().optional(),
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: UsageWindowSchema,
      seven_day: UsageWindowSchema,
      seven_day_oauth_apps: UsageWindowSchema,
      seven_day_opus: UsageWindowSchema,
      seven_day_sonnet: UsageWindowSchema,
      model_scoped: z
        .array(
          z.object({
            display_name: z.string().min(1).max(60),
            utilization: z.number().nullable(),
            resets_at: z.string().nullable(),
          }),
        )
        .optional(),
      extra_usage: z
        .object({
          is_enabled: z.boolean(),
          monthly_limit: z.number().nullable(),
          used_credits: z.number().nullable(),
          currency: z.string().min(1).max(8).nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
});

const READ_WINDOWS = [
  "five_hour",
  "seven_day",
  "seven_day_oauth_apps",
  "seven_day_opus",
  "seven_day_sonnet",
] as const;

/**
 * The quota the usage read reports; a login that reports no plan limits, as an API key or a login
 * without the profile scope, reads as `none`. Throws on an answer it cannot read, which fails the
 * read and nothing else.
 */
export function quotaFromUsage(raw: unknown, at: Date): CliQuota {
  const read = UsageReadSchema.parse(raw);
  const observedAt = at.toISOString();
  const limits = read.rate_limits;
  if (!read.rate_limits_available || limits === null) {
    return CliQuotaSchema.parse({ observedAt, source: "read", status: "none" });
  }
  const windows: Reading[] = [];
  for (const key of READ_WINDOWS) {
    const window = limits[key];
    if (window === null || window === undefined) {
      continue;
    }
    windows.push({
      key,
      minutes: minutesOf(key),
      usedPercent: window.utilization === null ? null : Math.max(0, window.utilization),
      resetsAt: fromIso(window.resets_at),
      observedAt,
    });
  }
  for (const row of limits.model_scoped ?? []) {
    windows.push({
      key: `model:${row.display_name}`,
      label: row.display_name,
      minutes: WEEK,
      usedPercent: row.utilization === null ? null : Math.max(0, row.utilization),
      resetsAt: fromIso(row.resets_at),
      observedAt,
    });
  }
  // The read has no status of its own: a window every model counts, used up, is a limit until it
  // resets. A scoped window used up stops only its model, and shows on its own meter.
  const spent = windows
    .filter(
      (window) =>
        LOGIN_WINDOWS.has(window.key) && window.usedPercent !== null && window.usedPercent >= 100,
    )
    .toSorted((a, b) => (b.resetsAt ?? "").localeCompare(a.resetsAt ?? ""));
  const binding = spent[0];
  const extra = limits.extra_usage;
  return CliQuotaSchema.parse({
    observedAt,
    source: "read",
    status: binding === undefined ? "allowed" : "limited",
    limitedUntil: binding?.resetsAt ?? null,
    limitedBy: binding?.key ?? null,
    plan: read.subscription_type ?? null,
    windows,
    extraUsage:
      extra === null || extra === undefined
        ? null
        : {
            enabled: extra.is_enabled,
            monthlyLimit: extra.monthly_limit,
            usedCredits: extra.used_credits,
            currency: extra.currency ?? null,
          },
  });
}
