import { WAKING_SIGNAL_KINDS, type OpsSignal, type OpsSignalKind } from "@stellaris/shared";
import type { SignalRecord } from "./api.js";

const WAKING = new Set<OpsSignalKind>(WAKING_SIGNAL_KINDS);

/** What each kind measures, as the log names it. */
export const SIGNAL_LABEL: Readonly<Record<OpsSignalKind, string>> = {
  waiting_stage: "stage waiting",
  backlog: "backlog",
  role_gap: "role gap",
  churn: "churn",
  stale_thread: "stale thread",
  idle_member: "idle member",
  blocked_capability: "missing capability",
  turn_cost: "spend",
  scaled: "replica added",
  runner: "runner",
  home_conflict: "edits to reconcile",
};

/** Whether a signal of this kind wakes the roles that read signals, the steward among them. */
export function wakesReaders(kind: OpsSignalKind): boolean {
  return WAKING.has(kind);
}

/**
 * The entries whose condition still holds: for each key the scheduler found at its last pass, the
 * newest entry logged under it. Older entries of the same key are history.
 */
export function holdingNow(
  records: readonly SignalRecord[],
  active: readonly string[],
): Set<string> {
  const keys = new Set(active);
  const newest = new Map<string, string>();
  for (const record of records) {
    if (keys.has(record.signal.key)) {
      newest.set(record.signal.key, record.id);
    }
  }
  return new Set(newest.values());
}

/**
 * What a signal concerns and whether it wakes the steward, for the line under its summary. Its
 * value and threshold are left out: the summary already says them in words and units.
 */
export function signalFacts(signal: OpsSignal): string[] {
  return [
    signal.project ?? "",
    signal.agent ?? "",
    signal.role === undefined ? "" : `role ${signal.role}`,
    wakesReaders(signal.kind) ? "wakes the steward" : "",
  ].filter((fact) => fact.length > 0);
}
