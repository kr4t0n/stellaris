import type { CitizenTokens, Member, MetricsWindow, Runner } from "@stellaris/shared";
import { Link, useSearch } from "@tanstack/react-router";
import { Fragment, useId } from "react";
import { CliIcon } from "../components/CliIcon.js";
import { pairsOf } from "../lib/api.js";
import { ago } from "../lib/format.js";
import {
  useMembers,
  useNow,
  useProjects,
  useRunners,
  useScheduler,
  useTokenUse,
} from "../lib/session.js";
import { runnersOf, scopeName, tokenUseCell } from "./citizen.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { QuotaMark } from "./Quota.js";

const WINDOWS: ReadonlyArray<{
  readonly window: MetricsWindow;
  readonly label: string;
  readonly title: string;
}> = [
  { window: "24h", label: "24h", title: "the last 24 hours" },
  { window: "7d", label: "7d", title: "the last 7 days" },
  { window: "all", label: "All", title: "all time" },
];

/**
 * The model a citizen runs: what its CLI last reported, else what it is set to, else the CLI's own,
 * with the reasoning effort when one is set.
 */
function modelOf(member: Member): string {
  const observed = member.lastModel ?? member.model ?? "CLI default";
  const model =
    member.model !== undefined && member.model !== observed
      ? `${observed} · set to ${member.model}`
      : observed;
  return member.effort === undefined ? model : `${model} · ${member.effort}`;
}

function byName(a: Member, b: Member): number {
  return a.name.localeCompare(b.name);
}

function byRole(a: Member, b: Member): number {
  return a.role.localeCompare(b.role) || byName(a, b);
}

/** A row's state, in one word so the column stays narrow, with more on hover. */
interface RowState {
  readonly label: string;
  readonly detail: string;
  readonly tone: string;
}

/** A row's tokens over the window: as `tokenUseCell` words them, or why they are not shown. */
interface RowTokens {
  readonly label: string;
  readonly detail: string | undefined;
  readonly spoken: string | null;
}

