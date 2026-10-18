import { isBoardChannel, type Message } from "@stellaris/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { BackLink } from "../components/BackLink.js";
import { Button } from "../components/Button.js";
import { ApiError, type ThreadSummary } from "../lib/api.js";
import { ago } from "../lib/format.js";
import { markSeen } from "../lib/seen.js";
import {
  useChannels,
  useMembers,
  useNow,
  useProjects,
  useSession,
  useThreads,
} from "../lib/session.js";
import { ArchiveChannelForm } from "./ChannelForms.js";
import { Composer } from "./Composer.js";
import { MessageItem } from "./MessageItem.js";
import { NoticeItem } from "./NoticeItem.js";
import { foldNotices } from "./notices.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { StickyList } from "./StickyList.js";
import { ThreadItem } from "./ThreadItem.js";
import { NewThreadForm } from "./ThreadForms.js";

const BACK =
  "grid size-7 shrink-0 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary";

type Item =
  | { kind: "message"; at: string; id: string; message: Message }
  | { kind: "thread"; at: string; id: string; thread: ThreadSummary };

/**
 * A channel's messages in time order, with each thread that hangs off it where it was opened and
 * the notices verbs posted, such as knowledge written, as quiet lines, a run of notices about one
 * subject as one. A channel the board does not use itself can be archived here once its
 * workstream is done.
 */
export function ChannelView() {
  const { _splat: ref = "general" } = useParams({ from: "/c/$" });
  const { message } = useSearch({ from: "/c/$" });
  return <ChannelStream key={ref} channel={ref} target={message} />;
}

function ChannelStream({ channel, target }: { channel: string; target: string | undefined }) {
  const { api } = useSession();
  const messages = useQuery({
    queryKey: ["channel", channel],
    queryFn: () => api.channel(channel),
  });
  const threads = useThreads();
  const members = useMembers();
  const projects = useProjects();
  const channels = useChannels();
  const now = useNow(30_000);
  const [starting, setStarting] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const items = useMemo<Item[]>(() => {
    const posts: Item[] = (messages.data ?? []).map((message) => ({
      kind: "message",
      at: message.ts,
      id: message.id,
      message,
    }));
    const hanging: Item[] = (threads.data ?? [])
      .filter((thread) => thread.channel === channel)
      .map((thread) => ({ kind: "thread", at: thread.openedAt, id: thread.id, thread }));
    return [...posts, ...hanging].toSorted(
      (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
    );
  }, [messages.data, threads.data, channel]);
  const stream = useMemo(
    () => foldNotices(items, (item) => (item.kind === "message" ? item.message : undefined)),
    [items],
  );

  const newest = messages.data?.at(-1)?.id ?? null;
  useEffect(() => markSeen(channel, newest), [channel, newest]);

  const [first, second] = channel.split("/");
  const name = second ?? first ?? channel;
  const project =
    second === undefined ? undefined : projects.data?.find((each) => each.slug === first);
  const place = second === undefined ? "society" : (project?.name ?? first);
  const ended = channels.data?.find((each) => each.ref === channel)?.archived;
  // An archived channel, or any channel of an archived project, is read-only: the board refuses
  // posts and threads there.
  const archived = project?.archived !== undefined || ended !== undefined;
  const mayArchive =
    !archived && !isBoardChannel(second === undefined ? null : (first ?? null), name);
  const open = items.filter((item) => item.kind === "thread" && item.thread.state === "open");
  const parent =
    second === undefined || first === undefined ? (
      <Link to="/society" aria-label="Back to the society" className={BACK}>
        ←
      </Link>
    ) : (
      <Link to="/p/$slug" params={{ slug: first }} aria-label={`Back to ${place}`} className={BACK}>
        ←
      </Link>
    );

  return (
    <>
      <PaneHeader
        leading={<BackLink fallback={parent} />}
        title={`# ${name}`}
        subtitle={`${place} · ${messages.data?.length ?? 0} messages${
          open.length > 0 ? ` · ${open.length} open threads` : ""
        }`}
        trailing={
          starting || archiving || archived ? null : (
            <>
              {mayArchive ? <Button onClick={() => setArchiving(true)}>Archive…</Button> : null}
              <Button onClick={() => setStarting(true)}>New thread</Button>
            </>
          )
        }
      />
      {starting ? <NewThreadForm channel={channel} onDone={() => setStarting(false)} /> : null}
      {archiving ? (
        <ArchiveChannelForm channel={channel} onDone={() => setArchiving(false)} />
      ) : null}
      <StickyList
        stick={target === undefined}
        ids={messages.data?.map((message) => message.id)}
        className="py-2"
      >
        {messages.error instanceof ApiError && messages.error.status === 404 ? (
          <PaneNote>There is no channel {channel}.</PaneNote>
        ) : messages.data === undefined ? (
          <PaneNote>Reading the channel…</PaneNote>
        ) : items.length === 0 ? (
          <PaneNote>Nothing has been said here yet.</PaneNote>
        ) : (
          stream.map((entry) => {
            if (entry.kind === "notices") {
              const key = entry.run.messages[0]?.id ?? "";
              return <NoticeItem key={key} run={entry.run} now={now} />;
            }
            const { item } = entry;
            return item.kind === "message" ? (
              <MessageItem
                key={item.id}
                message={item.message}
                members={members.data}
                now={now}
                target={item.id === target}
              />
            ) : (
              <ThreadItem key={item.id} thread={item.thread} now={now} />
            );
          })
        )}
      </StickyList>
      {messages.data === undefined ? null : ended !== undefined ? (
        <p className="border-t border-line px-4 py-3 text-meta">
          Archived {ago(ended.at, now)} by {ended.by}: {ended.reason}.
        </p>
      ) : archived ? (
        <p className="border-t border-line px-4 py-3 text-meta">
          {place} is archived, so its channels are read-only.
        </p>
      ) : (
        <Composer target={{ channel }} placeholder={`Message #${name}`} />
      )}
    </>
  );
}
