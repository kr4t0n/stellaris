import {
  QUOTA_WARNING_PERCENT,
  quotaLevel,
  sameQuotaNumbers,
  windowCurrent,
  windowName,
  type CliKind,
  type CliQuota,
  type QuotaLevel,
  type QuotaWindow,
  type Runner,
} from "@stellaris/shared";

/** Numbers older than this are read again when the runners view opens. */
export const QUOTA_STALE_MS = 15 * 60_000;

/** Whether a CLI's quota on a runner wants reading again: never reported, or reported long ago. */
export function quotaStale(quota: CliQuota | undefined, now: number): boolean {
  return quota === undefined || now - Date.parse(quota.observedAt) >= QUOTA_STALE_MS;
}

/**
 * One CLI login's quota as the runners view lists it. Runners whose reports show the same numbers
 * share a row, the first runner's report shown, since two logins rarely match to the minute and
 * percent; the board never reads whose login it is.
 */
export interface QuotaRow {
  readonly cli: CliKind;
  readonly runners: string[];
  readonly quota: CliQuota | undefined;
  /** Whether the first runner is connected, so its CLI can be asked. */
  readonly connected: boolean;
}

export function quotaRows(runners: readonly Runner[]): QuotaRow[] {
  const rows: QuotaRow[] = [];
  for (const runner of runners) {
    for (const cli of runner.clis) {
      const quota = runner.quotas?.[cli];
      const same =
        quota === undefined
          ? undefined
          : rows.find(
              (row) =>
                row.cli === cli && row.quota !== undefined && sameQuotaNumbers(row.quota, quota),
            );
      if (same === undefined) {
        rows.push({ cli, runners: [runner.name], quota, connected: runner.status === "connected" });
      } else {
        same.runners.push(runner.name);
      }
    }
  }
  return rows;
}

/** A time to come as "42m", "4h 12m", or "3d 6h". */
export function until(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** One window as a meter reads it: its name, how full, and when it starts afresh. */
export interface WindowReading {
  readonly name: string;
  /** Percent used, 0 to 100 for the bar, or null when unknown or reset since it was read. */
  readonly percent: number | null;
  readonly label: string;
  readonly reset: string;
  readonly high: boolean;
}

/**
 * One window's meter. The percent is shown rounded down, so a label reads 80% exactly when the
 * window is at `QUOTA_WARNING_PERCENT`, where it turns amber, as `quotaLevel` counts it.
 */
export function windowReading(window: QuotaWindow, now: number): WindowReading {
  const name = windowName(window);
  const current = windowCurrent(window, new Date(now));
  if (!current) {
    return { name, percent: null, label: "reset", reset: "reset since read", high: false };
  }
  const used = window.usedPercent;
  return {
    name,
    percent: used === null ? null : Math.min(100, used),
    label: used === null ? "?" : `${Math.floor(used)}%`,
    reset: window.resetsAt === null ? "" : `resets in ${until(Date.parse(window.resetsAt) - now)}`,
    high: used !== null && used >= QUOTA_WARNING_PERCENT,
  };
}

/** What a quota says as a whole, in words, and the tone it reads in. */
export function quotaWords(
  quota: CliQuota,
  now: number,
): { readonly level: QuotaLevel; readonly words: string; readonly tone: string } {
  const level = quotaLevel(quota, new Date(now));
  if (level === "limited") {
    return {
      level,
      words:
        quota.limitedUntil === null
          ? "limited"
          : `limited for ${until(Date.parse(quota.limitedUntil) - now)}`,
      tone: "text-red-300",
    };
  }
  if (level === "warning") {
    return { level, words: "near a limit", tone: "text-amber-300" };
  }
  return {
    level,
    words: level === "none" ? "no plan limits reported" : "",
    tone: "text-fg-muted",
  };
}

/** A CLI's quota on one runner in a line, as a citizen's view shows it. */
export function quotaLine(quota: CliQuota | undefined, now: number): string {
  if (quota === undefined) {
    return "unknown";
  }
  const { level, words } = quotaWords(quota, now);
  if (level === "limited" || level === "none") {
    return words;
  }
  const windows = quota.windows
    .map((window) => windowReading(window, now))
    .map((reading) => `${reading.name} ${reading.label}`);
  return [...windows, ...(words === "" ? [] : [words])].join(" · ") || "no windows reported";
}
