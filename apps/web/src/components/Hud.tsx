interface HudProps {
  readonly society: string | undefined;
  readonly paused: boolean;
  /** Pauses or resumes the scheduler; while the request runs the switch waits. */
  readonly onTogglePause: () => void;
  readonly pauseBusy: boolean;
  readonly boardOpen: boolean;
  /** Opens the board where it was last; a click on the sky does the same. */
  readonly onOpenBoard: () => void;
  /**
   * PROTOTYPE: how many things wait in the left list (what needs the user, runners to approve,
   * crons failing); with `stellaris.waitingMark=name`, an amber dot follows the society's name
   * while any do.
   */
  readonly waiting: number;
  readonly onSignOut: () => void;
}

/** PROTOTYPE: whether the society's name wears the waiting dot; off unless the demo turns it on. */
function waitingMark(): boolean {
  return localStorage.getItem("stellaris.waitingMark") === "name";
}

/** The camera's controls' look, so the two cards on the sky's right edge match. */
const ICON =
  "grid size-7 place-items-center rounded-md transition-colors hover:bg-surface-2/70 focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none disabled:opacity-50";

/** Two bars, or while paused the triangle that resumes. */
function PauseMark({ paused }: { paused: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true">
      {paused ? (
        <path d="M5.5 3.6 12.4 8l-6.9 4.4z" fill="currentColor" strokeLinejoin="round" />
      ) : (
        <>
          <rect x="4" y="3.5" width="2.75" height="9" rx="0.9" fill="currentColor" />
          <rect x="9.25" y="3.5" width="2.75" height="9" rx="0.9" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/** A door left open with an arrow leaving through it. */
function SignOutMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6.5 2.75H4a1.25 1.25 0 0 0-1.25 1.25v8A1.25 1.25 0 0 0 4 13.25h2.5" />
      <path d="M10.25 5 13.25 8l-3 3M13 8H6.75" />
    </svg>
  );
}

/**
 * The frame around the sky: the app's icon, the society's name, and two icons, the pause switch
 * and the way out. PROTOTYPE: no Board button; a click on the sky opens the board, and a button
 * only the keyboard reaches does too.
 */
export function Hud({
  society,
  paused,
  onTogglePause,
  pauseBusy,
  boardOpen,
  onOpenBoard,
  waiting,
  onSignOut,
}: HudProps) {
  const mark = waiting > 0 && waitingMark();
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-5">
      <div className="flex items-center gap-2.5">
        {/* The favicon itself, so the corner keeps in step with the app's icon as the favicon does.
            It never shrinks: with preflight's `max-width: 100%` the corner would narrow past it in a
            narrow window, and the controls would slide over the name. */}
        <img
          src="/favicon.svg"
          alt="Stellaris"
          width={28}
          height={28}
          className="size-7 shrink-0"
        />
        {society === undefined ? null : <span className="text-meta">{society}</span>}
        {mark ? (
          <span title={`${waiting} waiting in the board`} className="flex items-center">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-300" />
            <span className="sr-only">{waiting} waiting in the board</span>
          </span>
        ) : null}
      </div>
      <div className="pointer-events-auto flex items-center gap-2">
        {boardOpen ? null : (
          <button
            type="button"
            onClick={onOpenBoard}
            className="card sr-only items-center rounded-md text-xs text-fg-primary focus-visible:not-sr-only focus-visible:inline-flex focus-visible:h-7 focus-visible:px-2.5 focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
          >
            Open the board
          </button>
        )}
        {/* One card of two, as the camera's three sit in one at the bottom: its 4 px padding hangs
            outside the row's 28 px line, so its icons line up with the app's and its edge with the
            camera card's. */}
        <div className="card -my-1 -mr-1 flex gap-0.5 p-1">
          <button
            type="button"
            aria-label={paused ? "Resume" : "Pause"}
            title={paused ? "Paused: resume" : "Pause"}
            disabled={pauseBusy}
            onClick={onTogglePause}
            className={`${ICON} ${
              paused
                ? "text-amber-300 hover:text-amber-200"
                : "text-fg-tertiary hover:text-fg-primary"
            }`}
          >
            <PauseMark paused={paused} />
          </button>
          <button
            type="button"
            aria-label="Sign out"
            title="Sign out"
            onClick={onSignOut}
            className={`${ICON} text-fg-tertiary hover:text-fg-primary`}
          >
            <SignOutMark />
          </button>
        </div>
      </div>
    </header>
  );
}
