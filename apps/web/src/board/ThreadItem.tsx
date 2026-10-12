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
 * it: who opened what, its mark green while it is open, and at its end when it opened, or when it
 * closed with its summary under it.
 */
export function ThreadItem({ thread, now }: { thread: ThreadSummary; now: number }) {
  const displayName = useDisplayName();
  const open = thread.state === "open";
  const summary = open ? "" : firstParagraph(thread.body, 180);
  const closedAt = open ? undefined : thread.closedAt;
  const at = closedAt ?? thread.openedAt;
  return (
    <Link
      to="/thread/$threadId"
      params={{ threadId: thread.id }}
      className="group flex gap-3 px-4 py-1"
    >
      <span
        title={thread.state}
        className={`grid h-5 w-7 shrink-0 place-items-center ${
          open
            ? "text-emerald-400 group-hover:text-emerald-300"
            : "text-fg-muted group-hover:text-fg-tertiary"
        }`}
      >
        <ThreadMark />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <p className="min-w-0 flex-1 truncate text-sm text-fg-tertiary">
            {displayName(thread.openedBy)} opened {subjectLabel(thread.subject)} thread{" "}
            <span className="text-fg-secondary group-hover:text-fg-primary">{thread.title}</span>
            {/* The mark's color alone shows the state on screen. */}
            <span className="sr-only">, {thread.state}</span>
          </p>
          <time
            dateTime={at}
            title={`${closedAt === undefined ? "opened" : "closed"} ${at}`}
            className="shrink-0 text-meta"
          >
            {ago(at, now)}
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
