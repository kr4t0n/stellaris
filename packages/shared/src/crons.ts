import { Cron as Pattern } from "croner";
import { z } from "zod";
import { IsoDateTimeSchema, NameSchema, UlidSchema } from "./ids.js";

/** The least time between two fires of one cron, so a mistyped schedule cannot cost a turn a minute. */
export const CRON_FLOOR_MS = 15 * 60_000;

/**
 * A fire may come a little after its time, so the floor counts from this much before the previous
 * fire; otherwise a cron every fifteen minutes would skip every other time after a late fire.
 */
const FIRE_SLACK_MS = 60_000;

/** How many fires ahead a schedule is checked for coming closer together than the floor. */
const FLOOR_LOOKAHEAD = 200;

/** A cron whose turns failed this many times in a row is a `cron_failing` signal. */
export const CRON_FAILING_RUNS = 3;

/** The society's time zone until the user sets one. */
export const DEFAULT_TIME_ZONE = "UTC";

/** An IANA time zone's canonical name, as `Intl` resolves it, or null for a name it does not know. */
export function canonicalTimeZone(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export const TimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((zone, ctx) => {
    const canonical = canonicalTimeZone(zone);
    if (canonical === null) {
      ctx.addIssue({
        code: "custom",
        message: `${zone} is not a time zone; name one as IANA does, such as Europe/Berlin, America/New_York, or UTC`,
      });
      return z.NEVER;
    }
    return canonical;
  });

/** A five-field expression as croner reads it, in a time zone, never set off on a timer. */
function pattern(expression: string, timeZone: string): Pattern {
  return new Pattern(expression, { mode: "5-part", timezone: timeZone, paused: true });
}

/** Why a five-field cron expression does not parse, or null when it does. */
export function cronExpressionError(expression: string): string | null {
  try {
    pattern(expression, DEFAULT_TIME_ZONE);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Minute, hour, day of month, month, and day of week, as `0 9 * * 1-5` for nine on weekdays. */
export const CronExpressionSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .superRefine((expression, ctx) => {
    const error = cronExpressionError(expression);
    if (error !== null) {
      ctx.addIssue({
        code: "custom",
        message: `not a five-field cron expression (minute, hour, day of month, month, day of week): ${error}`,
      });
    }
  });

/**
 * When a cron fires: on a five-field expression, read in its time zone or, without one, in the
 * society's, or once, at a time.
 */
export const CronScheduleSchema = z.union([
  z.object({ cron: CronExpressionSchema, timezone: TimeZoneSchema.optional() }),
  z.object({ at: IsoDateTimeSchema }),
]);
export type CronSchedule = z.infer<typeof CronScheduleSchema>;

/** How the turn a fire started ended: the user's stop is a decision, not a failure. */
export const CronRunSchema = z.object({
  turnId: UlidSchema,
  at: IsoDateTimeSchema,
  outcome: z.enum(["completed", "failed", "stopped"]),
});
export type CronRun = z.infer<typeof CronRunSchema>;

/**
 * A wake on a clock: one citizen, in one conversation of a scope (a thread's, a channel's other
 * than general, or neither, the home), on a schedule. The note, what to do when it fires, is the
 * body of its file and is quoted in the prompt of every turn it starts.
 */
export const CronFrontmatterSchema = z.object({
  id: UlidSchema,
  title: z.string().trim().min(1).max(120),
  agent: NameSchema,
  scope: NameSchema,
  thread: UlidSchema.optional(),
  channel: NameSchema.optional(),
  schedule: CronScheduleSchema,
  createdBy: NameSchema,
  createdAt: IsoDateTimeSchema,
  /** When the current schedule took effect: set, changed, or resumed. It fires only after this. */
  since: IsoDateTimeSchema,
  paused: z.object({ at: IsoDateTimeSchema, by: NameSchema }).optional(),
  lastFiredAt: IsoDateTimeSchema.optional(),
  /** When a time came while its previous fire's turn was still queued or running, so it passed. */
  lastSkippedAt: IsoDateTimeSchema.optional(),
  /** How the turn of its latest fire ended. */
  lastRun: CronRunSchema.optional(),
  /** Its turns that failed in a row, up to the latest. */
  failures: z.number().int().nonnegative().default(0),
  ended: z.object({ at: IsoDateTimeSchema, by: NameSchema, reason: z.string().min(1) }).optional(),
});
export type CronFrontmatter = z.infer<typeof CronFrontmatterSchema>;
export interface Cron extends CronFrontmatter {
  readonly note: string;
}

/** Whether a schedule fires once rather than on an expression. */
export function isOneTime(schedule: CronSchedule): schedule is { at: string } {
  return "at" in schedule;
}

/** The time zone a recurring schedule is read in: its own, else the society's. */
export function scheduleZone(schedule: CronSchedule, societyZone: string): string {
  return isOneTime(schedule) ? societyZone : (schedule.timezone ?? societyZone);
}

/** The next `count` times a schedule names after `after`, oldest first. */
export function fireTimes(
  schedule: CronSchedule,
  societyZone: string,
  after: Date,
  count: number,
): Date[] {
  if (isOneTime(schedule)) {
    const at = new Date(schedule.at);
    return at > after && count > 0 ? [at] : [];
  }
  return pattern(schedule.cron, scheduleZone(schedule, societyZone)).nextRuns(count, after);
}

/**
 * The shortest time between two of a recurring schedule's coming fires, or null when it names fewer
 * than two, as a one-time schedule does.
 */
export function shortestGapMs(
  schedule: CronSchedule,
  societyZone: string,
  after: Date,
): number | null {
  const times = fireTimes(schedule, societyZone, after, FLOOR_LOOKAHEAD);
  let shortest: number | null = null;
  for (let index = 1; index < times.length; index += 1) {
    const gap = (times[index]?.getTime() ?? 0) - (times[index - 1]?.getTime() ?? 0);
    shortest = shortest === null ? gap : Math.min(shortest, gap);
  }
  return shortest;
}

/**
 * When an active cron fires next, or null for one paused, ended, or with no time left to come. A
 * one-time cron fires at its time, or at once when that passed while it was paused. A recurring one
 * fires at its first time after its schedule took effect, after a time it skipped, and at least the
 * floor after its previous fire, so fires missed while nothing could fire collapse into one.
 */
export function nextFire(
  cron: CronFrontmatter,
  societyZone: string,
  floorMs = CRON_FLOOR_MS,
): Date | null {
  if (cron.ended !== undefined || cron.paused !== undefined) {
    return null;
  }
  const fired = cron.lastFiredAt === undefined ? null : Date.parse(cron.lastFiredAt);
  const since = Date.parse(cron.since);
  if (isOneTime(cron.schedule)) {
    return fired !== null && fired >= since ? null : new Date(cron.schedule.at);
  }
  const from = Math.max(
    since,
    fired === null ? since : fired + floorMs - FIRE_SLACK_MS,
    cron.lastSkippedAt === undefined ? since : Date.parse(cron.lastSkippedAt),
  );
  return fireTimes(cron.schedule, societyZone, new Date(from), 1)[0] ?? null;
}

/** A schedule in words: its expression and the zone it is read in, or its one time. */
export function describeSchedule(schedule: CronSchedule, societyZone: string): string {
  if (isOneTime(schedule)) {
    return `once at ${schedule.at}`;
  }
  return schedule.timezone === undefined
    ? `\`${schedule.cron}\` in the society's time zone, ${societyZone}`
    : `\`${schedule.cron}\` in ${schedule.timezone}`;
}

/** A moment as a clock in a time zone reads it, such as `Saturday 2026-10-10 09:00`. */
export function localTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((each) => each.type === type)?.value ?? "";
  return `${part("weekday")} ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}
