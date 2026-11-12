interface HudProps {
  readonly society: string | undefined;
  /**
   * How many things wait in the board: what needs the user, runners to approve, and crons
   * failing. An amber dot follows the society's name while any do.
   */
  readonly waiting: number;
  readonly paused: boolean;
  /** Pauses or resumes the scheduler; while the request runs the switch waits. */
  readonly onTogglePause: () => void;
  readonly pauseBusy: boolean;
  readonly boardOpen: boolean;
  /** Opens the board where it was last, as a click on empty sky does. */
  readonly onOpenBoard: () => void;
  readonly onSignOut: () => void;
}

/**
 * Bare on the sky, with a ground only under the pointer. Its focus ring is twice the app's
 * strength: with no card behind it, the app's 30% ring is 2.49:1 on the sky's ground, and 60% is
 * 6.78:1.
 */
const ICON =
  "grid size-7 place-items-center rounded-md transition-colors hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-fg-primary/60 focus-visible:outline-none disabled:opacity-50";

/**
 * A dark halo around an icon's strokes: the sky's black ground hides it, and a bright star the
 * camera puts behind the icon shows it, edging the strokes where they meet the star.
 */
const HALO = "[filter:drop-shadow(0_0_1px_rgb(0_0_0))_drop-shadow(0_0_2.5px_rgb(0_0_0/0.85))]";

/** Two bars, or while paused the triangle that resumes. */
function PauseMark({ paused }: { paused: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" className={HALO}>
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
      className={HALO}
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
 * The frame around the sky: the app's icon, the society's name with a dot while something waits
 * in the board, and two icons, the pause switch and the way out. A click on the sky opens the
 * board; the keyboard has a button of its own for it, shown only while it has focus.
 */
export function Hud({
  society,
  waiting,
  paused,
  onTogglePause,
  pauseBusy,
  boardOpen,
  onOpenBoard,
  onSignOut,
}: HudProps) {
  const said = `${waiting} waiting in the board`;
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
        {waiting === 0 ? null : (
          <span title={said} className="pointer-events-auto flex items-center">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-300" />
            <span className="sr-only">{said}</span>
          </span>
        )}
      </div>
      <div className="pointer-events-auto flex items-center gap-1">
        {boardOpen ? null : (
          <button
            type="button"
            onClick={onOpenBoard}
            className="sr-only items-center rounded-md text-xs text-fg-primary focus-visible:not-sr-only focus-visible:inline-flex focus-visible:h-7 focus-visible:px-2.5 focus-visible:ring-2 focus-visible:ring-fg-primary/60 focus-visible:outline-none"
          >
            Open the board
          </button>
        )}
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
    </header>
  );
}
