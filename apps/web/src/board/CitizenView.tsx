import { currentStage, SOCIETY_SCOPE, type RunningTurn } from "@stellaris/shared";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { CliIcon } from "../components/CliIcon.js";
import { useEntities } from "../components/Entities.js";
import { pairsOf } from "../lib/api.js";
import { ago } from "../lib/format.js";
import {
  conversationOf,
  elapsed,
  pairKey,
  turnsOf,
  useLiveTurns,
  type LiveTurn,
} from "../lib/live.js";
import {
  useCrons,
  useMembers,
  useNow,
  useRoles,
  useScheduler,
  useTasks,
  useTurnHistory,
} from "../lib/session.js";
import { CitizenHistory } from "./CitizenHistory.js";
import { CitizenMemory } from "./CitizenMemory.js";
import { CitizenTurns } from "./CitizenTurns.js";
import { scopeName, wakeScopes, type CitizenTab } from "./citizen.js";
import { ModelForm } from "./ModelForm.js";
import { RunnerForm } from "./RunnerForm.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { time, TranscriptSteps, TurnFooter } from "./Transcript.js";
import { TurnControls } from "./TurnControls.js";
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
  const { scope, tab, turn } = useSearch({ from: "/citizen/$name" });
  return (
    <CitizenPage
      key={name}
      name={name}
      chosen={scope ?? null}
      tab={tab ?? "now"}
      turn={turn ?? null}
    />
  );
}

const TABS: ReadonlyArray<{ readonly tab: CitizenTab; readonly label: string }> = [
  { tab: "now", label: "Now" },
  { tab: "turns", label: "Turns" },
  { tab: "memory", label: "Memory" },
  { tab: "history", label: "History" },
];

