import { SOCIETY_SCOPE } from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CliIcon } from "../components/CliIcon.js";
import { LinkedText, useEntities } from "../components/Entities.js";
import { pairsOf } from "../lib/api.js";
import { conversationOf, elapsed, lastLine, pairKey, useLiveTurns } from "../lib/live.js";
import { useMembers, useNow, useScheduler } from "../lib/session.js";

/** The rows the list has room for; more scroll inside it, so nothing under the section moves. */
const ROWS = 4;

/**
 * A row is a 20 px line and an 11 px line at the inherited 1.5 leading, 2 px apart, with 6 px
 * above and below, so the list fits its rows exactly and scrolls only when there are more. The
 * list's 2 px above and below its rows keep a focused row's ring inside it.
 */
const LIST_HEIGHT = `calc(${ROWS} * (1.25rem + 0.125rem + 11px * 1.5 + 0.75rem) + 0.25rem)`;

/**
 * A list's edges fade where rows lie beyond them, as deep as its scroll padding, so a row the
 * keyboard brings into view stays clear of the fade.
 */
function fade(above: boolean, below: boolean): string | undefined {
  if (!above && !below) {
    return undefined;
  }
  const top = above ? "transparent, black 1rem" : "black";
  const bottom = below ? "black calc(100% - 1rem), transparent" : "black";
  return `linear-gradient(to bottom, ${top}, ${bottom})`;
}

/**
 * Whether a scrolling box has more above or below what it shows, followed as it scrolls and as
 * what it holds grows or shrinks.
 */
function useOverflow(
  box: RefObject<HTMLDivElement | null>,
  content: RefObject<HTMLDivElement | null>,
) {
  const [more, setMore] = useState({ above: false, below: false });
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || content.current === null) {
      throw new Error("the list of turns is not mounted");
    }
    const update = () => {
      const above = element.scrollTop > 0;
      const below = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
      setMore((was) => (was.above === above && was.below === below ? was : { above, below }));
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(content.current);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [box, content]);
  return more;
}

/**
 * The citizens in a turn right now, at the top of the navigator, one row per conversation: where,
 * in which thread, for how long, and the last thing each did. The scheduler says who is running;
 * the live stream says what they do. The section keeps one height however many there are.
 */
export function WorkingNow({
  activeCitizen,
  activeScope,
}: {
  activeCitizen: string | null;
  activeScope: string | null;
}) {
  const scheduler = useScheduler();
  const members = useMembers();
  const live = useLiveTurns();
  const entities = useEntities();
  const now = useNow(5_000);
  const running = pairsOf(scheduler.data?.running ?? []);
  const queued = scheduler.data?.pending.length ?? 0;
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const list = useOverflow(box, content);
  const counts = [
    list.above || list.below ? `${running.length} running` : null,
    queued > 0 ? `${queued} queued` : null,
  ].filter((count) => count !== null);
  const mask = fade(list.above, list.below);

  return (
    <section aria-label="Working now" className="mt-3">
      <h3 className="flex items-center justify-between px-2 pb-1 text-[11px] font-semibold tracking-wider text-fg-muted uppercase">
        <span>Working now</span>
        {counts.length > 0 ? (
          <span className="font-normal tracking-normal normal-case">{counts.join(" · ")}</span>
        ) : null}
      </h3>
      <div
        ref={box}
        className="-mx-1 scroll-py-4 overflow-y-auto px-1 py-0.5"
        style={{
          height: LIST_HEIGHT,
          ...(mask === undefined ? {} : { maskImage: mask }),
        }}
      >
        <div ref={content}>
          {running.length === 0 ? (
            <p className="px-2 py-1 text-xs text-fg-muted">Nobody is in a turn.</p>
          ) : (
            <ul>
              {running.map(({ agent, scope, thread, channel }) => {
                const turn = live.get(pairKey(agent, scope, { thread, channel }));
                const current = turn !== undefined && turn.end === null;
                const cli = members.data?.find((member) => member.name === agent)?.cli ?? null;
                const line = current ? lastLine(turn) : null;
                const conversation = conversationOf({ scope, thread, channel });
                const active =
                  agent === activeCitizen &&
                  (activeScope === null || activeScope === conversation || activeScope === scope);
                const where = scope === SOCIETY_SCOPE ? "society" : scope;
                const about =
                  thread !== undefined
                    ? (entities.get(thread)?.title ?? "a thread")
                    : channel === undefined
                      ? null
                      : `#${channel}`;
                return (
                  <li
                    key={conversation === scope ? `${agent}/${scope}` : `${agent}/${conversation}`}
                  >
                    <Link
                      to="/citizen/$name"
                      params={{ name: agent }}
                      search={{ scope: conversation }}
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
                          {about === null ? where : `${where} · ${about}`}
                        </span>
                        {current ? (
                          <span className="shrink-0 font-mono text-[11px] text-fg-tertiary">
                            {turn.fromStart ? "" : "≥ "}
                            {elapsed(turn.startedAt, now)}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate pl-5.5 text-[11px] text-fg-muted">
                        {line === null ? "Starting…" : <LinkedText text={line} links={false} />}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
