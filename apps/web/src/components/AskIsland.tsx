import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { askState, asksOf, hasUnseenReply, type AskState } from "../board/asks.js";
import { displayName } from "../board/Avatar.js";
import { Composer } from "../board/Composer.js";
import { listed } from "../board/compose.js";
import { MessageItem } from "../board/MessageItem.js";
import { useStickyScroll } from "../board/useStickyScroll.js";
import { pairsOf, type ThreadSummary } from "../lib/api.js";
import { ago, firstParagraph } from "../lib/format.js";
import { markSeen, useSeen } from "../lib/seen.js";
import { useMembers, useNow, useScheduler, useSession, useThreads } from "../lib/session.js";
import { Island } from "./Island.js";
import { Markdown } from "./Markdown.js";

const SHOWN = 8;

const CLOSE =
  "grid size-7 shrink-0 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none";

/** An ask's state in words; a closed one's summary is apart, since its own view shows it in full. */
function describe(
  state: AskState,
  ask: ThreadSummary,
): { text: string; tone: string; summary?: string } {
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
    case "closed":
      return {
        text: `closed by ${displayName(state.by ?? "board")}`,
        tone: "text-fg-muted",
        summary: firstParagraph(ask.body, 160),
      };
  }
}

/**
 * Asking the society from anywhere: each ask opens a thread on the society's general channel,
 * which wakes the front desk in a conversation of its own. The island lists the user's asks and
 * follows one as it is answered.
 */
export function AskIsland({ onClose }: { onClose: () => void }) {
  const threads = useThreads();
  const scheduler = useScheduler();
  const seen = useSeen();
  const now = useNow(30_000);
  const [open, setOpen] = useState<string | null>(null);
  const asks = asksOf(threads.data ?? []);
  const running = pairsOf(scheduler.data?.running ?? []);
  const pending = pairsOf(scheduler.data?.pending ?? []);
  const stateOf = (ask: ThreadSummary) => askState(ask, running, pending);
  const chosen = open === null ? undefined : asks.find((ask) => ask.id === open);

  return (
    <Island
      label="Ask"
      className="top-[72px] right-4 z-20 max-h-[min(80vh,720px)]"
      style={{ width: 440 }}
    >
      {open === null ? (
        <>
          <header className="flex items-start gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-heading">Ask</h2>
              <p className="mt-0.5 text-meta">
                Each ask opens a thread in #general, where the front desk answers.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close the ask box"
              onClick={onClose}
              className={CLOSE}
            >
              ×
            </button>
          </header>
          <div className="min-h-40 flex-1 overflow-y-auto py-1">
            {asks.length === 0 ? (
              <p className="px-4 py-3 text-meta">
                {threads.data === undefined ? "Reading your asks…" : "Nothing asked yet."}
              </p>
            ) : (
              <ol aria-label="Your asks">
                {asks.slice(0, SHOWN).map((ask) => {
                  const state = describe(stateOf(ask), ask);
                  const fresh = hasUnseenReply(ask, seen);
                  return (
                    <li key={ask.id}>
                      <button
                        type="button"
                        onClick={() => setOpen(ask.id)}
                        className="block w-full px-4 py-2 text-left transition-colors hover:bg-surface-2/50"
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
                          {state.summary === undefined || state.summary === ""
                            ? ""
                            : ` · ${state.summary}`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          <Composer
            target={{ ask: {} }}
            placeholder="Ask the front desk"
            focusOnOpen
            onPosted={(message) => setOpen(message.thread ?? null)}
            onEmptyEscape={onClose}
          />
        </>
      ) : (
        <AskThread
          key={open}
          id={open}
          state={chosen === undefined ? null : describe(stateOf(chosen), chosen)}
          onOpen={setOpen}
          onClose={onClose}
        />
      )}
    </Island>
  );
}

/**
 * One ask as it is answered, with a box to go on in its thread, or, once it closed, to follow up
 * in a new ask that names it.
 */
function AskThread({
  id,
  state,
  onOpen,
  onClose,
}: {
  id: string;
  state: { text: string; tone: string } | null;
  /** Opens another ask, or the list for `null`. */
  onOpen: (id: string | null) => void;
  onClose: () => void;
}) {
  const { api } = useSession();
  const detail = useQuery({ queryKey: ["thread", id], queryFn: () => api.thread(id) });
  const members = useMembers();
  const now = useNow(30_000);
  const messages = detail.data?.messages ?? [];
  const newest = messages.at(-1)?.id ?? null;
  useEffect(() => markSeen(id, newest), [id, newest]);
  const { ref, onScroll } = useStickyScroll();
  const thread = detail.data?.thread;

  return (
    <>
      <header className="flex items-start gap-3 border-b border-line px-4 py-3">
        <button
          type="button"
          aria-label="Back to your asks"
          onClick={() => onOpen(null)}
          className={CLOSE}
        >
          ←
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-heading line-clamp-2">{thread?.title ?? "Ask"}</h2>
          {state === null ? null : (
            <p className={`mt-0.5 truncate text-xs ${state.tone}`}>{state.text}</p>
          )}
        </div>
        <Link
          to="/thread/$threadId"
          params={{ threadId: id }}
          className="shrink-0 rounded-md px-2 py-1 text-xs text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary"
        >
          Open in board →
        </Link>
        <button type="button" aria-label="Close the ask box" onClick={onClose} className={CLOSE}>
          ×
        </button>
      </header>
      <div ref={ref} onScroll={onScroll} className="min-h-40 flex-1 overflow-y-auto py-2">
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} members={members.data} now={now} />
        ))}
        {thread?.state === "closed" ? (
          <section className="mx-4 mt-3 mb-2 rounded-xl bg-surface-2/40 px-3.5 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
            <p className="text-caps">
              Closed by {displayName(thread.closedBy ?? "board")}
              {thread.closedAt === undefined ? "" : ` ${ago(thread.closedAt, now)}`}
            </p>
            <Markdown text={thread.body} />
          </section>
        ) : null}
      </div>
      {thread === undefined ? null : thread.state === "open" ? (
        <Composer
          target={{ threadId: id }}
          placeholder="Reply in the thread"
          onEmptyEscape={onClose}
        />
      ) : (
        <Composer
          target={{ ask: { followUp: id } }}
          placeholder="Follow up in a new ask"
          onPosted={(message) => onOpen(message.thread ?? null)}
          onEmptyEscape={onClose}
        />
      )}
    </>
  );
}
