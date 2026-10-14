import {
  addUsage,
  SOCIETY_SCOPE,
  type CitizenTokens,
  type Member,
  type MetricsWindow,
  type TurnHistoryEntry,
  type Usage,
} from "@stellaris/shared";
import type { Choice } from "../components/Picker.js";
import { elapsed } from "../lib/live.js";

/** The citizen view's tabs; the transcript of what it is doing now is the default. */
export type CitizenTab = "now" | "turns" | "memory" | "history";

export function scopeName(scope: string): string {
  return scope === SOCIETY_SCOPE ? "the society" : scope;
}

/** Where a citizen may be woken: each of its projects, and the society, outside any project. */
export function wakeScopes(member: Member): string[] {
  return [...member.memberships, SOCIETY_SCOPE];
}

/** Those places as a picker offers them. */
export function scopeChoices(scopes: readonly string[]): Choice[] {
  return scopes.map((scope) => ({
    value: scope,
    name: scopeName(scope),
    id: null,
    description: scope === SOCIETY_SCOPE ? "outside any project" : "a project",
  }));
}

/** How long a finished turn ran, from the start the log recorded; null when that is missing. */
export function turnLength(entry: TurnHistoryEntry): string | null {
  return entry.startedAt === undefined ? null : elapsed(entry.startedAt, Date.parse(entry.ts));
}

const ENDINGS: Readonly<Record<string, string>> = {
  completed: "completed",
  timeout: "timed out",
  error: "failed",
  interrupted: "interrupted",
  blocked: "blocked",
  stopped: "stopped by you",
};

/** How a finished turn ended, in a word or two. A stop is the user's decision, not a failure. */
export function endingOf(entry: TurnHistoryEntry): string {
  if (entry.exitReason !== null) {
    return ENDINGS[entry.exitReason] ?? entry.exitReason;
  }
  return entry.outcome === "failed" ? "failed" : "completed";
}

export function failed(entry: TurnHistoryEntry): boolean {
  return (
    entry.outcome === "failed" ||
    (entry.exitReason !== null &&
      entry.exitReason !== "completed" &&
      entry.exitReason !== "stopped")
  );
}

const compact = new Intl.NumberFormat("en", { notation: "compact" });
const whole = new Intl.NumberFormat("en");

/** A turn's whole input: what it read from the cache, wrote to it, and neither. */
export function inputTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** "152K in · 1.5K out". */
export function tokensLabel(usage: Usage): string {
  return `${compact.format(inputTokens(usage))} in · ${compact.format(usage.outputTokens)} out`;
}

/** The counts behind `tokensLabel`, in full. */
export function tokensDetail(usage: Usage): string {
  return [
    `${whole.format(inputTokens(usage))} input tokens: ${whole.format(usage.cacheReadTokens)} read from the cache,`,
    `${whole.format(usage.cacheWriteTokens)} written to it, ${whole.format(usage.inputTokens)} neither;`,
    `${whole.format(usage.outputTokens)} output tokens`,
  ].join(" ");
}

/**
 * How many turns a history holds, how many did not complete, and the tokens of those that recorded
 * them, which turns logged before tokens were recorded did not.
 */
export function historyTotals(entries: readonly TurnHistoryEntry[]): {
  turns: number;
  failed: number;
  usage: Usage | null;
  withUsage: number;
} {
  const counted = entries.flatMap((entry) => (entry.usage === undefined ? [] : [entry.usage]));
  return {
    turns: entries.length,
    failed: entries.filter(failed).length,
    usage: counted.length === 0 ? null : counted.reduce(addUsage),
    withUsage: counted.length,
  };
}

const PERIODS: Readonly<Record<MetricsWindow, string>> = {
  "24h": "in the last 24 hours",
  "7d": "in the last 7 days",
  all: "in all",
};

function turnsOf(count: number): string {
  return count === 1 ? "1 finished turn" : `${count} finished turns`;
}

/**
 * A citizen's tokens over a window as the Citizens list shows them: "in · out" as on its Turns
 * tab, marked as a lower bound when some of its turns have no count, unknown when none has, and
 * the counts in full with the turns they cover on hover, which `spoken` says to screen readers
 * when the label alone would mislead. A turn has no count when it was logged before turns counted
 * tokens, or ended without its runner's report, as when the runner went away during it.
 */
export function tokenUseCell(
  row: CitizenTokens | undefined,
  window: MetricsWindow,
): { label: string; detail: string; spoken: string | null } {
  const period = PERIODS[window];
  if (row === undefined || row.turns === 0) {
    return { label: "no turns", detail: `no finished turn ${period}`, spoken: null };
  }
  const missing = row.turns - row.withUsage;
  const why = "logged before turns counted tokens, or ended without their runner's report";
  if (row.usage === null) {
    return {
      label: "tokens unknown",
      detail: `${turnsOf(row.turns)} ${period}, none with a token count: ${why}`,
      spoken: `${turnsOf(row.turns)} ${period}, none counted`,
    };
  }
  if (missing === 0) {
    return {
      label: tokensLabel(row.usage),
      detail: `${tokensDetail(row.usage)}; over ${turnsOf(row.turns)} ${period}`,
      spoken: null,
    };
  }
  const over = `over ${row.withUsage} of ${turnsOf(row.turns)} ${period}`;
  return {
    label: `≥${compact.format(inputTokens(row.usage))} in · ≥${compact.format(row.usage.outputTokens)} out`,
    detail: [
      `${tokensDetail(row.usage)}; ${over}.`,
      `The other ${missing === 1 ? "one has" : `${missing} have`} no count: ${why}.`,
    ].join(" "),
    spoken: over,
  };
}

/** A markdown file without a leading heading that only repeats the title it is shown under. */
export function withoutTitle(markdown: string, title: string): string {
  const match = /^\s*#{1,6}\s+(.+?)\s*(?:\n|$)/.exec(markdown);
  return match?.[1]?.toLowerCase() === title.toLowerCase()
    ? markdown.slice(match[0].length).trim()
    : markdown;
}

/** The runners a citizen's turns run on: the one it is pinned to, then its projects' runners. */
export function turnRunners(member: Member, placed: ReadonlyMap<string, string>): string[] {
  return [
    ...new Set(
      [member.homeRunner, ...member.memberships.map((slug) => placed.get(slug))].filter(
        (runner): runner is string => runner !== undefined,
      ),
    ),
  ];
}

/**
 * Where a citizen's turns run: its work outside projects on the runner it is pinned to, and its
 * work in each project on the runner that project lives on. Either is set by the first such turn.
 * `parts` is the label in the pieces a line may break between, one runner each, so a list can wrap
 * between runners while each name, whose hyphens a hostname's would otherwise break at, stays whole.
 */
export function runnersOf(
  member: Member,
  placed: ReadonlyMap<string, string>,
): { label: string; parts: string[]; detail: string } {
  const places = [
    ...(member.homeRunner === undefined
      ? []
      : [{ what: "outside projects", runner: member.homeRunner }]),
    ...member.memberships.map((slug) => ({ what: slug, runner: placed.get(slug) })),
  ];
  const runners = turnRunners(member, placed);
  const detail = places
    .map((place) => `${place.what}: ${place.runner ?? "placed on its first turn"}`)
    .join("; ");
  const parts =
    runners.length === 0
      ? ["no runner yet"]
      : runners.map(
          (name, index) =>
            `${index === 0 ? "on " : ""}${name}${index < runners.length - 1 ? "," : ""}`,
        );
  return {
    label: parts.join(" "),
    parts,
    detail: detail === "" ? "pinned to a runner on its first turn" : detail,
  };
}
