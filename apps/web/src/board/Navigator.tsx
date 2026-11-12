import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo } from "react";
import { Island } from "../components/Island.js";
import type { BoardLayout } from "../lib/layout.js";
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

/** A group's heading, which opens the society's or the project's overview. */
function heading(active: boolean): string {
  return `block truncate rounded-md px-2 text-[11px] font-semibold tracking-wider uppercase transition-colors ${
    active ? "text-fg-primary" : "text-fg-muted hover:text-fg-primary"
  }`;
}
/**
 * A count's type: 11 px on a 16 px line. The font centres its digits between its ascent and descent,
 * but Chromium rounds those to whole device pixels and floors the half-leading. On this line the
 * digits sit in the middle of the pill at device scales 1 and 3 and within half a device pixel
 * between, but a device pixel high at 2, where the rounded font takes an odd 27; on the row's own
 * 15.7 px line they sit 0.8 px high at 1 (docs/internals/interface.md).
 */
const COUNT_TYPE = "text-[11px] leading-[16px]";
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
          <RowEnd>
            <span
              title={`${count} tasks in play`}
              className={`rounded-md bg-surface-2/70 px-1.5 ${COUNT_TYPE} text-fg-tertiary`}
            >
              {count}
            </span>
          </RowEnd>
        ) : null}
      </Link>
    </li>
  );
}

/**
 * The end of a row that shows a count: a slot 28 px wide, about a three-digit count's width, whose
 * middle is the same line in every row, so counts are centred on it; a wider one grows both ways.
 */
function RowEnd({ children }: { children: ReactNode }) {
  return <span className="flex w-7 shrink-0 justify-center">{children}</span>;
}

function Count({ value, title }: { value: number; title: string }) {
  return value === 0 ? null : (
    <RowEnd>
      <span
        title={title}
        className={`rounded-md bg-amber-500/15 px-1.5 ${COUNT_TYPE} text-amber-300`}
      >
        {value}
      </span>
    </RowEnd>
  );
}

/** Where the user decides: what waits on the user and the proposals, each with its count. */
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
 * order the sky places them, each with its open threads and its name in bold when something is new
 * since this browser looked, and last the archived projects, each opening its overview.
 */
