import { CliQuotaSchema, mergeQuota, type CliQuota } from "@stellaris/shared";
import { z } from "zod";

/**
 * Codex's plan quota from the app server: a `RateLimitSnapshot`, which `account/rateLimits/read`
 * answers and `account/rateLimits/updated` sends, sparsely, while turns run. The read's answer also
 * names the account; only the snapshot's windows, plan, credits, and limit are kept.
 */

const WindowSchema = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number().int().positive().nullable().optional(),
    resetsAt: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

const SnapshotSchema = z.object({
  primary: WindowSchema,
  secondary: WindowSchema,
  planType: z.string().min(1).max(40).nullable().optional(),
  rateLimitReachedType: z.string().min(1).max(80).nullable().optional(),
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().max(40).nullable().optional(),
    })
    .nullable()
    .optional(),
});

function fromEpoch(seconds: number | null | undefined): string | null {
  return seconds === null || seconds === undefined || !Number.isFinite(seconds)
    ? null
    : new Date(seconds * 1_000).toISOString();
}

/** A window as read, before the schema checks it. */
interface Reading {
  readonly key: string;
  readonly minutes: number | null;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly observedAt: string;
}

/** The quota a snapshot reports, or null for one that does not parse. */
export function quotaFromSnapshot(
  raw: unknown,
  at: Date,
  source: "turn" | "read",
): CliQuota | null {
  const parsed = SnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const snapshot = parsed.data;
  const observedAt = at.toISOString();
  const windows: Reading[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const window = snapshot[key];
    if (window === null || window === undefined) {
      continue;
    }
    windows.push({
      key,
      minutes: window.windowDurationMins ?? null,
      usedPercent: Math.max(0, window.usedPercent),
      resetsAt: fromEpoch(window.resetsAt),
      observedAt,
    });
  }
  // Work goes on once the last window used up resets.
  const binding = windows
    .filter((window) => window.usedPercent >= 100)
    .toSorted((a, b) => (b.resetsAt ?? "").localeCompare(a.resetsAt ?? ""))[0];
  const reached = snapshot.rateLimitReachedType ?? null;
  const limited = binding !== undefined || reached !== null;
  const credits = snapshot.credits;
  return CliQuotaSchema.parse({
    observedAt,
    source,
    status: limited ? "limited" : "allowed",
    limitedUntil: binding?.resetsAt ?? null,
    limitedBy: limited ? (binding?.key ?? reached) : null,
    plan: snapshot.planType ?? null,
    windows,
    credits:
      credits === null || credits === undefined
        ? null
        : {
            hasCredits: credits.hasCredits,
            unlimited: credits.unlimited,
            balance: credits.balance ?? null,
          },
  });
}

/**
 * A snapshot merged over what was known. The app server's rolling updates are sparse, so one that
 * names no window and no limit says nothing about the limit, which stays as it was.
 */
export function mergeSnapshot(
  known: CliQuota | undefined,
  raw: unknown,
  at: Date,
  source: "turn" | "read",
): CliQuota | undefined {
  const next = quotaFromSnapshot(raw, at, source);
  if (next === null) {
    return known;
  }
  const merged = mergeQuota(known, next);
  if (known !== undefined && next.windows.length === 0 && next.limitedBy === null) {
    return {
      ...merged,
      status: known.status,
      limitedUntil: known.limitedUntil,
      limitedBy: known.limitedBy,
    };
  }
  return merged;
}

/**
 * The answer to `account/rateLimits/read`: its single-bucket `rateLimits` snapshot, limited when the
 * backend says ordinary usage is not allowed. A login without plan limits, as an API key, reads as
 * `none`.
 */
export function quotaFromRead(raw: unknown, at: Date): CliQuota {
  const answer = typeof raw === "object" && raw !== null ? raw : {};
  const quota = quotaFromSnapshot(Reflect.get(answer, "rateLimits"), at, "read");
  if (quota === null || (quota.windows.length === 0 && quota.plan === null)) {
    return CliQuotaSchema.parse({ observedAt: at.toISOString(), source: "read", status: "none" });
  }
  if (Reflect.get(answer, "ordinaryUsageAllowed") === false && quota.status !== "limited") {
    return { ...quota, status: "limited" };
  }
  return quota;
}

/** A turn Codex ended for the plan's usage limit: limited from then on, until a window resets. */
export function limitedQuota(known: CliQuota | undefined, at: Date): CliQuota {
  if (known?.status === "limited") {
    return known;
  }
  return mergeQuota(
    known,
    CliQuotaSchema.parse({ observedAt: at.toISOString(), source: "turn", status: "limited" }),
  );
}

/** Whether an app-server error says the plan's usage limit ended the turn. */
export function isUsageLimit(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "codexErrorInfo") === "usageLimitExceeded"
  );
}
