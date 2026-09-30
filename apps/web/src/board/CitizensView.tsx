import type { Member } from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import { CliIcon } from "../components/CliIcon.js";
import { pairsOf } from "../lib/api.js";
import { useMembers, useScheduler } from "../lib/session.js";
import { scopeName } from "./citizen.js";
import { PaneHeader, PaneNote } from "./Pane.js";

/** The model a citizen runs: what its CLI last reported, else what it is set to, else the CLI's own. */
function modelOf(member: Member): string {
  const observed = member.lastModel ?? member.model ?? "CLI default";
  return member.model !== undefined && member.model !== observed
    ? `${observed} · set to ${member.model}`
    : observed;
}

function byName(a: Member, b: Member): number {
  return a.name.localeCompare(b.name);
}

function byRole(a: Member, b: Member): number {
  return a.role.localeCompare(b.role) || byName(a, b);
}

/**
 * Every citizen at a glance, one row each in columns, ordered by role: its CLI, role, model,
 * projects, and what it is doing; each opens the citizen's own view.
 */
export function CitizensView() {
  const members = useMembers();
  const scheduler = useScheduler();
  if (members.data === undefined) {
    return <PaneNote>Reading the roster…</PaneNote>;
  }
  // The user takes no turns and has no CLI; it is not a citizen here.
  const citizens = members.data.filter((member) => member.cli !== null);
  const active = citizens.filter((member) => member.status === "active").toSorted(byRole);
  const retired = citizens.filter((member) => member.status !== "active").toSorted(byName);
  const roles = new Set(active.map((member) => member.role)).size;
  const running = pairsOf(scheduler.data?.running ?? []);
  const pending = pairsOf(scheduler.data?.pending ?? []);

  // One word each, so the column stays narrow; where a turn runs is on hover and in Working now.
  const state = (member: Member): { label: string; detail: string; tone: string } => {
    const at = [
      ...new Set(running.filter((pair) => pair.agent === member.name).map((pair) => pair.scope)),
    ];
    if (at.length > 0) {
      return {
        label: "working",
        detail: `in a turn at ${at.map(scopeName).join(" and ")}`,
        tone: "text-emerald-300",
      };
    }
    return pending.some((pair) => pair.agent === member.name)
      ? { label: "queued", detail: "queued for a turn", tone: "text-amber-300" }
      : { label: "resting", detail: "resting", tone: "text-fg-muted" };
  };

  return (
    <>
      <PaneHeader
        title="Citizens"
        subtitle={`${active.length} active in ${roles === 1 ? "1 role" : `${roles} roles`}${retired.length === 0 ? "" : ` · ${retired.length} retired`}`}
      />
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {active.length === 0 ? (
          <p className="px-2 py-2 text-meta">No citizens yet. Ask the concierge for one.</p>
        ) : null}
        {/*
          Rows are subgrids of one grid, so each column is as wide as its widest cell. In a narrow
          island the model cuts before the projects go under 3rem.
        */}
        <ul className="grid grid-cols-[auto_auto_auto_minmax(0,max-content)_minmax(3rem,1fr)_auto] gap-x-3">
          {active.map((member) => {
            const now = state(member);
            const model = modelOf(member);
            const projects =
              member.memberships.length === 0 ? "no projects" : member.memberships.join(", ");
            return (
              <li key={member.name} className="col-span-full grid grid-cols-subgrid">
                <Link
                  to="/citizen/$name"
                  params={{ name: member.name }}
                  className="col-span-full grid grid-cols-subgrid items-center rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-surface-2/50"
                >
                  <span className="grid size-4 place-items-center">
                    {member.cli === null ? null : <CliIcon cli={member.cli} size={13} />}
                  </span>
                  <span className="text-fg-primary">{member.name}</span>
                  <span className="text-fg-secondary">{member.role}</span>
                  <span className="truncate text-fg-secondary" title={model}>
                    {model}
                  </span>
                  <span className="truncate text-xs text-fg-muted" title={projects}>
                    {projects}
                  </span>
                  <span className={`text-right text-xs ${now.tone}`} title={now.detail}>
                    {now.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        {retired.length === 0 ? null : (
          <p className="mt-2 border-t border-line px-2 pt-2 text-meta">
            Retired: {retired.map((member) => `${member.name} (${member.role})`).join(", ")}
          </p>
        )}
      </div>
    </>
  );
}
