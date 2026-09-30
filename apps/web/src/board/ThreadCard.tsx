import { Link } from "@tanstack/react-router";
import { LinkedText } from "../components/Entities.js";
import { ago, firstParagraph } from "../lib/format.js";
import type { ThreadSummary } from "../lib/api.js";

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

/** A thread shown in its channel at the moment it was opened, as a card that opens it. */
export function ThreadCard({ thread, now }: { thread: ThreadSummary; now: number }) {
  const summary = thread.state === "closed" ? firstParagraph(thread.body, 180) : "";
  const replies = thread.messages === 1 ? "1 message" : `${thread.messages} messages`;
  return (
    <Link
      to="/thread/$threadId"
      params={{ threadId: thread.id }}
      className="mx-4 my-2 block rounded-xl bg-surface-2/40 px-3.5 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] transition-colors hover:bg-surface-2/70"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-fg-muted">
          ↳
        </span>
        <span className="text-title min-w-0 flex-1 truncate">{thread.title}</span>
        <StateChip state={thread.state} />
      </div>
      <p className="mt-1 text-meta">
        {subjectLabel(thread.subject)} thread by {thread.openedBy} · {replies} · opened{" "}
        {ago(thread.openedAt, now)}
      </p>
      {summary === "" ? null : (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-fg-secondary">
          <LinkedText text={summary} links={false} />
        </p>
      )}
    </Link>
  );
}
