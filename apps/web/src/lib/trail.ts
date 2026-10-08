import { useSyncExternalStore } from "react";

/**
 * Where this tab has been: the address shown at each step of its history, so a view's back arrow
 * can return to the view the user came from and say which it is. Kept in session storage, since a
 * reload keeps the browser's history.
 */
export type Trail = Readonly<Record<number, string>>;

const STORAGE_KEY = "stellaris.trail";

/**
 * The trail after a visit at a step of the history: the step's address is set, and the steps after
 * it are dropped, since a new visit there replaces whatever the browser could have gone forward to.
 */
export function visited(trail: Trail, index: number, href: string): Trail {
  const next: Record<number, string> = {};
  for (const [step, address] of Object.entries(trail)) {
    if (Number(step) < index) {
      next[Number(step)] = address;
    }
  }
  next[index] = href;
  return next;
}

/** The board view the step before `index` showed, or null when it was the sky or is unknown. */
export function previousView(trail: Trail, index: number): string | null {
  const href = trail[index - 1];
  return href === undefined || new URL(href, "http://board").pathname === "/" ? null : href;
}

export function readTrail(): Trail {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const trail: Record<number, string> = {};
    for (const [step, address] of Object.entries(parsed)) {
      if (typeof address === "string" && Number.isInteger(Number(step))) {
        trail[Number(step)] = address;
      }
    }
    return trail;
  } catch {
    return {};
  }
}

export function saveTrail(trail: Trail): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trail));
}

/** What the board knows a place by, to name the view an arrow returns to. */
export interface PlaceNames {
  /** The title of a task, a proposal, or a thread, by id. */
  readonly entity: (id: string) => string | undefined;
  /** A project's name, by slug. */
  readonly project: (slug: string) => string | undefined;
}

function segment(pathname: string, at: number): string {
  return decodeURIComponent(pathname.split("/")[at] ?? "");
}

/** The words for the view at an address, as in "Back to …". */
export function placeName(href: string, names: PlaceNames): string {
  const { pathname } = new URL(href, "http://board");
  const parts = pathname.split("/").filter((part) => part !== "");
  const [first = "", second = "", third = ""] = parts;
  if (first === "task" && third === "files") {
    const file = parts.slice(3).map(decodeURIComponent).at(-1);
    return file ?? "the task's files";
  }
  if (first === "task" || first === "thread" || first === "proposal") {
    return names.entity(second) ?? `the ${first}`;
  }
  if (first === "c") {
    return `#${decodeURIComponent(parts.at(-1) ?? "")}`;
  }
  if (first === "p") {
    const project = names.project(second) ?? second;
    return third === "tasks" ? `the tasks of ${project}` : project;
  }
  if (first === "knowledge") {
    return segment(pathname, 3);
  }
  if (first === "citizen") {
    return decodeURIComponent(second);
  }
  const views: Readonly<Record<string, string>> = {
    society: "the society",
    citizens: "the citizens",
    "needs-you": "what needs you",
    proposals: "the proposals",
    metrics: "the metrics",
    runners: "the runners",
  };
  return views[first] ?? "the previous view";
}

// The tab's trail, recorded by the Playground on every move and read by the views' back arrows.
let current: Trail = typeof sessionStorage === "undefined" ? {} : readTrail();
const listeners = new Set<() => void>();

/** Records the address shown at a step of the history. */
export function recordVisit(index: number, href: string): void {
  if (current[index] === href && current[index + 1] === undefined) {
    return;
  }
  current = visited(current, index, href);
  saveTrail(current);
  for (const listener of listeners) {
    listener();
  }
}

export function useTrail(): Trail {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