function CitizenPage({
  name,
  chosen,
  tab,
  turn,
}: {
  name: string;
  chosen: string | null;
  tab: CitizenTab;
  turn: string | null;
}) {
  const members = useMembers();
  const roles = useRoles();
  const scheduler = useScheduler();
  const live = useLiveTurns();
  const crons = useCrons();
  const [open, setOpen] = useState<"wake" | "model" | "runner" | null>(null);

  const member = members.data?.find((candidate) => candidate.name === name);
  if (member === undefined) {
    return (
      <PaneNote>
        {members.data === undefined ? "Reading the roster…" : `There is no citizen ${name}.`}
      </PaneNote>
    );
  }
  const running = pairsOf(scheduler.data?.running ?? []).filter((pair) => pair.agent === name);
  const runningScopes = [...new Set(running.map((pair) => pair.scope))];
  const runningKeys = running.map((pair) => pairKey(pair.agent, pair.scope, pair));
  const queued = pairsOf(scheduler.data?.pending ?? []).find((pair) => pair.agent === name);
  const state: State =
    runningScopes.length > 0 ? "working" : queued !== undefined ? "queued" : "idle";
  const latest = turnsOf(live, name)[0];
  // What the CLI last reported, then what the citizen is set to when that differs.
  const observed = latest?.model ?? member.lastModel;
  const model = observed ?? member.model ?? "CLI default";
  const setTo = member.model !== undefined && member.model !== observed ? member.model : null;
  const charter = roles.data?.find((role) => role.name === member.role);
  const scopes = wakeScopes(member);
  const wakeable = member.status === "active" && member.cli !== null;
  const ownCrons = (crons.data ?? []).filter(
    (cron) => cron.agent === name && cron.ended === undefined,
  ).length;

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
            {member.role} · {model}
            {setTo === null ? "" : ` · set to ${setTo}`}
            {member.effort === undefined ? "" : ` · ${member.effort} effort`}
            {member.homeRunner === undefined ? "" : ` · on ${member.homeRunner}`}
            {member.status === "retired" ? " · retired" : ""}
          </>
        }
        trailing={
          <>
            {ownCrons === 0 ? null : (
              <Link
                to="/crons"
                search={{ agent: name }}
                className="inline-flex h-7 shrink-0 items-center rounded-md px-3 text-xs text-fg-tertiary transition-colors hover:bg-surface-2/70 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
              >
                {ownCrons === 1 ? "1 cron" : `${ownCrons} crons`}
              </Link>
            )}
            {wakeable && open === null ? (
              <>
                <Button onClick={() => setOpen("model")}>Model…</Button>
                <Button onClick={() => setOpen("runner")}>Runner…</Button>
                <Button onClick={() => setOpen("wake")}>Wake…</Button>
              </>
            ) : null}
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATE_STYLE[state]}`}
            >
              {state}
            </span>
          </>
        }
      />
      {open === "wake" ? (
        <WakeForm
          member={member}
          scopes={scopes}
          preferred={chosen?.split("/")[0] ?? latest?.scope ?? null}
          running={runningScopes}
          paused={scheduler.data?.paused ?? false}
          onDone={() => setOpen(null)}
        />
      ) : open === "model" ? (
        <ModelForm member={member} onDone={() => setOpen(null)} />
      ) : open === "runner" ? (
        <RunnerForm member={member} onDone={() => setOpen(null)} />
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
        <CitizenTurns key={turn} name={name} opened={turn} />
      ) : tab === "memory" ? (
        <CitizenMemory member={member} charter={charter} />
      ) : tab === "history" ? (
        <CitizenHistory name={name} />
      ) : (
        <NowTab
          name={name}
          chosen={chosen}
          lastTurnAt={member.lastTurnAt}
          state={state}
          runningScopes={runningScopes}
          runningKeys={runningKeys}
          runningTurns={(scheduler.data?.turns ?? []).filter((each) => each.agent === name)}
          queuedScope={queued?.scope ?? null}
        />
      )}
    </>
  );
}

/** The turn that started first. */
function earliest(candidates: readonly LiveTurn[]): LiveTurn | undefined {
  return candidates.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
}

/** What the citizen is doing: its live turn as it happens, or the last one it took. */
function NowTab({
  name,
  chosen,
  lastTurnAt,
  state,
  runningScopes,
  runningKeys,
  runningTurns,
  queuedScope,
}: {
  name: string;
  /** The conversation the address picks: a scope, or `scope/thread`. */
  chosen: string | null;
  lastTurnAt: string | undefined;
  state: State;
  runningScopes: readonly string[];
  /** The citizen's sessions with a turn in flight, as the scheduler keys them. */
  runningKeys: readonly string[];
  /** Those turns as the runners see them: whether each takes posts and can be stopped. */
  runningTurns: readonly RunningTurn[];
  queuedScope: string | null;
}) {
  const live = useLiveTurns();
  const now = useNow(5_000);
  const { ref, onScroll } = useStickyScroll();
  const turns = turnsOf(live, name);
  // After a restart the live buffer is empty; the last finished turn is still on disk.
  const history = useTurnHistory(name, 1);
  const stored = useStoredTurn(name, turns.length === 0 ? history.data?.at(-1) : undefined);
  const entities = useEntities();
  const isRunning = (candidate: LiveTurn): boolean =>
    candidate.end === null &&
    runningKeys.includes(pairKey(candidate.agent, candidate.scope, candidate));
  const chosenScope = chosen?.split("/")[0] ?? null;
  // The turn shown: the conversation chosen, else a running one in the scope chosen, else the
  // running one that started first, else the latest. Not the most active one, or two busy turns
  // would take the view back and forth.
  const turn =
    (chosen?.includes("/") === true
      ? turns.find((candidate) => conversationOf(candidate) === chosen)
      : undefined) ??
    earliest(
      turns.filter((candidate) => candidate.scope === chosenScope && isRunning(candidate)),
    ) ??
    turns.find((candidate) => conversationOf(candidate) === chosen) ??
    earliest(turns.filter(isRunning)) ??
    turns[0] ??
    stored.turn;
  // Where a turn was: its scope, and the thread's title or the channel for a conversation of its own.
  const placeOf = (candidate: LiveTurn): string =>
    candidate.thread !== undefined
      ? `${scopeName(candidate.scope)} · ${entities.get(candidate.thread)?.title ?? "a thread"}`
      : candidate.channel === undefined
        ? scopeName(candidate.scope)
        : `${scopeName(candidate.scope)} · #${candidate.channel}`;
  const turnRunning = turn !== undefined && isRunning(turn);
  const scope = turn?.scope ?? runningScopes[0] ?? queuedScope;
  // The controls are for the turn shown, else for the citizen's first turn in flight, which may
  // not have reported a step yet.
  const control =
    (turn === undefined
      ? undefined
      : runningTurns.find(
          (candidate) =>
            candidate.scope === turn.scope &&
            candidate.thread === turn.thread &&
            candidate.channel === turn.channel,
        )) ?? (turnRunning ? undefined : runningTurns[0]);

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
              <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Turns by conversation">
                {turns
                  .toSorted((a, b) => conversationOf(a).localeCompare(conversationOf(b)))
                  .map((candidate) => (
                    <Link
                      key={conversationOf(candidate)}
                      to="/citizen/$name"
                      params={{ name }}
                      search={{ scope: conversationOf(candidate) }}
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
                      {placeOf(candidate)}
                    </Link>
                  ))}
              </div>
            ) : null}
            <p className="text-caps">
              {turnRunning ? "This turn" : "Last turn"} · {placeOf(turn)} · started{" "}
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
      {control === undefined ? null : <TurnControls name={name} turn={control} />}
    </>
  );
}
