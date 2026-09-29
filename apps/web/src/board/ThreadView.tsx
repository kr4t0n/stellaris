import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "../components/Button.js";
import { Markdown } from "../components/Markdown.js";
import { ago } from "../lib/format.js";
import { ApiError } from "../lib/api.js";
import { markSeen } from "../lib/seen.js";
import { useMembers, useNow, useSession } from "../lib/session.js";
import { displayName } from "./Avatar.js";
import { Composer } from "./Composer.js";
import { MessageItem } from "./MessageItem.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { StateChip, subjectLabel } from "./ThreadCard.js";
import { CloseThreadForm } from "./ThreadForms.js";
import { useStickyScroll } from "./useStickyScroll.js";

/** One thread: what it is about, its messages, and its summary once closed. */
export function ThreadView() {
  const { threadId } = useParams({ from: "/thread/$threadId" });
  return <ThreadStream key={threadId} id={threadId} />;
}

function ThreadStream({ id }: { id: string }) {
  const { api } = useSession();
  const detail = useQuery({ queryKey: ["thread", id], queryFn: () => api.thread(id) });
  const members = useMembers();
  const now = useNow(30_000);
  const messages = detail.data?.messages ?? [];
  const newest = messages.at(-1)?.id ?? null;
  useEffect(() => markSeen(id, newest), [id, newest]);
  const { ref, onScroll } = useStickyScroll();
  const [closing, setClosing] = useState(false);

  if (detail.data === undefined) {
    return (
      <PaneNote>
        {detail.error instanceof ApiError && detail.error.status === 404
          ? `There is no thread ${id}.`
          : "Reading the thread…"}
      </PaneNote>
    );
  }
  const { thread } = detail.data;
  return (
    <>
      <PaneHeader
        leading={
          <Link
            to="/c/$"
            params={{ _splat: thread.channel }}
            aria-label={`Back to #${thread.channel}`}
            className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary"
          >
            ←
          </Link>
        }
        title={thread.title}
        subtitle={`${subjectLabel(thread.subject)} thread in #${thread.channel} · opened by ${displayName(
          thread.openedBy,
        )} ${ago(thread.openedAt, now)}`}
        trailing={
          <>
            {thread.subject?.kind === "task" ? (
              <Link
                to="/task/$taskId"
                params={{ taskId: thread.subject.id }}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary"
              >
                Task →
              </Link>
            ) : null}
            {thread.state === "open" && !closing ? (
              <Button onClick={() => setClosing(true)}>Close</Button>
            ) : (
              <StateChip state={thread.state} />
            )}
          </>
        }
      />
      {closing && thread.state === "open" ? (
        <CloseThreadForm
          threadId={thread.id}
          channel={thread.channel}
          onDone={() => setClosing(false)}
        />
      ) : null}
      <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto py-2">
        {messages.length === 0 ? <PaneNote>No messages in this thread yet.</PaneNote> : null}
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} members={members.data} now={now} />
        ))}
        {thread.state === "closed" ? (
          <section className="mx-4 mt-3 mb-2 rounded-xl bg-surface-2/40 px-3.5 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
            <p className="text-caps">
              Closed by {displayName(thread.closedBy ?? "board")}
              {thread.closedAt === undefined ? "" : ` ${ago(thread.closedAt, now)}`}
            </p>
            {thread.body.trim() === "" ? (
              <p className="mt-1 text-meta">It ended with its {subjectLabel(thread.subject)}.</p>
            ) : (
              <Markdown text={thread.body} />
            )}
          </section>
        ) : null}
      </div>
      {thread.state === "open" ? (
        <Composer target={{ threadId: thread.id }} placeholder="Reply in the thread" />
      ) : null}
    </>
  );
}
