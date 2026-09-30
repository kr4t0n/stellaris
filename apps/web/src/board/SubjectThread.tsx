import type { Task } from "@stellaris/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Markdown } from "../components/Markdown.js";
import type { ThreadSummary } from "../lib/api.js";
import { ago } from "../lib/format.js";
import { markSeen } from "../lib/seen.js";
import { useMembers, useSession } from "../lib/session.js";
import { MessageItem } from "./MessageItem.js";

/**
 * The thread of a task or a proposal, shown in its subject's view: everything said about it,
 * oldest first, with each step's post marked, and how it closed.
 */
export function SubjectThread({
  thread,
  now,
  task,
  empty,
}: {
  thread: ThreadSummary;
  now: number;
  /** The task whose thread it is, to name the stages its steps mention. */
  task?: Task | undefined;
  /** What to say while nothing has been posted. */
  empty: string;
}) {
  const { api } = useSession();
  const members = useMembers();
  const detail = useQuery({
    queryKey: ["thread", thread.id],
    queryFn: () => api.thread(thread.id),
  });
  const messages = detail.data?.messages ?? [];
  const newest = messages.at(-1)?.id ?? null;
  useEffect(() => markSeen(thread.id, newest), [thread.id, newest]);
  if (detail.data === undefined) {
    return <p className="mt-2 text-meta">Reading the thread…</p>;
  }
  const record = detail.data.thread;
  return (
    <div className="-mx-4 mt-1">
      {messages.length === 0 ? (
        <p className="mx-4 mt-1 text-meta">{empty}</p>
      ) : (
        messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            members={members.data}
            now={now}
            task={task}
          />
        ))
      )}
      {thread.state === "closed" ? (
        <div className="mx-4 mt-2">
          <p className="text-meta">
            Closed{record.closedAt === undefined ? "" : ` ${ago(record.closedAt, now)}`}
            {record.body.trim() === "" ? "." : ":"}
          </p>
          {record.body.trim() === "" ? null : <Markdown text={record.body} />}
        </div>
      ) : null}
    </div>
  );
}
