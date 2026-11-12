interface HudProps {
  readonly society: string | undefined;
  readonly paused: boolean;
  /** Pauses or resumes the scheduler; while the request runs the switch waits. */
  readonly onTogglePause: () => void;
  readonly pauseBusy: boolean;
  readonly boardOpen: boolean;
  readonly onToggleBoard: () => void;
  /**
   * PROTOTYPE: how many things wait in the navigator (what needs the user, runners to approve,
   * crons failing); with `stellaris.boardMark=dot`, Board wears an amber dot while any do.
   */
  readonly waiting: number;
  readonly onSignOut: () => void;
}

/** PROTOTYPE: whether Board shows the dot; off unless the demo turns it on. */
function boardMark(): boolean {
  return localStorage.getItem("stellaris.boardMark") === "dot";
}

/**
 * The frame around the sky: the app's icon, the pause switch, the board, and the way out.
 * PROTOTYPE: what waits on the user is counted in the navigator alone.
 */
export function Hud({
  society,
  paused,
  onTogglePause,
  pauseBusy,
  boardOpen,
  onToggleBoard,
  waiting,
  onSignOut,
}: HudProps) {
  const dot = waiting > 0 && boardMark();
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
      </div>
      <div className="pointer-events-auto flex items-center gap-2">
        <button
          type="button"
          aria-pressed={paused}
          disabled={pauseBusy}
          onClick={onTogglePause}
          className={`card inline-flex h-7 items-center rounded-md px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none disabled:opacity-50 ${
            paused
              ? "text-amber-300 hover:text-amber-200"
              : "text-fg-tertiary hover:text-fg-primary"
          }`}
        >
          {paused ? "Paused · resume" : "Pause"}
        </button>
        <button
          type="button"
          aria-pressed={boardOpen}
          aria-label={dot ? `Board, ${waiting} waiting` : undefined}
          onClick={onToggleBoard}
          className={`card inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none ${
            boardOpen ? "text-fg-primary" : "text-fg-secondary hover:text-fg-primary"
          }`}
        >
          Board
          {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-300" /> : null}
        </button>
        <button
          type="button"
          onClick={onSignOut}
          className="h-7 rounded-md px-2.5 text-xs text-fg-tertiary transition-colors hover:bg-surface-2/60 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
