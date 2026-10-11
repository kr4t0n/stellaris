import {
  KnowledgeNoticeSchema,
  parseChannelRef,
  type KnowledgeNotice,
  type Message,
  type MessageNotice,
} from "@stellaris/shared";

/** The note a knowledge verb posted before posts carried their notice, in the board's own words. */
const KNOWLEDGE_NOTE =
  /^Knowledge (written|updated|removed): ([a-z0-9][a-z0-9-]{0,31})\. It is (?:no longer )?under knowledge\/\2\.md( of the society)?\.$/;

/**
 * What a post records as a notice, or null for talk. A knowledge note from before posts carried
 * their notice is read from its text, which the board wrote from a fixed template.
 */
export function noticeOf(message: Message): MessageNotice | null {
  if (message.notice !== undefined) {
    return message.notice;
  }
  const note = message.thread === undefined ? KNOWLEDGE_NOTE.exec(message.body.trim()) : null;
  if (note === null) {
    return null;
  }
  // The board posted it in the topic's own general: the society's for a society topic.
  const { project, channel } = parseChannelRef(message.channel);
  if (channel !== "general" || (note[3] !== undefined) !== (project === null)) {
    return null;
  }
  const parsed = KnowledgeNoticeSchema.safeParse({
    kind: "knowledge",
    action: note[1],
    topic: note[2],
    project,
  });
  return parsed.success ? parsed.data : null;
}

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
    const notice = message === undefined ? null : noticeOf(message);
    if (message === undefined || notice === null) {
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