export function Navigator({
  activeChannel,
  activeTasks,
  activeCitizen,
  activeScope,
  activeGovernance,
  activeOverview,
  embedded = false,
  layout,
  onLayout,
}: {
  /** Prototype: drawn as the board panel's first column instead of an island of its own. */
  embedded?: boolean;
  /** Prototype: where the board sits, and the switch between the two. */
  layout: BoardLayout;
  onLayout: (layout: BoardLayout) => void;
  activeChannel: string | null;
  /** The project whose tasks are open, when a tasks view or a task is. */
  activeTasks: string | null;
  /** The citizen whose view is open, and the scope of the turn it shows when one was chosen. */
  activeCitizen: string | null;
  activeScope: string | null;
  activeGovernance: GovernanceView | null;
  /** The project slug, or the society scope, whose overview or knowledge is open. */
  activeOverview: string | null;
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

  const ordered = useMemo(
    () =>
      (projects.data ?? []).toSorted(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug),
      ),
    [projects.data],
  );
  const archived = ordered.filter((project) => project.archived !== undefined);

  const groups = useMemo<Group[]>(() => {
    // An archived channel is reached from its place's overview, with the place's history.
    const all = (channels.data ?? []).filter((channel) => channel.archived === undefined);
    return [
      {
        key: "society",
        label: "Society",
        project: null,
        channels: all.filter((c) => c.project === null),
      },
      ...ordered
        .filter((project) => project.archived === undefined)
        .map((project) => ({
          key: project.slug,
          label: project.name,
          project: project.slug,
          channels: all.filter((channel) => channel.project === project.slug),
        })),
    ];
  }, [channels.data, ordered]);

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
    <Frame embedded={embedded}>
      <header className="flex items-center justify-between px-4 pt-4 pb-1">
        <span className="text-caps">Board</span>
        <div className="flex items-center gap-1">
          <LayoutSwitch layout={layout} onLayout={onLayout} />
          <Link
            to="/"
            aria-label="Close the board"
            className="grid size-7 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary"
          >
            ✕
          </Link>
        </div>
      </header>
      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        <WorkingNow activeCitizen={activeCitizen} activeScope={activeScope} />
        <Governance active={activeGovernance} />
        {groups.map((group) => (
          <section key={group.key} className="mt-3">
            <h3 className="pb-1">
              {group.project === null ? (
                <Link to="/society" className={heading(activeOverview === group.key)}>
                  {group.label}
                </Link>
              ) : (
                <Link
                  to="/p/$slug"
                  params={{ slug: group.project }}
                  className={heading(activeOverview === group.key)}
                >
                  {group.label}
                </Link>
              )}
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
                      {fresh ? <span className="sr-only">new messages</span> : null}
                      {threadCount > 0 ? (
                        <RowEnd>
                          <span
                            title={`${threadCount} open threads`}
                            className={`rounded-md bg-surface-2/70 px-1.5 ${COUNT_TYPE} text-fg-tertiary`}
                          >
                            {threadCount}
                          </span>
                        </RowEnd>
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
        {archived.length === 0 ? null : (
          <section aria-label="Archived projects" className="mt-3">
            <h3 className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-fg-muted uppercase">
              Archived
            </h3>
            <ul>
              {archived.map((project) => (
                <li key={project.slug}>
                  <Link
                    to="/p/$slug"
                    params={{ slug: project.slug }}
                    className={`${ROW} ${activeOverview === project.slug ? ROW_ACTIVE : ROW_IDLE}`}
                  >
                    <span aria-hidden="true" className="text-fg-muted">
                      ▫
                    </span>
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </nav>
    </Frame>
  );
}

/** Prototype: the navigator as an island of its own, or as a column of the one board panel. */
function Frame({ embedded, children }: { embedded: boolean; children: ReactNode }) {
  return embedded ? (
    <section
      aria-label="Board navigator"
      className="flex w-64 shrink-0 flex-col border-r border-line"
    >
      {children}
    </section>
  ) : (
    <Island label="Board navigator" className="top-[72px] bottom-4 left-4 w-64">
      {children}
    </Island>
  );
}

const LAYOUT_NAME: Record<BoardLayout, string> = {
  around: "Board around the sky",
  beside: "Board beside the sky",
};

const SWITCH =
  "grid size-7 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none";

/** A window with the board's islands in it and a star for the sky: between them, or to the right. */
function LayoutMark({ layout }: { layout: BoardLayout }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true">
      <rect x="1" y="2.5" width="14" height="11" rx="2" fill="none" stroke="currentColor" />
      {layout === "around" ? (
        <>
          <rect x="2.5" y="4" width="2.5" height="8" rx="0.75" fill="currentColor" />
          <circle cx="7.75" cy="8" r="1.1" fill="currentColor" />
          <rect x="10.5" y="4" width="3" height="8" rx="0.75" fill="currentColor" />
        </>
      ) : (
        <>
          <rect x="2.5" y="4" width="6.5" height="8" rx="0.75" fill="currentColor" />
          <circle cx="11.75" cy="8" r="1.1" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/**
 * Prototype: the switch between the two layouts, as one button showing the layout it switches to,
 * or (with `stellaris.switchForm` set to `pair` in local storage) as two, the current one pressed.
 */
function LayoutSwitch({
  layout,
  onLayout,
}: {
  layout: BoardLayout;
  onLayout: (layout: BoardLayout) => void;
}) {
  const other: BoardLayout = layout === "around" ? "beside" : "around";
  if (localStorage.getItem("stellaris.switchForm") === "pair") {
    return (
      <div role="group" aria-label="Board layout" className="flex rounded-lg bg-surface-2/40 p-0.5">
        {(["around", "beside"] as const).map((each) => (
          <button
            key={each}
            type="button"
            aria-label={LAYOUT_NAME[each]}
            title={LAYOUT_NAME[each]}
            aria-pressed={each === layout}
            onClick={() => onLayout(each)}
            className={`grid h-6 w-7 place-items-center rounded-md focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none ${
              each === layout
                ? "bg-surface-2 text-fg-primary"
                : "text-fg-tertiary hover:text-fg-primary"
            }`}
          >
            <LayoutMark layout={each} />
          </button>
        ))}
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={LAYOUT_NAME[other]}
      title={LAYOUT_NAME[other]}
      onClick={() => onLayout(other)}
      className={SWITCH}
    >
      <LayoutMark layout={other} />
    </button>
  );
}