function CitizenRow({
  member,
  state,
  tokens,
  runners,
  placed,
  now,
}: {
  member: Member;
  state: RowState;
  tokens: RowTokens;
  runners: readonly Runner[];
  placed: ReadonlyMap<string, string>;
  now: number;
}) {
  const model = modelOf(member);
  const projects = member.memberships.length === 0 ? "no projects" : member.memberships.join(", ");
  const runner = runnersOf(member, placed);
  return (
    <li className="col-span-full grid grid-cols-subgrid">
      <Link
        to="/citizen/$name"
        params={{ name: member.name }}
        className="col-span-full grid grid-cols-subgrid items-center rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-surface-2/50"
      >
        <span className="relative grid size-4 place-items-center">
          {member.cli === null ? null : <CliIcon cli={member.cli} size={13} />}
          {member.status === "active" ? (
            <QuotaMark member={member} runners={runners} placed={placed} now={now} />
          ) : null}
        </span>
        <span className="text-fg-primary">{member.name}</span>
        <span className="text-fg-secondary">{member.role}</span>
        <span className="truncate text-xs text-fg-muted" title={model}>
          {model}
        </span>
        {/*
          On one line each runner's name stays whole: a hostname's hyphens would otherwise break it
          in every row while the model and projects still had room. A citizen's runners wrap
          between names when the row has no room for them all.
        */}
        <span className="text-xs text-fg-muted" title={runner.detail}>
          {runner.parts.map((part, index) => (
            <Fragment key={part}>
              {index === 0 ? null : " "}
              <span className="@min-[560px]:whitespace-nowrap">{part}</span>
            </Fragment>
          ))}
        </span>
        <span className="truncate text-xs text-fg-muted" title={projects}>
          {projects}
        </span>
        {/*
          The counts, right-aligned so they line up from row to row: a column of their own before
          the state where the list is wide enough, else a line of their own under the row, ending
          at its right edge.
        */}
        <span
          className="col-[2/-1] row-start-2 text-right text-xs whitespace-nowrap text-fg-muted tabular-nums @min-[560px]:col-auto @min-[560px]:row-auto"
          title={tokens.detail}
        >
          {tokens.label}
          {tokens.spoken === null ? null : <span className="sr-only">, {tokens.spoken}</span>}
        </span>
        {/*
          On one line, the state's cell reaches into the column gap, so its separator sits a space
          after the counts, as the separators inside them do.
        */}
        <span className="text-right text-xs whitespace-nowrap @min-[560px]:-ml-2 @min-[560px]:text-left">
          <span aria-hidden="true" className="hidden text-fg-muted @min-[560px]:inline">
            ·{" "}
          </span>
          <span className={state.tone} title={state.detail}>
            {state.label}
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * Every citizen at a glance, one row each in columns, ordered by role: its CLI, marked when its
 * quota is near or at its limit on a runner its turns use, role, model, the runners its turns run
 * on, projects, and the tokens its turns counted over the window the header picks beside what it
 * is doing, or under the row in an island too narrow for them; each opens the citizen's own view.
 * Retired citizens follow in a section of their own.
 */
export function CitizensView() {
  const { window = "24h" } = useSearch({ from: "/citizens" });
  const members = useMembers();
  const scheduler = useScheduler();
  const projectList = useProjects();
  const runners = useRunners();
  const tokenUse = useTokenUse(window);
  const clock = useNow(30_000);
  const switcherLabel = useId();
  const retiredHeading = useId();
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
  const placed = new Map(
    (projectList.data ?? []).flatMap((project) =>
      project.runner === undefined ? [] : [[project.slug, project.runner] as const],
    ),
  );
  const counted = new Map<string, CitizenTokens>(
    (tokenUse.data?.citizens ?? []).map((row) => [row.agent, row]),
  );

  // One word each, so the column stays narrow; where a turn runs is on hover and in Working now.
  const state = (member: Member): RowState => {
    if (member.status !== "active") {
      return {
        label: "retired",
        detail:
          member.retiredAt === undefined ? "retired" : `retired ${ago(member.retiredAt, clock)}`,
        tone: "text-fg-muted",
      };
    }
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

  const tokens = (member: Member): RowTokens => {
    if (tokenUse.data !== undefined) {
      return tokenUseCell(counted.get(member.name), window);
    }
    return tokenUse.error === null
      ? { label: "counting…", detail: undefined, spoken: null }
      : { label: "tokens unknown", detail: tokenUse.error.message, spoken: null };
  };

  const row = (member: Member) => (
    <CitizenRow
      key={member.name}
      member={member}
      state={state(member)}
      tokens={tokens(member)}
      runners={runners.data ?? []}
      placed={placed}
      now={clock}
    />
  );

  const switcher = (
    <nav aria-labelledby={switcherLabel} className="flex shrink-0 items-center gap-1">
      <span id={switcherLabel} className="mr-1 text-caps">
        Tokens
      </span>
      {WINDOWS.map((each) => (
        <Link
          key={each.window}
          to="/citizens"
          search={{ window: each.window }}
          title={each.title}
          aria-current={each.window === window ? "page" : undefined}
          className={`rounded-md px-2 py-1 text-xs transition-colors ${
            each.window === window
              ? "bg-surface-2 text-fg-primary"
              : "text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary"
          }`}
        >
          {each.label}
        </Link>
      ))}
    </nav>
  );

  return (
    <>
      <PaneHeader
        title="Citizens"
        subtitle={`${active.length} active in ${roles === 1 ? "1 role" : `${roles} roles`}${retired.length === 0 ? "" : ` · ${retired.length} retired`}`}
        trailing={switcher}
      />
      <div className="@container flex-1 overflow-y-auto px-2 py-2">
        {active.length === 0 ? (
          <p className="px-2 py-2 text-meta">
            {retired.length === 0 ? "No citizens yet." : "No active citizens."}
          </p>
        ) : null}
        {/*
          Rows are subgrids of one grid, retired ones too, so each column is as wide as its widest
          cell. From a 576 px island, a list 560 px wide inside its padding, the counts are a column
          before the state, and the model and projects share what the other columns leave, the only
          cells that cut. In a narrower island the counts would push the row past its edge, so they
          take a line under it, and the model cuts before the projects go under 3rem.
        */}
        <div className="grid grid-cols-[auto_auto_auto_minmax(0,max-content)_auto_minmax(3rem,1fr)_auto] gap-x-3 @min-[560px]:grid-cols-[auto_auto_auto_minmax(0,max-content)_auto_minmax(0,max-content)_minmax(max-content,1fr)_auto]">
          <ul className="col-span-full grid grid-cols-subgrid">{active.map(row)}</ul>
          {retired.length === 0 ? null : (
            <section
              aria-labelledby={retiredHeading}
              className="col-span-full mt-2 grid grid-cols-subgrid border-t border-line pt-2"
            >
              <h3 id={retiredHeading} className="col-span-full px-2 py-1 text-section">
                Retired
              </h3>
              <ul className="col-span-full grid grid-cols-subgrid">{retired.map(row)}</ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
