import type { CliKind, TurnHistoryEntry } from "@stellaris/shared";
import { useState } from "react";
import { ago } from "../lib/format.js";
import { useNow, useTurnHistory } from "../lib/session.js";
import { costLabel, endingOf, failed, historyTotals, scopeName, turnLength } from "./citizen.js";
import { PaneNote } from "./Pane.js";

const PAGE = 50;

function TurnRow({
  entry,
  cli,
  now,
}: {
  entry: TurnHistoryEntry;
  cli: CliKind | null;
  now: number;
}) {
  const length = turnLength(entry);
  const bad = failed(entry);
  const text = entry.error ?? entry.summary;
  return (
    <li className="border-b border-line/60 px-4 py-2.5 last:border-b-0">
      <p className="flex items-center gap-2 text-xs">
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${bad ? "bg-red-400" : "bg-emerald-400/70"}`}
        />
        <span className="text-fg-secondary">{scopeName(entry.project)}</span>
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
      </p>
      {text === null || text.trim() === "" ? null : (
        <details className="group mt-1 pl-3.5">
          <summary
            className={`cursor-pointer list-none text-xs leading-relaxed group-open:hidden ${
              entry.error === null ? "text-fg-secondary" : "text-red-300"
            } line-clamp-2`}
          >
            {text}
          </summary>
          <p
            className={`text-xs leading-relaxed whitespace-pre-wrap ${
              entry.error === null ? "text-fg-secondary" : "text-red-300"
            }`}
          >
            {text}
          </p>
        </details>
      )}
    </li>
  );
}

/** Every turn the citizen finished, newest first, with how each ended, what it cost, and its report. */
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
          <TurnRow key={entry.id} entry={entry} cli={cli} now={now} />
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
