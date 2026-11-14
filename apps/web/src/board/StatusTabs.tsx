import { Link } from "@tanstack/react-router";
import { useCrons, useEnrollments, useMembers } from "../lib/session.js";
import { failingCron } from "./crons.js";

/** The society's status views, each at its own address, switched by the strip over them. */
export type StatusView = "citizens" | "runners" | "crons" | "metrics" | "logs";

const VIEWS: ReadonlyMap<string, StatusView> = new Map([
  ["/citizens", "citizens"],
  ["/runners", "runners"],
  ["/crons", "crons"],
  ["/metrics", "metrics"],
  ["/logs", "logs"],
]);

/** The status view an address opens, if it opens one. */
export function statusViewOf(pathname: string): StatusView | null {
  return VIEWS.get(pathname) ?? null;
}

/** A count's type, as the navigator's. */
const COUNT_TYPE = "text-[11px] leading-[16px]";

/** How the society's status reads: its citizens, the runners waiting, the crons failing. */
export function useStatusCounts(): { citizens: number; enrolling: number; failing: number } {
  const members = useMembers();
  return {
    citizens: (members.data ?? []).filter(
      (member) => member.cli !== null && member.status === "active",
    ).length,
    enrolling: useEnrollments().data?.length ?? 0,
    failing: useCrons().data?.filter(failingCron).length ?? 0,
  };
}

/**
 * The strip at the top of the content island over the society's status views, which the
 * navigator's status row opens: each tab is the view's own address, so a view opened from a link
 * shows the strip too, with the counts the row adds up beside the views they belong to.
 */
export function StatusTabs({ active }: { active: StatusView }) {
  const { citizens, enrolling, failing } = useStatusCounts();
  const tabs: ReadonlyArray<{
    view: StatusView;
    to: "/citizens" | "/runners" | "/crons" | "/metrics" | "/logs";
    label: string;
    name?: string;
    count?: { value: number; amber: boolean };
  }> = [
    {
      view: "citizens",
      to: "/citizens",
      label: "Citizens",
      count: { value: citizens, amber: false },
    },
    {
      view: "runners",
      to: "/runners",
      label: "Runners",
      ...(enrolling === 0 ? {} : { name: `Runners, ${enrolling} waiting for approval` }),
      count: { value: enrolling, amber: true },
    },
    {
      view: "crons",
      to: "/crons",
      label: "Crons",
      ...(failing === 0 ? {} : { name: `Crons, ${failing} failing` }),
      count: { value: failing, amber: true },
    },
    { view: "metrics", to: "/metrics", label: "Metrics" },
    { view: "logs", to: "/logs", label: "Logs" },
  ];
  return (
    // The strip wraps: at a larger default font (Chrome's "Large", a 20 px root) the five tabs pass
    // a 420 px panel's width, and the island would clip the last of them.
    <nav aria-label="Status" className="flex flex-wrap gap-1 border-b border-line px-3 py-2">
      {tabs.map((tab) => (
        <Link
          key={tab.view}
          to={tab.to}
          aria-current={tab.view === active ? "page" : undefined}
          aria-label={tab.name}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
            tab.view === active
              ? "bg-surface-2 text-fg-primary"
              : "text-fg-tertiary hover:bg-surface-2/60 hover:text-fg-primary"
          }`}
        >
          {tab.label}
          {tab.count === undefined || tab.count.value === 0 ? null : (
            <span
              className={`rounded px-1 ${COUNT_TYPE} ${
                tab.count.amber
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-surface-2/70 text-fg-tertiary"
              }`}
            >
              {tab.count.value}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}
