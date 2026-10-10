import {
  CRON_FAILING_RUNS,
  CRON_FLOOR_MS,
  canonicalTimeZone,
  cronExpressionError,
  fireTimes,
  nextFire,
  shortestGapMs,
  SOCIETY_SCOPE,
  type CronFrontmatter,
  type CronSchedule,
} from "@stellaris/shared";

/** Whether a cron's turns keep failing, as the board's `cron_failing` signal counts them. */
export function failingCron(cron: CronFrontmatter): boolean {
  return cron.ended === undefined && cron.failures >= CRON_FAILING_RUNS;
}

export interface CronGroups<T extends CronFrontmatter> {
  /** Running crons with their next fire, soonest first; one with no time to come last. */
  readonly active: ReadonlyArray<{ readonly cron: T; readonly next: Date | null }>;
  readonly paused: readonly T[];
  /** Ended crons, the latest to end first. */
  readonly ended: readonly T[];
}

/** The crons as the view lists them: running ones by next fire, then paused, then ended. */
export function cronGroups<T extends CronFrontmatter>(
  crons: readonly T[],
  societyZone: string,
): CronGroups<T> {
  const active = crons
    .filter((cron) => cron.ended === undefined && cron.paused === undefined)
    .map((cron) => ({ cron, next: nextFire(cron, societyZone) }))
    .toSorted(
      (a, b) =>
        (a.next?.getTime() ?? Number.POSITIVE_INFINITY) -
        (b.next?.getTime() ?? Number.POSITIVE_INFINITY),
    );
  return {
    active,
    paused: crons.filter((cron) => cron.ended === undefined && cron.paused !== undefined),
    ended: crons
      .filter((cron) => cron.ended !== undefined)
      .toSorted((a, b) => (b.ended?.at ?? "").localeCompare(a.ended?.at ?? "")),
  };
}

/** Where a cron fires, as a place the board names: a thread, a channel, or the scope's home. */
export type CronPlace =
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "channel"; readonly ref: string }
  | { readonly kind: "home"; readonly scope: string };

export function cronPlace(cron: CronFrontmatter): CronPlace {
  if (cron.thread !== undefined) {
    return { kind: "thread", id: cron.thread };
  }
  if (cron.channel !== undefined) {
    return {
      kind: "channel",
      ref: cron.scope === SOCIETY_SCOPE ? cron.channel : `${cron.scope}/${cron.channel}`,
    };
  }
  return { kind: "home", scope: cron.scope };
}

/**
 * The next fires a schedule would have, or why the board would refuse it: the same checks
 * `create_cron` makes, so the form says so before anything is sent.
 */
export function schedulePreview(
  schedule: CronSchedule,
  societyZone: string,
  now: Date,
  count = 3,
): { readonly times: readonly Date[] } | { readonly error: string } {
  if ("at" in schedule) {
    const at = new Date(schedule.at);
    if (Number.isNaN(at.getTime())) {
      return { error: "Choose a time." };
    }
    return at <= now ? { error: "That time has passed." } : { times: [at] };
  }
  const expression = schedule.cron.trim();
  if (expression === "") {
    return { error: "Write five fields: minute, hour, day of month, month, day of week." };
  }
  const invalid = cronExpressionError(expression);
  if (invalid !== null) {
    return { error: invalid };
  }
  if (schedule.timezone !== undefined && canonicalTimeZone(schedule.timezone) === null) {
    return { error: `${schedule.timezone} is not a time zone.` };
  }
  const times = fireTimes(schedule, societyZone, now, count);
  if (times.length === 0) {
    return { error: "It names no time to come." };
  }
  const gap = shortestGapMs(schedule, societyZone, now);
  if (gap !== null && gap < CRON_FLOOR_MS) {
    return {
      error: `It fires ${Math.round(gap / 60_000)} minute(s) apart at its closest; a cron fires at most every ${CRON_FLOOR_MS / 60_000} minutes.`,
    };
  }
  return { times };
}
