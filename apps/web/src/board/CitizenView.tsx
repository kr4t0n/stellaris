import { currentStage, SOCIETY_SCOPE } from "@stellaris/shared";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { CliIcon } from "../components/CliIcon.js";
import { pairsOf } from "../lib/api.js";
import { ago } from "../lib/format.js";
import { elapsed, turnsOf, useLiveTurns, type LiveTurn } from "../lib/live.js";
import {
  useMembers,
  useNow,
  useRoles,
  useScheduler,
  useTasks,
  useTurnHistory,
} from "../lib/session.js";
import { CitizenMemory } from "./CitizenMemory.js";
import { CitizenTurns } from "./CitizenTurns.js";
import { scopeName, wakeScopes, type CitizenTab } from "./citizen.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { time, TranscriptSteps, TurnFooter } from "./Transcript.js";
import { useStickyScroll } from "./useStickyScroll.js";
import { useStoredTurn } from "./useStoredTurn.js";
import { WakeForm } from "./WakeForm.js";

type State = "working" | "queued" | "idle";

const STATE_STYLE: Record<State, string> = {
  working: "bg-emerald-500/15 text-emerald-300",
  queued: "bg-amber-500/15 text-amber-300",
  idle: "bg-surface-2 text-fg-tertiary",
};

