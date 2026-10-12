import { Link } from "@tanstack/react-router";
import { LinkedText } from "../components/Entities.js";
import { ago, firstParagraph } from "../lib/format.js";
import type { ThreadSummary } from "../lib/api.js";
import { useDisplayName } from "./Avatar.js";

/** What a thread is about: a task, a proposal, or a topic of its own. */
export function subjectLabel(subject: { kind: string } | undefined): string {
  return subject?.kind ?? "topic";
}

export function StateChip({ state }: { state: "open" | "closed" }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        state === "open" ? "bg-emerald-500/15 text-emerald-300" : "bg-surface-2 text-fg-tertiary"
      }`}
    >
      {state}
    </span>
  );
}

/** A line turning off the stream, for a thread. */
function ThreadMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5">
      <path
        d="M4 2.5v6A2.5 2.5 0 0 0 6.5 11H13m-3-3 3 3-3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A thread in its channel's stream where it was opened, as a quiet line like a notice's that opens
 * it: who opened what, its messages and state, and once closed, its summary under it.
 */
export function ThreadItem({ thread, now }: { thread: ThreadSummary; now: number }) {
  const displayName = useDisplayName();
  const summary = thread.state === "closed" ? firstParagraph(thread.body, 180) : "";
  const replies = thread.messages === 1 ? "1 message" : `${thread.messages} messages`;
  return (
    <Link
      to="/thread/$threadId"
      params={{ threadId: thread.id }}
      className="group flex gap-3 px-4 py-1"
    >
      <span className="grid h-5 w-7 shrink-0 place-items-center text-fg-muted group-hover:text-fg-tertiary">
        <ThreadMark />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          {/* The title gives way first, so the counts and the state stay in view. */}
          <p className="flex min-w-0 flex-1 items-baseline gap-1 text-sm text-fg-tertiary">
            <span className="shrink-0">
              {displayName(thread.openedBy)} opened {subjectLabel(thread.subject)} thread
            </span>
            <span className="min-w-0 truncate text-fg-secondary group-hover:text-fg-primary">
              {thread.title}
            </span>
            <span className="shrink-0">
              · {replies} ·{" "}
              <span className={thread.state === "open" ? "text-emerald-300" : undefined}>
                {thread.state}
              </span>
            </span>
          </p>
          <time dateTime={thread.openedAt} title={thread.openedAt} className="shrink-0 text-meta">
            {ago(thread.openedAt, now)}
          </time>
        </div>
        {summary === "" ? null : (
          <p className="mt-0.5 line-clamp-2 text-sm leading-relaxed text-fg-secondary">
            <LinkedText text={summary} links={false} />
          </p>
        )}
      </div>
    </Link>
  );
}
