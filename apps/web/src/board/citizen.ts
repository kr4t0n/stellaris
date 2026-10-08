import {
  addUsage,
  SOCIETY_SCOPE,
  type Member,
  type TurnHistoryEntry,
  type Usage,
} from "@stellaris/shared";
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

/** A markdown file without a leading heading that only repeats the title it is shown under. */
export function withoutTitle(markdown: string, title: string): string {
  const match = /^\s*#{1,6}\s+(.+?)\s*(?:\n|$)/.exec(markdown);
  return match?.[1]?.toLowerCase() === title.toLowerCase()
    ? markdown.slice(match[0].length).trim()
    : markdown;
}

/**
 * Where a citizen's turns run: its work outside projects on the runner it is pinned to, and its
 * work in each project on the runner that project lives on. Either is set by the first such turn.
 */
export function runnersOf(
  member: Member,
  placed: ReadonlyMap<string, string>,
): { label: string; detail: string } {
  const places = [
    ...(member.homeRunner === undefined
      ? []
      : [{ what: "outside projects", runner: member.homeRunner }]),
    ...member.memberships.map((slug) => ({ what: slug, runner: placed.get(slug) })),
  ];
  const runners = [
    ...new Set(places.flatMap((place) => (place.runner === undefined ? [] : [place.runner]))),
  ];
  const detail = places
    .map((place) => `${place.what}: ${place.runner ?? "placed on its first turn"}`)
    .join("; ");
  return {
    label: runners.length === 0 ? "no runner yet" : `on ${runners.join(", ")}`,
    detail: detail === "" ? "pinned to a runner on its first turn" : detail,
  };
}
