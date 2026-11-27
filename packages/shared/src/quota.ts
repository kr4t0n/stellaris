import { z } from "zod";
import type { CliKind } from "./board.js";
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

/**
 * A pool of a CLI's models that share their windows apart from its other models, so the CLI can
 * refuse one pool's models while the others run: Antigravity's Gemini models and its third-party
 * ones, Claude and GPT. `quotaPool` names the pool a citizen's turns draw from.
 */
export const QuotaPoolSchema = z.object({
  /** The pool's key, as `quotaPool` gives it: `gemini` or `3p` for Antigravity. */
  key: z.string().min(1).max(40),
  /** What the CLI calls the pool, such as `Claude and GPT models`. */
  label: z.string().min(1).max(80).optional(),
  /** Whether the CLI refuses the pool's models until a reset. */
  limited: z.boolean(),
  /** While limited: when the pool's models can run again, when known, and the window that stopped them. */
  limitedUntil: IsoDateTimeSchema.nullable().default(null),
  limitedBy: z.string().min(1).max(80).nullable().default(null),
  /** When the CLI last reported the pool. */
  observedAt: IsoDateTimeSchema,
});
export type QuotaPool = z.infer<typeof QuotaPoolSchema>;
export type QuotaPoolInput = z.input<typeof QuotaPoolSchema>;

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
  /**
   * Each pool the CLI reported, for a CLI whose models draw from pools apart: a read names every
   * pool, and a turn the CLI refused for one pool's quota names that pool alone. Absent for a CLI
   * whose models share one quota, so Claude's and Codex's reports keep their shape. A server from
   * before drops the field, and a runner from before never sends it.
   */
  pools: z.array(QuotaPoolSchema).max(8).optional(),
});
export type CliQuota = z.infer<typeof CliQuotaSchema>;
export type CliQuotaInput = z.input<typeof CliQuotaSchema>;

/**
 * A newer report merged over what was known. A window keeps its last report until a newer one names
 * it, since a turn's stream carries only some of the windows a read lists and Codex sends sparse
 * updates, and a pool keeps its own the same way, since a turn the CLI refused names its own pool
 * alone; the plan, credits, and extra usage keep theirs when the newer report leaves them out.
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
  const pools = new Map((previous.pools ?? []).map((pool) => [pool.key, pool]));
  for (const pool of next.pools ?? []) {
    // A turn's refusal names its pool by key alone; the label a read gave stays.
    const label = pool.label ?? pools.get(pool.key)?.label;
    pools.set(pool.key, label === undefined ? pool : { ...pool, label });
  }
  return {
    ...next,
    plan: next.plan ?? previous.plan,
    credits: next.credits ?? previous.credits,
    extraUsage: next.extraUsage ?? previous.extraUsage,
    windows: [...windows.values()],
    ...(pools.size === 0 ? {} : { pools: [...pools.values()] }),
  };
}

/** Antigravity's pools: its Gemini models, and the rest, which it calls third-party (Claude, GPT). */
export const ANTIGRAVITY_POOLS = { gemini: "gemini", thirdParty: "3p" } as const;

/**
 * The pool a citizen's turns on `cli` draw from, by the citizen's model, or null for a CLI whose
 * models share one quota, as Claude's and Codex's do. Antigravity meters its Gemini models apart
 * from its third-party ones and picks a Gemini model when none is set, so a model named `gemini-…`,
 * or none, is `gemini`, and any other `3p`. The keys are the stems of agy's own bucket ids
 * (`gemini-5h`, `3p-weekly`).
 */
export function quotaPool(cli: CliKind | null, model: string | null | undefined): string | null {
  if (cli !== "antigravity") {
    return null;
  }
  return model === undefined || model === null || model === "" || model.startsWith("gemini-")
    ? ANTIGRAVITY_POOLS.gemini
    : ANTIGRAVITY_POOLS.thirdParty;
}

