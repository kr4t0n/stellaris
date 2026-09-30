import { USER_NAME } from "@stellaris/shared";
import type { ThreadSummary } from "../lib/api.js";

/** The society's general channel, where every ask opens its thread. */
export const ASK_CHANNEL = "general";

const TITLE_LIMIT = 80;

/**
 * The user's asks: topic threads the user opened on the society's general channel, newest first.
 * Nothing marks a thread as an ask, so one opened there from the channel view counts too.
 */
export function asksOf(threads: readonly ThreadSummary[]): ThreadSummary[] {
  return threads
    .filter(
      (thread) =>
        thread.channel === ASK_CHANNEL &&
        thread.subject === undefined &&
        thread.openedBy === USER_NAME,
    )
    .toSorted((a, b) => b.id.localeCompare(a.id));
}

/** An ask's thread title: its first line, without a heading or quote mark, cut at a word. */
export function askTitle(body: string): string {
  const line =
    body
      .trim()
      .split("\n")[0]
      ?.replace(/^(#+|>)\s*/, "")
      .replaceAll(/\s+/g, " ")
      .trim() ?? "";
  if (line === "") {
    return "Ask";
  }
  if (line.length <= TITLE_LIMIT) {
    return line;
  }
  const cut = line.slice(0, TITLE_LIMIT - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > TITLE_LIMIT / 2 ? cut.slice(0, space) : cut}…`;
}

export type AskState =
  | { readonly kind: "answering"; readonly who: readonly string[] }
  | { readonly kind: "queued"; readonly who: readonly string[] }
  | { readonly kind: "waiting" }
  | { readonly kind: "answered"; readonly by: string }
  | { readonly kind: "closed"; readonly by: string | undefined };

type Pair = { readonly agent: string; readonly thread?: string | undefined };

/**
 * Where an ask stands: closed; someone in a turn on it or queued for one, read from the
 * scheduler's sessions for its thread; else answered by whoever wrote last, unless that was the user.
 */
export function askState(
  ask: ThreadSummary,
  running: readonly Pair[],
  pending: readonly Pair[],
): AskState {
  if (ask.state === "closed") {
    return { kind: "closed", by: ask.closedBy };
  }
  const on = (pairs: readonly Pair[]): string[] => [
    ...new Set(pairs.filter((pair) => pair.thread === ask.id).map((pair) => pair.agent)),
  ];
  const answering = on(running);
  if (answering.length > 0) {
    return { kind: "answering", who: answering };
  }
  const queued = on(pending);
  if (queued.length > 0) {
    return { kind: "queued", who: queued };
  }
  return ask.lastAuthor === null || ask.lastAuthor === USER_NAME
    ? { kind: "waiting" }
    : { kind: "answered", by: ask.lastAuthor };
}

/**
 * Whether an open ask ends in a reply this browser has not shown. Unlike a channel's dot, it does
 * not wait for the board to be listed once: an answer nobody has read is news on any first visit.
 */
export function hasUnseenReply(
  ask: ThreadSummary,
  seen: Readonly<Record<string, string>> | null,
): boolean {
  return (
    ask.state === "open" &&
    ask.lastAuthor !== null &&
    ask.lastAuthor !== USER_NAME &&
    ask.lastMessageId !== null &&
    ask.lastMessageId > (seen?.[ask.id] ?? "")
  );
}
