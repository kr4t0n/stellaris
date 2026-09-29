import { SOCIETY_SCOPE } from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import { CliIcon } from "../components/CliIcon.js";
import { pairsOf } from "../lib/api.js";
import { elapsed, lastLine, pairKey, useLiveTurns } from "../lib/live.js";
import { useMembers, useNow, useScheduler } from "../lib/session.js";

/**
 * The citizens in a turn right now, at the top of the navigator: where, for how long, and the
 * last thing each did. The scheduler says who is running; the live stream says what they do.
 */
export function WorkingNow({ activeCitizen }: { activeCitizen: string | null }) {
  const scheduler = useScheduler();
  const members = useMembers();
  const live = useLiveTurns();
  const now = useNow(5_000);
  const running = pairsOf(scheduler.data?.running ?? []);
  const queued = scheduler.data?.pending.length ?? 0;

  return (
    <section aria-label="Working now" className="mt-3">
      <h3 className="flex items-center justify-between px-2 pb-1 text-[11px] font-semibold tracking-wider text-fg-muted uppercase">
        <span>Working now</span>
        {queued > 0 ? (
          <span className="font-normal tracking-normal normal-case">{queued} queued</span>
        ) : null}
      </h3>
      {running.length === 0 ? (
        <p className="px-2 py-1 text-xs text-fg-muted">Nobody is in a turn.</p>
      ) : (
        <ul>
          {running.map(({ agent, scope }) => {
            const turn = live.get(pairKey(agent, scope));
            const current = turn !== undefined && turn.end === null;
            const cli = members.data?.find((member) => member.name === agent)?.cli ?? null;
            const line = current ? lastLine(turn) : null;
            const active = agent === activeCitizen;
            return (
              <li key={`${agent}/${scope}`}>
                <Link
                  to="/citizen/$name"
                  params={{ name: agent }}
                  className={`block rounded-lg px-2 py-1.5 transition-colors ${
                    active
                      ? "bg-surface-2/80 text-fg-primary"
                      : "text-fg-secondary hover:bg-surface-2/50 hover:text-fg-primary"
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-sm">
                    <span className="relative grid size-4 shrink-0 place-items-center">
                      {cli === null ? null : <CliIcon cli={cli} size={13} />}
                      <span className="absolute -right-0.5 -bottom-0.5 size-1.5 animate-pulse rounded-full bg-emerald-400" />
                    </span>
                    <span className="min-w-0 truncate">{agent}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                      {scope === SOCIETY_SCOPE ? "society" : scope}
                    </span>
                    {current ? (
                      <span className="shrink-0 font-mono text-[11px] text-fg-tertiary">
                        {turn.fromStart ? "" : "≥ "}
                        {elapsed(turn.startedAt, now)}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate pl-5.5 text-[11px] text-fg-muted">
                    {line ?? "Starting…"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
