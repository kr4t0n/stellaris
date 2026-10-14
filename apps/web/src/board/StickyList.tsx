import { useRef, type ReactNode } from "react";
import { useStickyScroll } from "./useStickyScroll.js";

/**
 * A pane's scrolling list that keeps to its newest item (`useStickyScroll`), with a button over
 * its bottom edge, while the reader is away from the end, that takes them back. `ids`, the
 * messages' ids in order, let the button count what arrived since.
 */
export function StickyList({
  stick,
  follow,
  ids,
  className,
  children,
}: {
  stick?: boolean | undefined;
  follow?: boolean | undefined;
  ids?: readonly string[] | undefined;
  /** The list's own spacing; it fills the rest of the pane and scrolls. */
  className: string;
  children: ReactNode;
}) {
  const { ref, onScroll, away, unseen, jump } = useStickyScroll({ stick, follow, ids });
  const button = useRef<HTMLButtonElement>(null);
  // The button goes once the list is at the end, so focus on it moves to what it went to.
  const toLatest = (): void => jump({ focus: document.activeElement === button.current });
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={ref} onScroll={onScroll} className={`flex-1 overflow-y-auto ${className}`}>
        {children}
      </div>
      {away ? (
        <button
          ref={button}
          type="button"
          onClick={toLatest}
          aria-label={unseen > 0 ? `Jump to latest, ${unseen} new` : "Jump to latest"}
          title="Jump to latest"
          className="absolute bottom-3 left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full bg-surface-2 text-fg-secondary shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_8px_20px_-6px_rgba(0,0,0,0.9)] transition-colors hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
          </svg>
          {unseen > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -top-1.5 -right-1.5 min-w-4 rounded-full bg-fg-primary px-1 text-center text-[10px] leading-4 font-medium text-surface-0 tabular-nums"
            >
              {unseen > 99 ? "99+" : unseen}
            </span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
