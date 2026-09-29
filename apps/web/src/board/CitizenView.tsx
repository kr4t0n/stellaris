import { currentStage, SOCIETY_SCOPE, type TurnExitReason } from "@stellaris/shared";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { CliIcon } from "../components/CliIcon.js";
import { Markdown } from "../components/Markdown.js";
import { pairsOf } from "../lib/api.js";
import { ago } from "../lib/format.js";
import {
  elapsed,
  toolLabel,
  turnsOf,
  useLiveTurns,
  type LiveTurn,
  type Step,
} from "../lib/live.js";
import { useMembers, useNow, useScheduler, useTasks } from "../lib/session.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { useStickyScroll } from "./useStickyScroll.js";

type State = "working" | "queued" | "idle";

const STATE_STYLE: Record<State, string> = {
  working: "bg-emerald-500/15 text-emerald-300",
  queued: "bg-amber-500/15 text-amber-300",
  idle: "bg-surface-2 text-fg-tertiary",
};

const OUTCOME: Record<TurnExitReason, string> = {
  completed: "completed",
  timeout: "timed out",
  error: "failed",
  interrupted: "was interrupted",
  blocked: "was blocked",
};

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function scopeName(scope: string): string {
  return scope === SOCIETY_SCOPE ? "the society" : scope;
}

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

function StepItem({ step }: { step: Step }) {
  if (step.kind === "say") {
    return (
      <li className="py-1.5 text-sm" title={time(step.at)}>
        <Markdown text={step.text} />
      </li>
    );
  }
  if (step.kind === "error") {
    return (
      <li className="py-1 font-mono text-xs break-words text-red-400" title={time(step.at)}>
        {step.message}
      </li>
    );
  }
  const status =
    step.ok === null ? (
      <span aria-label="running" className="size-1.5 animate-pulse rounded-full bg-amber-300" />
    ) : step.ok ? (
      <span aria-label="succeeded" className="text-[11px] text-emerald-400">
        ✓
      </span>
    ) : (
      <span aria-label="failed" className="text-[11px] text-red-400">
        ✕
      </span>
    );
  return (
    <li>
      <details className="group rounded-md open:bg-surface-2/30">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-surface-2/40">
          <span className="grid w-3 shrink-0 place-items-center">{status}</span>
          <span className="shrink-0 font-mono text-fg-tertiary">{toolLabel(step.name)}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-fg-secondary">
            {step.summary}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-fg-muted">{time(step.at)}</span>
        </summary>
        <pre className="mx-1.5 mb-1.5 max-h-64 overflow-auto rounded-md bg-surface-0/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-secondary">
          {step.detail}
        </pre>
      </details>
    </li>
  );
}

/** How the turn stands at the end of its transcript. */
function TurnFooter({ turn, running, now }: { turn: LiveTurn; running: boolean; now: number }) {
  if (turn.end !== null) {
    const cost = turn.end.costUsd > 0 ? ` · $${turn.end.costUsd.toFixed(2)}` : "";
    return (
      <section className="mt-3 rounded-xl bg-surface-2/40 px-3.5 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
        <p className="text-caps">
          The turn {OUTCOME[turn.end.exitReason]} {ago(turn.end.at, now)}
          {cost}
          {turn.fromStart ? ` · ${elapsed(turn.startedAt, Date.parse(turn.end.at))}` : ""}
        </p>
        {turn.end.summary === null ? null : (
          <p className="mt-1 text-sm text-fg-secondary">{turn.end.summary}</p>
        )}
      </section>
    );
  }
  if (!running) {
    return <p className="mt-3 text-meta">The turn ended without a report.</p>;
  }
  return (
    <p className="mt-3 flex items-center gap-2 text-meta" aria-live="polite">
      <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
      Working · last step {ago(turn.lastAt, now)}
    </p>
  );
}

/** A citizen and what it is doing: its live turn as it happens, or the last one it took. */
export function CitizenView() {
  const { name } = useParams({ from: "/citizen/$name" });
  return <CitizenLive key={name} name={name} />;
}

function CitizenLive({ name }: { name: string }) {
  const members = useMembers();
  const scheduler = useScheduler();
  const live = useLiveTurns();
  const now = useNow(5_000);
  const { ref, onScroll } = useStickyScroll();
  const [picked, setPicked] = useState<string | null>(null);

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
  const turns = turnsOf(live, name);
  const isRunning = (candidate: LiveTurn): boolean =>
    candidate.end === null && runningScopes.includes(candidate.scope);
  // The turn shown: the one picked, else one running now, else the most recent.
  const turn =
    turns.find((candidate) => candidate.scope === picked) ?? turns.find(isRunning) ?? turns[0];
  const turnRunning = turn !== undefined && isRunning(turn);
  const scope = turn?.scope ?? runningScopes[0] ?? queued?.scope ?? null;
  const model = turn?.model ?? member.lastModel ?? member.model ?? "CLI default";

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
          </>
        }
        trailing={
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATE_STYLE[state]}`}
          >
            {state}
          </span>
        }
      />
      <section className="border-b border-line px-4 py-3 text-xs text-fg-tertiary">
        <p>
          {turnRunning
            ? `In a turn at ${scopeName(turn.scope)} for ${turn.fromStart ? "" : "at least "}${elapsed(turn.startedAt, now)}`
            : runningScopes.length > 0
              ? `In a turn at ${runningScopes.map(scopeName).join(" and ")}`
              : queued !== undefined
                ? `Queued for a turn at ${scopeName(queued.scope)}`
                : member.lastTurnAt === undefined
                  ? "No turns yet"
                  : `Last turn ${ago(member.lastTurnAt, now)}`}
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
              : `No turn of ${name}'s since the board server started. The live picture is kept in the server's memory.`}
          </PaneNote>
        ) : (
          <>
            {turns.length > 1 ? (
              <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Turns by scope">
                {turns.map((candidate) => (
                  <button
                    key={candidate.scope}
                    type="button"
                    aria-pressed={candidate === turn}
                    onClick={() => setPicked(candidate.scope)}
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
                  </button>
                ))}
              </div>
            ) : null}
            <p className="text-caps">
              {turnRunning ? "This turn" : "Last turn"} · {scopeName(turn.scope)} · started{" "}
              {turn.fromStart ? time(turn.startedAt) : "before the earliest step shown"}
            </p>
            {turn.fromStart ? null : (
              <p className="mt-1 text-meta">
                Earlier steps of this turn are no longer in the server's live buffer.
              </p>
            )}
            {turn.steps.length === 0 ? (
              <p className="mt-2 text-meta">No steps yet.</p>
            ) : (
              <ol className="mt-2 space-y-0.5">
                {turn.steps.map((step) => (
                  <StepItem key={step.seq} step={step} />
                ))}
              </ol>
            )}
            <TurnFooter turn={turn} running={turnRunning} now={now} />
          </>
        )}
      </div>
    </>
  );
}
