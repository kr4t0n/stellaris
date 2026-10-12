import { SOCIETY_SCOPE, type KnowledgeNotice } from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ago } from "../lib/format.js";
import { useDisplayName } from "./Avatar.js";
import { knowledgeDone, namesPhrase, type NoticeRun } from "./notices.js";

/** Two open pages, for a knowledge topic's notice. */
function BookMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5">
      <path
        d="M8 4.2C6.4 3 4.4 2.8 2.2 3.4v9.2c2.2-.6 4.2-.4 5.8.8m0-9.2c1.6-1.2 3.6-1.4 5.8-.8v9.2c-2.2-.6-4.2-.4-5.8.8m0-9.2v9.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** What a run of knowledge notices did, to which topic, linked while the topic is there. */
function KnowledgeText({ notices }: { notices: readonly KnowledgeNotice[] }) {
  const [first] = notices;
  if (first === undefined) {
    return null;
  }
  const { did, times } = knowledgeDone(notices);
  return (
    <>
      {did} knowledge{" "}
      {first.action === "removed" ? (
        <span className="text-fg-secondary">{first.topic}</span>
      ) : (
        <Link
          to="/knowledge/$scope/$topic"
          params={{ scope: first.project ?? SOCIETY_SCOPE, topic: first.topic }}
          className="text-fg-secondary hover:text-fg-primary"
        >
          {first.topic}
        </Link>
      )}
      {times === null ? null : ` · ${times}`}
    </>
  );
}

/** A run's mark and what it did, by the kind of notice it is. */
function describe(run: NoticeRun): { mark: ReactNode; text: ReactNode } {
  const knowledge = run.notices.filter((notice) => notice.kind === "knowledge");
  return { mark: <BookMark />, text: <KnowledgeText notices={knowledge} /> };
}

/**
 * A run of notices as one quiet line in the stream, apart from the talk around it: who did what,
 * to what, and when the newest of them was, with every post's author and time on hover.
 */
export function NoticeItem({ run, now }: { run: NoticeRun; now: number }) {
  const displayName = useDisplayName();
  const newest = run.messages.at(-1);
  if (newest === undefined) {
    return null;
  }
  const { mark, text } = describe(run);
  return (
    <div className="flex gap-3 px-4 py-1">
      <span className="grid h-5 w-7 shrink-0 place-items-center text-fg-muted">{mark}</span>
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <p className="min-w-0 flex-1 truncate text-sm text-fg-tertiary">
          {namesPhrase(run.messages.map((message) => displayName(message.author)))} {text}
        </p>
        <time
          dateTime={newest.ts}
          title={run.messages
            .map((message) => `${displayName(message.author)} ${message.ts}`)
            .join("\n")}
          className="shrink-0 text-meta"
        >
          {ago(newest.ts, now)}
        </time>
      </div>
    </div>
  );
}
