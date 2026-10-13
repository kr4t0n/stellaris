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
  limitId: z.string().min(1).max(40).nullable().optional(),
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

/** A time as an ISO string, or null for one that is no date or out of an ISO string's years. */
function fromEpoch(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return null;
  }
  const date = new Date(seconds * 1_000);
  const year = date.getUTCFullYear();
  return Number.isNaN(date.getTime()) || year < 1970 || year > 9999 ? null : date.toISOString();
}

/** The bucket every snapshot so far has come from; another bucket's windows are named by it. */
const MAIN_BUCKET = "codex";

function isScopedBucket(limitId: unknown): limitId is string {
  return typeof limitId === "string" && limitId !== MAIN_BUCKET;
}

/** A window as read, before the schema checks it. */
interface Reading {
  readonly key: string;
  readonly minutes: number | null;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly observedAt: string;
}

/**
 * The quota a snapshot reports, or null for one that does not parse or falls outside what a quota
 * may hold, so an app-server release that changes the snapshot costs its report, never the turn. A
 * snapshot of a bucket other than the main one, by its `limitId`, names its windows
 * `<limitId>:primary` and `<limitId>:secondary`, so its rolling updates never overwrite the main
 * bucket's, and a limit there is a warning: it stops what that bucket meters, not the login.
 */
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
  const scoped = isScopedBucket(snapshot.limitId);
  const bucket = scoped ? `${snapshot.limitId}:` : "";
  for (const key of ["primary", "secondary"] as const) {
    const window = snapshot[key];
    if (window === null || window === undefined) {
      continue;
    }
    windows.push({
      key: `${bucket}${key}`,
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
  const spent = binding !== undefined || reached !== null;
  const limited = spent && !scoped;
  const credits = snapshot.credits;
  const parsedQuota = CliQuotaSchema.safeParse({
    observedAt,
    source,
    status: limited ? "limited" : spent ? "warning" : "allowed",
    limitedUntil: limited ? (binding?.resetsAt ?? null) : null,
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
  return parsedQuota.success ? parsedQuota.data : null;
}

/**
 * A snapshot merged over what was known. The app server's rolling updates are sparse, so one that
 * names no window and no limit says nothing about the login's limit, which stays as it was, and
 * nor does one of another bucket.
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
  const scoped =
    typeof raw === "object" && raw !== null && isScopedBucket(Reflect.get(raw, "limitId"));
  if (known !== undefined && (scoped || (next.windows.length === 0 && next.limitedBy === null))) {
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
 * backend says ordinary usage is not allowed. A login that reports no plan limits, as an API key,
 * reads as `none`; a snapshot this adapter cannot read fails the read, and nothing else.
 */
export function quotaFromRead(raw: unknown, at: Date): CliQuota {
  const answer = typeof raw === "object" && raw !== null ? raw : {};
  const snapshot: unknown = Reflect.get(answer, "rateLimits");
  const quota =
    snapshot === null || snapshot === undefined ? null : quotaFromSnapshot(snapshot, at, "read");
  if (snapshot !== null && snapshot !== undefined && quota === null) {
    throw new Error("Codex answered its rate limits in a shape this runner cannot read");
  }
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
