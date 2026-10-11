import type { KnowledgeNotice, Message, MessageNotice } from "@stellaris/shared";

/** Notices drawn as one line: one post's, or a run of posts in a row about one subject. */
export interface NoticeRun {
  readonly messages: readonly Message[];
  readonly notices: readonly MessageNotice[];
}

export type Folded<T> =
  | { readonly kind: "item"; readonly item: T }
  | { readonly kind: "notices"; readonly run: NoticeRun };

/** Whether a notice carries on a run: a knowledge topic written again, by anyone, after a write. */
function continues(run: NoticeRun, next: MessageNotice): boolean {
  const last = run.notices.at(-1);
  return (
    last !== undefined &&
    last.kind === "knowledge" &&
    next.kind === "knowledge" &&
    last.action !== "removed" &&
    next.action === "updated" &&
    last.topic === next.topic &&
    last.project === next.project
  );
}

/**
 * A stream with its notices folded: each run of notices that carry on one another becomes one
 * entry, and anything else between them, a post or a thread, ends the run.
 */
export function foldNotices<T>(
  items: readonly T[],
  messageOf: (item: T) => Message | undefined,
): Folded<T>[] {
  const folded: Folded<T>[] = [];
  let open: { messages: Message[]; notices: MessageNotice[] } | null = null;
  for (const item of items) {
    const message = messageOf(item);
    const notice = message?.notice;
    if (message === undefined || notice === undefined) {
      folded.push({ kind: "item", item });
      open = null;
    } else if (open !== null && continues(open, notice)) {
      open.messages.push(message);
      open.notices.push(notice);
    } else {
      open = { messages: [message], notices: [notice] };
      folded.push({ kind: "notices", run: open });
    }
  }
  return folded;
}

/** What a run of knowledge notices did, as a verb, and how often when it did it more than once. */
export function knowledgeDone(notices: readonly KnowledgeNotice[]): {
  did: string;
  times: string | null;
} {
  const [first] = notices;
  const more = notices.length - 1;
  if (first === undefined || first.action === "removed") {
    return { did: "removed", times: null };
  }
  if (first.action === "written") {
    return {
      did: "wrote",
      times: more === 0 ? null : `then updated it ${more === 1 ? "once" : `${more} times`}`,
    };
  }
  return { did: "updated", times: more === 0 ? null : `${notices.length} times` };
}

/** Names in the order they first appear, as a phrase: "ada", "ada and ref", "ada, ref, and vera". */
export function namesPhrase(names: readonly string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 2) {
    return unique.join(" and ");
  }
  return `${unique.slice(0, -1).join(", ")}, and ${unique.at(-1) ?? ""}`;
}
