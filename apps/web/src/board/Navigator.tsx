import { Link } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { Island } from "../components/Island.js";
import type { ChannelSummary } from "../lib/api.js";
import { initSeen, isUnseen, useSeen } from "../lib/seen.js";
import { useChannels, useProjects, useThreads } from "../lib/session.js";

interface Group {
  readonly key: string;
  readonly label: string;
  readonly channels: readonly ChannelSummary[];
}

/**
 * The left island: the society's channels, then every project's in the order the sky places
 * them, each with its open threads and a dot when something is new since this browser looked.
 */
export function Navigator({ activeChannel }: { activeChannel: string | null }) {
  const channels = useChannels();
  const projects = useProjects();
  const threads = useThreads();
  const seen = useSeen();

  useEffect(() => {
    if (channels.data !== undefined) {
      initSeen(channels.data.map((channel) => [channel.ref, channel.lastMessageId] as const));
    }
  }, [channels.data]);

  const groups = useMemo<Group[]>(() => {
    const all = channels.data ?? [];
    const ordered = (projects.data ?? []).toSorted(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug),
    );
    return [
      { key: "society", label: "Society", channels: all.filter((c) => c.project === null) },
      ...ordered.map((project) => ({
        key: project.slug,
        label: project.name,
        channels: all.filter((channel) => channel.project === project.slug),
      })),
    ];
  }, [channels.data, projects.data]);

  const openThreads = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads.data ?? []) {
      if (thread.state === "open") {
        counts.set(thread.channel, (counts.get(thread.channel) ?? 0) + 1);
      }
    }
    return counts;
  }, [threads.data]);

  return (
    <Island label="Board navigator" className="top-[72px] bottom-4 left-4 w-64">
      <header className="flex items-center justify-between px-4 pt-4 pb-1">
        <span className="text-caps">Board</span>
        <Link
          to="/"
          aria-label="Close the board"
          className="grid size-7 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary"
        >
          ✕
        </Link>
      </header>
      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((group) => (
          <section key={group.key} className="mt-3">
            <h3 className="truncate px-2 pb-1 text-[11px] font-semibold tracking-wider text-fg-muted uppercase">
              {group.label}
            </h3>
            <ul>
              {group.channels.map((channel) => {
                const active = channel.ref === activeChannel;
                const threadCount = openThreads.get(channel.ref) ?? 0;
                const fresh = !active && isUnseen(seen, channel.ref, channel.lastMessageId);
                return (
                  <li key={channel.ref}>
                    <Link
                      to="/c/$"
                      params={{ _splat: channel.ref }}
                      className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-colors ${
                        active
                          ? "bg-surface-2/80 text-fg-primary"
                          : "text-fg-secondary hover:bg-surface-2/50 hover:text-fg-primary"
                      }`}
                    >
                      <span className="text-fg-muted">#</span>
                      <span className={`min-w-0 flex-1 truncate ${fresh ? "font-semibold" : ""}`}>
                        {channel.name}
                      </span>
                      {threadCount > 0 ? (
                        <span
                          title={`${threadCount} open threads`}
                          className="rounded-md bg-surface-2/70 px-1.5 text-[11px] text-fg-tertiary"
                        >
                          {threadCount}
                        </span>
                      ) : null}
                      {fresh ? (
                        <span
                          aria-label="new messages"
                          className="size-1.5 rounded-full bg-emerald-400"
                        />
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
    </Island>
  );
}
