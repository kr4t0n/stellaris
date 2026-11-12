import { signalWakes } from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import { ago } from "../lib/format.js";
import { useNow, useScheduler, useSignals } from "../lib/session.js";
import { holdingNow, SIGNAL_LABEL, signalFacts } from "../lib/signals.js";
import { LinkedText } from "../components/Entities.js";
import { PaneHeader, PaneNote } from "./Pane.js";

/**
 * PROTOTYPE: the operations log as a view of its own at `/logs`, one of the status tabs: the
 * signals the scheduler measured, newest first. It floated from the HUD before.
 */
export function LogsView() {
  const signals = useSignals(true);
  const scheduler = useScheduler();
  const now = useNow(30_000);
  const records = signals.data ?? [];
  const holding = holdingNow(records, scheduler.data?.signals ?? []);
  return (
    <>
      <PaneHeader
        title="Operations log"
        subtitle={records.length === 0 ? undefined : `${records.length} signals, newest first`}
      />
      {records.length === 0 ? (
        <PaneNote>
          {signals.data === undefined ? "Reading the log…" : "Nothing measured yet."}
        </PaneNote>
      ) : (
        <ol className="flex-1 overflow-y-auto">
          {records.toReversed().map(({ id, ts, signal }) => {
            const wakes = signalWakes(signal);
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
    </>
  );
}
