import type { Message } from "@stellaris/shared";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { ApiError, type ThreadSummary } from "../lib/api.js";
import { markSeen } from "../lib/seen.js";
import { useMembers, useNow, useProjects, useSession, useThreads } from "../lib/session.js";
import { MessageItem } from "./MessageItem.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { ThreadCard } from "./ThreadCard.js";
import { useStickyScroll } from "./useStickyScroll.js";

type Item =
  | { kind: "message"; at: string; id: string; message: Message }
  | { kind: "thread"; at: string; id: string; thread: ThreadSummary };

/** A channel's messages in time order, with each thread that hangs off it where it was opened. */
export function ChannelView() {
  const { _splat: ref = "general" } = useParams({ from: "/c/$" });
  return <ChannelStream key={ref} channel={ref} />;
}

function ChannelStream({ channel }: { channel: string }) {
  const { api } = useSession();
  const messages = useQuery({
    queryKey: ["channel", channel],
    queryFn: () => api.channel(channel),
  });
  const threads = useThreads();
  const members = useMembers();
  const projects = useProjects();
  const now = useNow(30_000);

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

  const newest = messages.data?.at(-1)?.id ?? null;
  useEffect(() => markSeen(channel, newest), [channel, newest]);
  const { ref, onScroll } = useStickyScroll();

  const [first, second] = channel.split("/");
  const name = second ?? first ?? channel;
  const place =
    second === undefined
      ? "society"
      : (projects.data?.find((project) => project.slug === first)?.name ?? first);
  const open = items.filter((item) => item.kind === "thread" && item.thread.state === "open");

  return (
    <>
      <PaneHeader
        title={`# ${name}`}
        subtitle={`${place} · ${messages.data?.length ?? 0} messages${
          open.length > 0 ? ` · ${open.length} open threads` : ""
        }`}
      />
      <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto py-2">
        {messages.error instanceof ApiError && messages.error.status === 404 ? (
          <PaneNote>There is no channel {channel}.</PaneNote>
        ) : messages.data === undefined ? (
          <PaneNote>Reading the channel…</PaneNote>
        ) : items.length === 0 ? (
          <PaneNote>Nothing has been said here yet.</PaneNote>
        ) : (
          items.map((item) =>
            item.kind === "message" ? (
              <MessageItem key={item.id} message={item.message} members={members.data} now={now} />
            ) : (
              <ThreadCard key={item.id} thread={item.thread} now={now} />
            ),
          )
        )}
      </div>
    </>
  );
}
