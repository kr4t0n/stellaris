import {
  SOCIETY_SCOPE,
  type CliKind,
  type Member,
  type RoleCharter,
  type TurnHistoryEntry,
} from "@stellaris/shared";
import { elapsed } from "../lib/live.js";

/** The citizen view's tabs; the transcript of what it is doing now is the default. */
export type CitizenTab = "now" | "turns" | "memory" | "history";

export function scopeName(scope: string): string {
  return scope === SOCIETY_SCOPE ? "the society" : scope;
}

/** Where a citizen may be woken: its projects, and the society when its charter allows it. */
export function wakeScopes(member: Member, charter: RoleCharter | undefined): string[] {
  return [...member.memberships, ...(charter?.societyScope === true ? [SOCIETY_SCOPE] : [])];
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
};

/** How a finished turn ended, in a word or two. */
export function endingOf(entry: TurnHistoryEntry): string {
  if (entry.exitReason !== null) {
    return ENDINGS[entry.exitReason] ?? entry.exitReason;
  }
  return entry.outcome === "failed" ? "failed" : "completed";
}

export function failed(entry: TurnHistoryEntry): boolean {
  return (
    entry.outcome === "failed" || (entry.exitReason !== null && entry.exitReason !== "completed")
  );
}

/** Codex reports tokens but no price, so its turns are not metered in dollars. */
export function costLabel(entry: TurnHistoryEntry, cli: CliKind | null): string {
  return cli === "codex" && entry.costUsd === 0 ? "unmetered" : `$${entry.costUsd.toFixed(2)}`;
}

/** How many turns a history holds, how many did not complete, and the dollars they were metered. */
export function historyTotals(entries: readonly TurnHistoryEntry[]): {
  turns: number;
  failed: number;
  costUsd: number;
} {
  return {
    turns: entries.length,
    failed: entries.filter(failed).length,
    costUsd: entries.reduce((sum, entry) => sum + entry.costUsd, 0),
  };
}

/** A markdown file without a leading heading that only repeats the title it is shown under. */
export function withoutTitle(markdown: string, title: string): string {
  const match = /^\s*#{1,6}\s+(.+?)\s*(?:\n|$)/.exec(markdown);
  return match?.[1]?.toLowerCase() === title.toLowerCase()
    ? markdown.slice(match[0].length).trim()
    : markdown;
}
