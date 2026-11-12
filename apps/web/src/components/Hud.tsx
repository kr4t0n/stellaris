interface HudProps {
  readonly society: string | undefined;
  /** How many things wait on the user; the chip opens them. */
  readonly attention: number;
  readonly onOpenAttention: () => void;
  /** Runners waiting for the user to approve their enrollment; a chip opens them while any wait. */
  readonly enrolling: number;
  readonly onOpenRunners: () => void;
  /** Crons whose turns keep failing; a chip opens the crons while any fail. */
  readonly failingCrons: number;
  readonly onOpenCrons: () => void;
  readonly paused: boolean;
  /** Pauses or resumes the scheduler; while the request runs the switch waits. */
  readonly onTogglePause: () => void;
  readonly pauseBusy: boolean;
  readonly boardOpen: boolean;
  readonly onToggleBoard: () => void;
  readonly onSignOut: () => void;
}

const CHIP =
  "card inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-amber-300 transition-colors hover:text-amber-200 focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none";

/** A count that waits on the user, shown only while it is above zero. */
function Alert({ count, label, onOpen }: { count: number; label: string; onOpen: () => void }) {
  return count === 0 ? null : (
    <button type="button" onClick={onOpen} className={CHIP}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-300" />
      {label}
    </button>
  );
}

/** The frame around the sky: the app's icon, what waits on the user, and the way out. */
export function Hud({
  society,
  attention,
  onOpenAttention,
  enrolling,
  onOpenRunners,
  failingCrons,
  onOpenCrons,
  paused,
  onTogglePause,
  pauseBusy,
  boardOpen,
  onToggleBoard,
  onSignOut,
}: HudProps) {
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
        <Alert
          count={attention}
          label={`${attention} ${attention === 1 ? "needs" : "need"} you`}
          onOpen={onOpenAttention}
        />
        <Alert
          count={enrolling}
          label={`${enrolling} ${enrolling === 1 ? "runner" : "runners"} to approve`}
          onOpen={onOpenRunners}
        />
        <Alert
          count={failingCrons}
          label={`${failingCrons} ${failingCrons === 1 ? "cron" : "crons"} failing`}
          onOpen={onOpenCrons}
        />
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
          onClick={onToggleBoard}
          className={`card inline-flex h-7 items-center rounded-md px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none ${
            boardOpen ? "text-fg-primary" : "text-fg-secondary hover:text-fg-primary"
          }`}
        >
          Board
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
