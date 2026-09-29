import { Link } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { Island } from "../components/Island.js";
import type { ChannelSummary } from "../lib/api.js";
import { initSeen, isUnseen, useSeen } from "../lib/seen.js";
import { useChannels, useProjects, useProposals, useTasks, useThreads } from "../lib/session.js";
import { waitingOnYou } from "./governance.js";
import { useNeedsYou } from "./useNeedsYou.js";
import { inPlay } from "./tasks.js";
import { WorkingNow } from "./WorkingNow.js";

/** The governance view that is open, if one is. */
export type GovernanceView = "needs-you" | "proposals";

interface Group {
  readonly key: string;
  readonly label: string;
  /** The project's slug; the society has no tasks. */
  readonly project: string | null;
  readonly channels: readonly ChannelSummary[];
}

const ROW = "flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-colors";
const ROW_ACTIVE = "bg-surface-2/80 text-fg-primary";
const ROW_IDLE = "text-fg-secondary hover:bg-surface-2/50 hover:text-fg-primary";

/** A project's tasks entry, with how many of its tasks are still in play. */
function TasksEntry({ slug, active }: { slug: string; active: boolean }) {
  const tasks = useTasks(slug);
  const count = (tasks.data ?? []).filter(inPlay).length;
  return (
    <li>
      <Link
        to="/p/$slug/tasks"
        params={{ slug }}
        className={`${ROW} ${active ? ROW_ACTIVE : ROW_IDLE}`}
      >
        <span aria-hidden="true" className="text-fg-muted">
          ◇
        </span>
        <span className="min-w-0 flex-1 truncate">tasks</span>
        {count > 0 ? (
          <span
            title={`${count} tasks in play`}
            className="rounded-md bg-surface-2/70 px-1.5 text-[11px] text-fg-tertiary"
          >
            {count}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

function Count({ value, title }: { value: number; title: string }) {
  return value === 0 ? null : (
    <span title={title} className="rounded-md bg-amber-500/15 px-1.5 text-[11px] text-amber-300">
      {value}
    </span>
  );
}

/** Where the user decides: what waits on the user, and the proposals, each with its count. */
function Governance({ active }: { active: GovernanceView | null }) {
  const proposals = useProposals();
  const waiting = (proposals.data ?? []).filter(waitingOnYou).length;
  const attention = useNeedsYou().length;
  return (
    <section aria-label="Governance" className="mt-3">
      <h3 className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-fg-muted uppercase">
        Governance
      </h3>
      <ul>
        <li>
          <Link
            to="/needs-you"
            className={`${ROW} ${active === "needs-you" ? ROW_ACTIVE : ROW_IDLE}`}
          >
            <span aria-hidden="true" className="text-fg-muted">
              ◉
            </span>
            <span className="min-w-0 flex-1 truncate">needs you</span>
            <Count value={attention} title={`${attention} waiting on you`} />
          </Link>
        </li>
        <li>
          <Link
            to="/proposals"
            className={`${ROW} ${active === "proposals" ? ROW_ACTIVE : ROW_IDLE}`}
          >
            <span aria-hidden="true" className="text-fg-muted">
              ◈
            </span>
            <span className="min-w-0 flex-1 truncate">proposals</span>
            <Count value={waiting} title={`${waiting} waiting on you`} />
          </Link>
        </li>
      </ul>
    </section>
  );
}

/**
 * The left island: who is working now, what waits on the user's decision, then the society's channels and every project's in the
 * order the sky places them, each with its open threads and a dot when something is new since
 * this browser looked.
 */
export function Navigator({
  activeChannel,
  activeTasks,
  activeCitizen,
  activeScope,
  activeGovernance,
}: {
  activeChannel: string | null;
  /** The project whose tasks are open, when a tasks view or a task is. */
  activeTasks: string | null;
  /** The citizen whose view is open, and the scope of the turn it shows when one was chosen. */
  activeCitizen: string | null;
  activeScope: string | null;
  activeGovernance: GovernanceView | null;
}) {
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
      {
        key: "society",
        label: "Society",
        project: null,
        channels: all.filter((c) => c.project === null),
      },
      ...ordered.map((project) => ({
        key: project.slug,
        label: project.name,
        project: project.slug,
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
        <WorkingNow activeCitizen={activeCitizen} activeScope={activeScope} />
        <Governance active={activeGovernance} />
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
                      className={`${ROW} ${active ? ROW_ACTIVE : ROW_IDLE}`}
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
              {group.project === null ? null : (
                <TasksEntry slug={group.project} active={group.project === activeTasks} />
              )}
            </ul>
          </section>
        ))}
      </nav>
    </Island>
  );
}