/**
 * A pool's key from its bucket's id: the id's stem before its last `-`, as `gemini` of
 * `gemini-weekly` and `3p` of `3p-5h`, which `quotaPool` keys a model's pool by; an id with no
 * stem is its own key.
 */
export function poolKeyOf(bucket: string): string {
  const dash = bucket.lastIndexOf("-");
  return dash > 0 ? bucket.slice(0, dash) : bucket;
}

/**
 * The pool whose models a window counts, of those the quota reports: the one its key's stem names
 * (`poolKeyOf`), as a bucket of agy's is keyed, or null for a window of the login as a whole, as
 * every window of a CLI without pools is.
 */
export function windowPool(quota: CliQuota, window: QuotaWindow): string | null {
  const key = poolKeyOf(window.key);
  return quota.pools?.some((pool) => pool.key === key) === true ? key : null;
}

/** Whether a window counts for a citizen whose model draws from `pool`: the login's, or its pool's. */
export function windowCounts(quota: CliQuota, window: QuotaWindow, pool: string | null): boolean {
  if (pool === null) {
    return true;
  }
  const own = windowPool(quota, window);
  return own === null || own === pool;
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

/**
 * How a CLI's quota reads now for a citizen whose model draws from `pool` (`quotaPool`), or for the
 * CLI as a whole without one. A pool's own limit holding its models' turns (`limitHold`) is
 * `limited` too; only the login's windows and the pool's own count (`windowCounts`), and the CLI's
 * own warning counts unless every pool it reports limited is another's, as agy warns while one
 * pool is spent.
 */
export function quotaLevel(quota: CliQuota, now: Date, pool: string | null = null): QuotaLevel {
  if (quota.status === "none") {
    return "none";
  }
  if (
    quota.status === "limited" &&
    (quota.limitedUntil === null || Date.parse(quota.limitedUntil) > now.getTime())
  ) {
    return "limited";
  }
  if (pool !== null && limitHold(quota, now, pool) !== null) {
    return "limited";
  }
  const high = quota.windows.some(
    (window) =>
      windowCounts(quota, window, pool) &&
      windowCurrent(window, now) &&
      window.usedPercent !== null &&
      window.usedPercent >= QUOTA_WARNING_PERCENT,
  );
  const stopped = (quota.pools ?? []).filter((each) => each.limited);
  const warns =
    quota.status === "warning" &&
    (pool === null || stopped.length === 0 || stopped.some((each) => each.key === pool));
  return warns || high ? "warning" : "ok";
}

/**
 * How long a limit whose reset the CLI did not give holds its turns, from when it was reported.
 * Then one turn goes (`lapsedLimit`), and its own report says whether the limit still holds.
 */
export const UNKNOWN_LIMIT_HOLD_MS = 30 * 60_000;

/** Until when a CLI's limit, or a pool's, holds its turns on a runner, and whether the CLI gave that time. */
export interface LimitHold {
  readonly until: string;
  readonly known: boolean;
}

/**
 * Whether a quota's limit stops its CLI's turns. A Claude login's usage read with extra usage
 * turned on does not: the read calls a spent window a limit whether extra usage covers it or not,
 * while a turn's own report leaves a refusal extra usage covered out of its limit already.
 */
function stopsTurns(quota: CliQuota): boolean {
  return (
    quota.status === "limited" && !(quota.source === "read" && quota.extraUsage?.enabled === true)
  );
}

/** Until when a limit reported at `observedAt` holds: its reset, or `UNKNOWN_LIMIT_HOLD_MS` on. */
function holdOf(limitedUntil: string | null, observedAt: string, now: Date): LimitHold | null {
  const until =
    limitedUntil ?? new Date(Date.parse(observedAt) + UNKNOWN_LIMIT_HOLD_MS).toISOString();
  return Date.parse(until) > now.getTime() ? { until, known: limitedUntil !== null } : null;
}

/** The pool a quota names `pool` while the CLI refuses its models, if it does. */
function limitedPool(quota: CliQuota, pool: string | null): QuotaPool | undefined {
  return pool === null ? undefined : quota.pools?.find((each) => each.key === pool && each.limited);
}

/**
 * Until when a CLI's limit holds the turns of a citizen whose model draws from `pool` (`quotaPool`)
 * on the runner that reported it, or null while they may go: the login's limit, which holds every
 * pool, and the pool's own, each until the reset the CLI gave, or `UNKNOWN_LIMIT_HOLD_MS` after a
 * limit it gave none for; while both hold, the later. Without a pool, the login's alone.
 */
export function limitHold(
  quota: CliQuota,
  now: Date,
  pool: string | null = null,
): LimitHold | null {
  const login = stopsTurns(quota) ? holdOf(quota.limitedUntil, quota.observedAt, now) : null;
  const scoped = limitedPool(quota, pool);
  const own = scoped === undefined ? null : holdOf(scoped.limitedUntil, scoped.observedAt, now);
  if (login === null || own === null) {
    return login ?? own;
  }
  return Date.parse(own.until) > Date.parse(login.until) ? own : login;
}

/** A pool's limit holding its models' turns now, as the runners view and the prompt name it. */
export interface PoolHold extends LimitHold {
  readonly pool: string;
  readonly label: string | null;
}

/** Each pool whose own limit holds its models' turns now, in the order the CLI reported them. */
export function poolHolds(quota: CliQuota, now: Date): PoolHold[] {
  return (quota.pools ?? []).flatMap((pool) => {
    const hold = pool.limited ? holdOf(pool.limitedUntil, pool.observedAt, now) : null;
    return hold === null ? [] : [{ ...hold, pool: pool.key, label: pool.label ?? null }];
  });
}

/**
 * The limit the CLI gave no reset for that has held a citizen's turns for `UNKNOWN_LIMIT_HOLD_MS`
 * and stands with no newer report, so one turn may go to find out whether it still holds while the
 * rest wait for what that turn reports: the login's, keyed `""`, else the citizen's pool's, keyed
 * by the pool, each with the report it tries. Null while none has, or another limit still holds.
 */
export function lapsedLimit(
  quota: CliQuota,
  now: Date,
  pool: string | null = null,
): { readonly key: string; readonly observedAt: string } | null {
  if (limitHold(quota, now, pool) !== null) {
    return null;
  }
  if (stopsTurns(quota) && quota.limitedUntil === null) {
    return { key: "", observedAt: quota.observedAt };
  }
  const scoped = limitedPool(quota, pool);
  return scoped !== undefined && scoped.limitedUntil === null
    ? { key: scoped.key, observedAt: scoped.observedAt }
    : null;
}

/** Whether a limit with no reset has lapsed for a citizen whose model draws from `pool` (`lapsedLimit`). */
export function limitLapsed(quota: CliQuota, now: Date, pool: string | null = null): boolean {
  return lapsedLimit(quota, now, pool) !== null;
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

/**
 * What a reader compares two reports by: each window's whole percent and reset to the minute, and
 * each pool's limit and its end.
 */
function readings(quota: CliQuota): string {
  const windows = quota.windows
    .map(
      (window) =>
        `${window.key}=${window.usedPercent === null ? "?" : Math.round(window.usedPercent)}@${
          window.resetsAt === null ? "?" : Math.round(Date.parse(window.resetsAt) / 60_000)
        }`,
    )
    .toSorted();
  const pools = (quota.pools ?? [])
    .map((pool) => `${pool.key}:${pool.limited ? "limited" : "open"}@${pool.limitedUntil ?? "?"}`)
    .toSorted();
  return [...windows, ...pools].join(",");
}

/**
 * Whether a newer report changes what a reader would see: the status, the limit, the plan, the
 * credits, a window's whole percent or reset minute, or a pool's limit. A report that only
 * confirms the numbers changes when they were seen and nothing else.
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
 * the same windows, each at the same whole percent and resetting the same minute, and the same
 * pools' limits. Two logins
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
