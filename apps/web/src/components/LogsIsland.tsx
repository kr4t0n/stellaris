import { Link } from "@tanstack/react-router";
import { ago } from "../lib/format.js";
import { useNow, useScheduler, useSignals } from "../lib/session.js";
import { holdingNow, SIGNAL_LABEL, signalFacts, wakesReaders } from "../lib/signals.js";
import { LinkedText } from "./Entities.js";
import { Island } from "./Island.js";

/**
 * The operations log: the signals the scheduler measured, newest first. It floats from the HUD
 * rather than living in the board, because it is the server's instrumentation, not conversation.
 */
export function LogsIsland({ onClose }: { onClose: () => void }) {
  const signals = useSignals(true);
  const scheduler = useScheduler();
  const now = useNow(30_000);
  const records = signals.data ?? [];
  const holding = holdingNow(records, scheduler.data?.signals ?? []);
  return (
    <Island
      label="Operations log"
      className="top-[72px] right-4 z-20 max-h-[min(70vh,640px)]"
      style={{ width: 400 }}
    >
      <header className="flex items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-heading">Operations log</h2>
          <p className="mt-0.5 text-meta">
            What the scheduler measured. Only kinds that wake the steward start a turn; it reads the
            rest at its next one.
          </p>
        </div>
        <button
          type="button"
          aria-label="Close the log"
          onClick={onClose}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
        >
          ×
        </button>
      </header>
      {records.length === 0 ? (
        <p className="px-4 py-4 text-meta">
          {signals.data === undefined ? "Reading the log…" : "Nothing measured yet."}
        </p>
      ) : (
        <ol className="flex-1 overflow-y-auto">
          {records.toReversed().map(({ id, ts, signal }) => {
            const wakes = wakesReaders(signal.kind);
            const facts = signalFacts(signal);
            return (
              <li key={id} className="border-b border-line/60 px-4 py-2.5 last:border-b-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-md px-1.5 py-px text-[11px] ${
                      wakes ? "bg-amber-500/15 text-amber-300" : "bg-surface-2 text-fg-tertiary"
                    }`}
                  >
                    {SIGNAL_LABEL[signal.kind]}
                  </span>
                  {holding.has(id) ? (
                    <span className="text-[11px] text-emerald-300">holds now</span>
                  ) : null}
                  <time dateTime={ts} title={ts} className="ml-auto shrink-0 text-meta">
                    {ago(ts, now)}
                  </time>
                </div>
                <p className="mt-1 text-sm text-fg-secondary">
                  <LinkedText text={signal.summary} />
                </p>
                {facts.length === 0 && signal.taskId === undefined ? null : (
                  <p className="mt-0.5 text-meta">
                    {facts.join(" · ")}
                    {signal.taskId === undefined ? null : (
                      <>
                        {facts.length === 0 ? "" : " · "}
                        <Link
                          to="/task/$taskId"
                          params={{ taskId: signal.taskId }}
                          className="text-fg-tertiary underline-offset-2 hover:text-fg-primary hover:underline"
                        >
                          the task
                        </Link>
                      </>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Island>
  );
}