/** The tasks a citizen holds a stage of in a project, as links. */
function HeldTasks({ project, name }: { project: string; name: string }) {
  const tasks = useTasks(project);
  const held = (tasks.data ?? []).filter(
    (task) => task.status === "claimed" && task.claimedBy === name,
  );
  if (held.length === 0) {
    return null;
  }
  return (
    <ul className="mt-1.5 space-y-1">
      {held.map((task) => (
        <li key={task.id}>
          <Link
            to="/task/$taskId"
            params={{ taskId: task.id }}
            className="flex items-center gap-2 rounded-md text-xs text-fg-secondary hover:text-fg-primary"
          >
            <span aria-hidden="true" className="text-fg-muted">
              ◇
            </span>
            <span className="min-w-0 flex-1 truncate">{task.title}</span>
            <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-fg-muted">
              {currentStage(task)?.name ?? task.stage}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A citizen: what it is doing now, the turns it took, and what it remembers. */
export function CitizenView() {
  const { name } = useParams({ from: "/citizen/$name" });
  const { scope, tab } = useSearch({ from: "/citizen/$name" });
  return <CitizenPage key={name} name={name} chosen={scope ?? null} tab={tab ?? "now"} />;
}

const TABS: ReadonlyArray<{ readonly tab: CitizenTab; readonly label: string }> = [
  { tab: "now", label: "Now" },
  { tab: "turns", label: "Turns" },
  { tab: "memory", label: "Memory" },
];

function CitizenPage({
  name,
  chosen,
  tab,
}: {
  name: string;
  chosen: string | null;
  tab: CitizenTab;
}) {
  const members = useMembers();
  const roles = useRoles();
  const scheduler = useScheduler();
  const live = useLiveTurns();
  const [waking, setWaking] = useState(false);

  const member = members.data?.find((candidate) => candidate.name === name);
  if (member === undefined) {
    return (
      <PaneNote>
        {members.data === undefined ? "Reading the roster…" : `There is no citizen ${name}.`}
      </PaneNote>
    );
  }
  const runningScopes = pairsOf(scheduler.data?.running ?? [])
    .filter((pair) => pair.agent === name)
    .map((pair) => pair.scope);
  const queued = pairsOf(scheduler.data?.pending ?? []).find((pair) => pair.agent === name);
  const state: State =
    runningScopes.length > 0 ? "working" : queued !== undefined ? "queued" : "idle";
  const latest = turnsOf(live, name)[0];
  const model = latest?.model ?? member.lastModel ?? member.model ?? "CLI default";
  const charter = roles.data?.find((role) => role.name === member.role);
  const scopes = wakeScopes(member, charter);
  const wakeable = member.status === "active" && member.cli !== null && scopes.length > 0;

  return (
    <>
      <PaneHeader
        leading={
          member.cli === null ? null : (
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2/70">
              <CliIcon cli={member.cli} size={20} />
            </span>
          )
        }
        title={name}
        subtitle={
          <>
            {member.role} · <span className="font-mono">{model}</span>
            {member.status === "retired" ? " · retired" : ""}
          </>
        }
        trailing={
          <>
            {wakeable && !waking ? <Button onClick={() => setWaking(true)}>Wake…</Button> : null}
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATE_STYLE[state]}`}
            >
              {state}
            </span>
          </>
        }
      />
      {waking ? (
        <WakeForm
          member={member}
          scopes={scopes}
          preferred={chosen ?? latest?.scope ?? null}
          running={runningScopes}
          paused={scheduler.data?.paused ?? false}
          onDone={() => setWaking(false)}
        />
      ) : null}
      <nav aria-label="Citizen views" className="flex gap-1 border-b border-line px-3 py-2">
        {TABS.map((each) => (
          <Link
            key={each.tab}
            to="/citizen/$name"
            params={{ name }}
            search={{
              ...(chosen === null ? {} : { scope: chosen }),
              ...(each.tab === "now" ? {} : { tab: each.tab }),
            }}
            replace
            aria-current={each.tab === tab ? "page" : undefined}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
              each.tab === tab
                ? "bg-surface-2 text-fg-primary"
                : "text-fg-tertiary hover:bg-surface-2/60 hover:text-fg-primary"
            }`}
          >
            {each.label}
          </Link>
        ))}
      </nav>
      {tab === "turns" ? (
        <CitizenTurns name={name} cli={member.cli} />
      ) : tab === "memory" ? (
        <CitizenMemory member={member} charter={charter} />
      ) : (
        <NowTab
          name={name}
          chosen={chosen}
          lastTurnAt={member.lastTurnAt}
          state={state}
          runningScopes={runningScopes}
          queuedScope={queued?.scope ?? null}
        />
      )}
    </>
  );
}

/** What the citizen is doing: its live turn as it happens, or the last one it took. */
function NowTab({
  name,
  chosen,
  lastTurnAt,
  state,
  runningScopes,
  queuedScope,
}: {
  name: string;
  chosen: string | null;
  lastTurnAt: string | undefined;
  state: State;
  runningScopes: readonly string[];
  queuedScope: string | null;
}) {
  const live = useLiveTurns();
  const now = useNow(5_000);
  const { ref, onScroll } = useStickyScroll();
  const turns = turnsOf(live, name);
  // After a restart the live buffer is empty; the last finished turn is still on disk.
  const history = useTurnHistory(name, 1);
  const stored = useStoredTurn(name, turns.length === 0 ? history.data?.at(-1) : undefined);
  const isRunning = (candidate: LiveTurn): boolean =>
    candidate.end === null && runningScopes.includes(candidate.scope);
  // The turn shown: the one chosen, else the running one that started first, else the latest.
  // Not the most active one, or two busy turns would take the view back and forth.
  const turn =
    turns.find((candidate) => candidate.scope === chosen) ??
    turns.filter(isRunning).toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))[0] ??
    turns[0] ??
    stored.turn;
  const turnRunning = turn !== undefined && isRunning(turn);
  const scope = turn?.scope ?? runningScopes[0] ?? queuedScope;

  return (
    <>
      <section className="border-b border-line px-4 py-3 text-xs text-fg-tertiary">
        <p>
          {turnRunning
            ? `In a turn at ${scopeName(turn.scope)} for ${turn.fromStart ? "" : "at least "}${elapsed(turn.startedAt, now)}`
            : runningScopes.length > 0
              ? `In a turn at ${runningScopes.map(scopeName).join(" and ")}`
              : queuedScope !== null
                ? `Queued for a turn at ${scopeName(queuedScope)}`
                : lastTurnAt === undefined
                  ? "No turns yet"
                  : `Last turn ${ago(lastTurnAt, now)}`}
        </p>
        {scope === null || scope === SOCIETY_SCOPE ? null : (
          <HeldTasks project={scope} name={name} />
        )}
      </section>
      <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-3">
        {turn === undefined ? (
          <PaneNote>
            {state === "working"
              ? "The turn has not reported a step yet."
              : stored.loading
                ? "Reading the last turn…"
                : lastTurnAt === undefined
                  ? `${name} has not taken a turn yet.`
                  : `${name}'s last turn kept no steps; Turns lists every finished one.`}
          </PaneNote>
        ) : (
          <>
            {turns.length > 1 ? (
              <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Turns by scope">
                {turns
                  .toSorted((a, b) => a.scope.localeCompare(b.scope))
                  .map((candidate) => (
                    <Link
                      key={candidate.scope}
                      to="/citizen/$name"
                      params={{ name }}
                      search={{ scope: candidate.scope }}
                      replace
                      aria-current={candidate === turn ? "true" : undefined}
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                        candidate === turn
                          ? "bg-surface-2 text-fg-primary"
                          : "text-fg-tertiary hover:bg-surface-2/60 hover:text-fg-primary"
                      }`}
                    >
                      {isRunning(candidate) ? (
                        <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
                      ) : null}
                      {scopeName(candidate.scope)}
                    </Link>
                  ))}
              </div>
            ) : null}
            <p className="text-caps">
              {turnRunning ? "This turn" : "Last turn"} · {scopeName(turn.scope)} · started{" "}
              {turn.fromStart ? time(turn.startedAt) : "before the earliest step shown"}
            </p>
            {turn.fromStart ? null : (
              <p className="mt-1 text-meta">
                Earlier steps of this turn are no longer in the server's live buffer
                {turnRunning ? "" : "; Turns has the whole turn"}.
              </p>
            )}
            <TranscriptSteps steps={turn.steps} />
            <TurnFooter turn={turn} running={turnRunning} now={now} />
          </>
        )}
      </div>
    </>
  );
}
