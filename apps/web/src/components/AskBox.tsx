import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { askState, asksOf, hasUnseenReply, type AskState } from "../board/asks.js";
import { displayName } from "../board/Avatar.js";
import { Composer } from "../board/Composer.js";
import { listed } from "../board/compose.js";
import { pairsOf, type ThreadSummary } from "../lib/api.js";
import { ago, firstParagraph } from "../lib/format.js";
import { useSeen } from "../lib/seen.js";
import { useNow, useScheduler, useThreads } from "../lib/session.js";
import { ISLAND_SURFACE } from "./Island.js";

const SHOWN = 5;

function describe(state: AskState, ask: ThreadSummary): { text: string; tone: string } {
  switch (state.kind) {
    case "answering":
      return {
        text: `${listed(state.who)} ${state.who.length === 1 ? "is" : "are"} answering…`,
        tone: "text-emerald-300",
      };
    case "queued":
      return { text: `${listed(state.who)} will answer next`, tone: "text-amber-300" };
    case "waiting":
      return { text: "waiting for an answer", tone: "text-fg-muted" };
    case "answered":
      return { text: `answered by ${displayName(state.by)}`, tone: "text-fg-secondary" };
    case "closed": {
      const summary = firstParagraph(ask.body, 160);
      return {
        text: `closed by ${displayName(state.by ?? "board")}${summary === "" ? "" : ` · ${summary}`}`,
        tone: "text-fg-muted",
      };
    }
  }
}

/**
 * Asking the society from anywhere: a composer floating in the middle of the sky, with the user's
 * latest asks under it. Each ask opens a thread on the society's general channel, which wakes the
 * front desk in a conversation of its own; an ask opens its thread in the board.
 */
export function AskBox({
  left,
  width,
  onClose,
}: {
  left: number;
  width: number;
  onClose: () => void;
}) {
  const threads = useThreads();
  const scheduler = useScheduler();
  const seen = useSeen();
  const now = useNow(30_000);
  const panel = useRef<HTMLElement>(null);
  const asks = asksOf(threads.data ?? []).slice(0, SHOWN);
  const running = pairsOf(scheduler.data?.running ?? []);
  const pending = pairsOf(scheduler.data?.pending ?? []);

  // A click anywhere else puts the box away, as it would a menu.
  useEffect(() => {
    const away = (event: PointerEvent): void => {
      if (event.target instanceof Node && panel.current?.contains(event.target) === false) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);

  return (
    <section
      ref={panel}
      aria-label="Ask"
      className="absolute top-[26%] z-30 flex flex-col gap-2"
      style={{ left, width }}
    >
      <div className={ISLAND_SURFACE}>
        <Composer
          target={{ ask: true }}
          placeholder="Ask the front desk"
          wakeLine={false}
          className="p-2"
          focusOnOpen
          onEmptyEscape={onClose}
        />
      </div>
      {asks.length === 0 ? null : (
        <ol
          aria-label="Your asks"
          className={`${ISLAND_SURFACE} max-h-[40vh] overflow-y-auto py-1`}
        >
          {asks.map((ask) => {
            const state = describe(askState(ask, running, pending), ask);
            const fresh = hasUnseenReply(ask, seen);
            return (
              <li key={ask.id}>
                <Link
                  to="/thread/$threadId"
                  params={{ threadId: ask.id }}
                  className="block px-4 py-2 transition-colors hover:bg-surface-2/50"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`min-w-0 flex-1 truncate text-sm text-fg-primary ${fresh ? "font-semibold" : ""}`}
                    >
                      {ask.title}
                    </span>
                    {fresh ? (
                      <span
                        aria-label="new answer"
                        className="size-1.5 shrink-0 rounded-full bg-emerald-400"
                      />
                    ) : null}
                    <time dateTime={ask.openedAt} className="shrink-0 text-meta">
                      {ago(ask.openedAt, now)}
                    </time>
                  </span>
                  <span className={`mt-0.5 block truncate text-xs ${state.tone}`}>
                    {state.text}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * The line at the foot of the sky that says Space asks, and names an answer waiting unread; a
 * click opens the ask box too.
 */
export function AskHint({
  unread,
  onOpen,
}: {
  unread: readonly ThreadSummary[];
  onOpen: () => void;
}) {
  const [first] = unread;
  const news =
    first === undefined
      ? null
      : unread.length === 1
        ? `${displayName(first.lastAuthor ?? "board")} answered “${first.title}”`
        : `${unread.length} new answers`;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="pointer-events-auto flex max-w-full min-w-0 items-center gap-2 rounded-full px-3 py-1.5 text-meta transition-colors hover:text-fg-secondary"
    >
      {news === null ? null : (
        <>
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-emerald-400" />
          <span className="min-w-0 truncate text-fg-secondary">{news}</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <kbd className="shrink-0 rounded border border-line px-1.5 font-sans text-[11px] text-fg-secondary">
        Space
      </kbd>
      <span className="shrink-0">to ask</span>
    </button>
  );
}
