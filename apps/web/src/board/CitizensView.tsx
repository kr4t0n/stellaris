import type { Member } from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import { CliIcon } from "../components/CliIcon.js";
import { pairsOf } from "../lib/api.js";
import { useMembers, useScheduler } from "../lib/session.js";
import { scopeName } from "./citizen.js";
import { Section } from "./Overview.js";
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

/**
 * Every citizen at a glance, grouped by role: its CLI and model, what it is doing, and the
 * projects it belongs to; each opens the citizen's own view.
 */
export function CitizensView() {
  const members = useMembers();
  const scheduler = useScheduler();
  if (members.data === undefined) {
    return <PaneNote>Reading the roster…</PaneNote>;
  }
  // The user takes no turns and has no CLI; it is not a citizen here.
  const citizens = members.data.filter((member) => member.cli !== null);
  const active = citizens.filter((member) => member.status === "active");
  const retired = citizens.filter((member) => member.status !== "active").toSorted(byName);
  const roles = [...new Set(active.map((member) => member.role))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const running = pairsOf(scheduler.data?.running ?? []);
  const pending = pairsOf(scheduler.data?.pending ?? []);

  const state = (member: Member): { label: string; tone: string } => {
    const at = [
      ...new Set(running.filter((pair) => pair.agent === member.name).map((pair) => pair.scope)),
    ];
    if (at.length > 0) {
      return {
        label: `in a turn at ${at.map(scopeName).join(" and ")}`,
        tone: "text-emerald-300",
      };
    }
    return pending.some((pair) => pair.agent === member.name)
      ? { label: "queued", tone: "text-amber-300" }
      : { label: "resting", tone: "text-fg-muted" };
  };

  return (
    <>
      <PaneHeader
        title="Citizens"
        subtitle={`${active.length} active${retired.length === 0 ? "" : ` · ${retired.length} retired`}`}
      />
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {active.length === 0 ? (
          <p className="text-meta">No citizens yet. Ask the concierge for one.</p>
        ) : null}
        {roles.map((role) => {
          const holders = active.filter((member) => member.role === role).toSorted(byName);
          return (
            <Section
              key={role}
              title={role}
              aside={
                <span className="text-meta">
                  {holders.length === 1 ? "1 citizen" : `${holders.length} citizens`}
                </span>
              }
            >
              <ul className="-mx-2">
                {holders.map((member) => {
                  const now = state(member);
                  return (
                    <li key={member.name}>
                      <Link
                        to="/citizen/$name"
                        params={{ name: member.name }}
                        className="flex items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2/50"
                      >
                        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-surface-2/70">
                          {member.cli === null ? null : <CliIcon cli={member.cli} size={15} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="text-sm text-fg-primary">{member.name}</span>
                            <span className="min-w-0 truncate text-sm text-fg-secondary">
                              {modelOf(member)}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-meta">
                            {member.memberships.length === 0
                              ? "no projects"
                              : member.memberships.join(", ")}
                          </span>
                        </span>
                        <span className={`shrink-0 text-xs ${now.tone}`}>{now.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Section>
          );
        })}
        {retired.length === 0 ? null : (
          <Section title="Retired">
            <p className="text-meta">
              {retired.map((member) => `${member.name} (${member.role})`).join(", ")}
            </p>
          </Section>
        )}
      </div>
    </>
  );
}
