import { useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * What this browser has seen: for each channel ref or thread id, the newest message id looked at.
 * The user follows nothing on the board, so "new since you last looked" is kept here, per browser.
 */
type Seen = Readonly<Record<string, string>>;

const KEY = "stellaris.seen";
/** Set once the board has been listed in this browser; marks made before that still count. */
const LISTED = "*";
const listeners = new Set<() => void>();

function read(): Seen | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    return raw === null ? null : z.record(z.string(), z.string()).parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

let current: Seen | null = read();

function write(next: Seen): void {
  current = next;
  localStorage.setItem(KEY, JSON.stringify(next));
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSeen(): Seen | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** On this browser's first visit, everything already on the board counts as seen. */
export function initSeen(latest: ReadonlyArray<readonly [string, string | null]>): void {
  if (current?.[LISTED] === undefined) {
    const baseline = Object.fromEntries(latest.map(([key, id]) => [key, id ?? ""]));
    write({ ...baseline, ...current, [LISTED]: "1" });
  }
}

export function markSeen(key: string, id: string | null): void {
  if (id !== null && id > (current?.[key] ?? "")) {
    write({ ...current, [key]: id });
  }
}

/** ULIDs sort by time, so a newer message has the greater id. */
export function isUnseen(seen: Seen | null, key: string, latest: string | null): boolean {
  return seen !== null && latest !== null && latest > (seen[key] ?? "");
}
