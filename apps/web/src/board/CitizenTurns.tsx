import type { CliKind, TurnHistoryEntry } from "@stellaris/shared";
import { useState } from "react";
import { LinkedText, useEntities } from "../components/Entities.js";
import { ago } from "../lib/format.js";
import { useNow, useTurnHistory } from "../lib/session.js";
import { costLabel, endingOf, historyTotals, scopeName, turnLength } from "./citizen.js";
import { PaneNote } from "./Pane.js";
import { time, TranscriptSteps } from "./Transcript.js";
import { useStoredTurn } from "./useStoredTurn.js";

const PAGE = 50;

function TurnRow({
  name,
  entry,
  cli,
  now,
}: {
  name: string;
  entry: TurnHistoryEntry;
  cli: CliKind | null;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const entities = useEntities();
  const length = turnLength(entry);
  const about =
    entry.thread === undefined ? null : (entities.get(entry.thread)?.title ?? "a thread");
  const text = entry.error ?? entry.summary ?? "";
  const tone = entry.error === null ? "text-fg-secondary" : "text-red-300";
  return (
    <li className="border-b border-line/60 last:border-b-0">
      <details className="group" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="block cursor-pointer list-none px-4 py-2.5 transition-colors hover:bg-surface-2/30 group-open:bg-surface-2/20">
          <span className="flex items-center gap-2 text-xs">
            <span className="min-w-0 truncate text-fg-secondary">
              {scopeName(entry.project)}
              {about === null ? "" : ` · ${about}`}
            </span>
            <span className="text-fg-muted">{entry.trigger}</span>
            <span className="min-w-0 flex-1 truncate text-fg-muted">
              {endingOf(entry)} {ago(entry.ts, now)}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-fg-tertiary">
              {[
                length,
                entry.toolCalls === undefined ? null : `${entry.toolCalls} tools`,
                costLabel(entry, cli),
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </span>
            <span
              aria-hidden="true"
              className="shrink-0 text-[10px] text-fg-muted transition-transform group-open:rotate-90"
            >
              ▸
            </span>
          </span>
          {text.trim() === "" ? null : (
            <span
              className={`mt-1 line-clamp-2 block text-xs leading-relaxed group-open:hidden ${tone}`}
            >
              <LinkedText text={text} links={false} />
            </span>
          )}
        </summary>
        {open ? <TurnBody name={name} entry={entry} text={text} tone={tone} /> : null}
      </details>
    </li>
  );
}

/** An opened turn: its whole report, then every step it took when its transcript was kept. */
function TurnBody({
  name,
  entry,
  text,
  tone,
}: {
  name: string;
  entry: TurnHistoryEntry;
  text: string;
  tone: string;
}) {
  const stored = useStoredTurn(name, entry);
  return (
    <div className="px-4 pt-1 pb-3">
      {text.trim() === "" ? null : (
        <p className={`text-xs leading-relaxed whitespace-pre-wrap ${tone}`}>
          <LinkedText text={text} />
        </p>
      )}
      <div className="mt-2">
        {entry.turnId === undefined ? (
          <p className="text-meta">This turn ran before turns kept their steps.</p>
        ) : stored.loading ? (
          <p className="text-meta">Reading the steps…</p>
        ) : stored.turn === undefined ? (
          <p className="text-meta">No steps were kept for this turn.</p>
        ) : (
          <>
            {entry.startedAt === undefined ? null : (
              <p className="text-caps">Started {time(entry.startedAt)}</p>
            )}
            <TranscriptSteps steps={stored.turn.steps} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Every turn the citizen finished, newest first, with how each ended, what it cost, and its report;
 * a turn opens to every step it took.
 */
export function CitizenTurns({ name, cli }: { name: string; cli: CliKind | null }) {
  const [limit, setLimit] = useState(PAGE);
  const history = useTurnHistory(name, limit);
  const now = useNow(30_000);
  if (history.data === undefined) {
    return <PaneNote>Reading the turns…</PaneNote>;
  }
  const entries = history.data.toReversed();
  if (entries.length === 0) {
    return <PaneNote>{name} has not finished a turn yet.</PaneNote>;
  }
  const totals = historyTotals(entries);
  const metered = cli === "codex" ? "unmetered" : `$${totals.costUsd.toFixed(2)}`;
  return (
    <div className="flex-1 overflow-y-auto">
      <p className="px-4 pt-3 pb-1 text-meta">
        {totals.turns === 1 ? "1 turn" : `${totals.turns} turns`}
        {totals.failed === 0 ? "" : `, ${totals.failed} not completed`} · {metered}
      </p>
      <ol>
        {entries.map((entry) => (
          <TurnRow key={entry.id} name={name} entry={entry} cli={cli} now={now} />
        ))}
      </ol>
      {history.data.length === limit ? (
        <button
          type="button"
          onClick={() => setLimit(limit + PAGE)}
          className="px-4 py-3 text-xs text-fg-tertiary hover:text-fg-primary"
        >
          Show {PAGE} earlier turns
        </button>
      ) : null}
    </div>
  );
}
