import type { SignIn } from "../lib/api.js";

interface HudProps {
  readonly society: string | undefined;
  readonly citizens: number;
  /** Whether the citizens view is open; the count opens and closes it. */
  readonly citizensOpen: boolean;
  readonly onToggleCitizens: () => void;
  /** Whether the runners view is open; the button opens and closes it. */
  readonly runnersOpen: boolean;
  readonly onToggleRunners: () => void;
  /** Runners waiting for the user to approve their enrollment, counted on the button. */
  readonly enrolling: number;
  /** How many things wait on the user; the chip opens them. */
  readonly attention: number;
  readonly onOpenAttention: () => void;
  readonly paused: boolean;
  /** Pauses or resumes the scheduler; while the request runs the switch waits. */
  readonly onTogglePause: () => void;
  readonly pauseBusy: boolean;
  readonly boardOpen: boolean;
  readonly onToggleBoard: () => void;
  /** Whether the metrics view is open; the button opens and closes it. */
  readonly metricsOpen: boolean;
  readonly onToggleMetrics: () => void;
  /** Whether the operations log floats open; it is the server's, not the board's. */
  readonly logsOpen: boolean;
  readonly onToggleLogs: () => void;
  /** The GitHub account signed in, shown beside the way out; none for the user's own token. */
  readonly signIn: SignIn | undefined;
  readonly onSignOut: () => void;
}

/** A GitHub avatar's address at `px` pixels, so the browser fetches the size it shows. */
function avatarAt(url: string, px: number): string {
  const sized = new URL(url);
  sized.searchParams.set(sized.hostname === "github.com" ? "size" : "s", String(px));
  return sized.href;
}

/** The frame around the sky: the wordmark, what the society is doing, and the way out. */
export function Hud({
  society,
  citizens,
  citizensOpen,
  onToggleCitizens,
  runnersOpen,
  onToggleRunners,
  enrolling,
  attention,
  onOpenAttention,
  paused,
  onTogglePause,
  pauseBusy,
  boardOpen,
  onToggleBoard,
  metricsOpen,
  onToggleMetrics,
  logsOpen,
  onToggleLogs,
  signIn,
  onSignOut,
}: HudProps) {
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-5">
      <div className="flex items-center gap-2.5">
        <span className="text-display">Stellaris</span>
        {society === undefined ? null : <span className="text-meta">{society}</span>}
      </div>
      <div className="pointer-events-auto flex items-center gap-2">
        {attention === 0 ? null : (
          <button
            type="button"
            onClick={onOpenAttention}
            className="card inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-amber-300 transition-colors hover:text-amber-200 focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
          >
            <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-300" />
            {attention} {attention === 1 ? "needs" : "need"} you
          </button>
        )}
        <button
          type="button"
          aria-pressed={paused}
          disabled={pauseBusy}
          onClick={onTogglePause}
          title={
            paused
              ? "Nobody takes a turn until you resume; wakes wait in the queue."
              : "Stop dispatching turns. Running turns finish; new wakes wait."
          }
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
          aria-pressed={citizensOpen}
          onClick={onToggleCitizens}
          className={`card inline-flex h-7 items-center rounded-md px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none ${
            citizensOpen ? "text-fg-primary" : "text-fg-tertiary hover:text-fg-primary"
          }`}
        >
          {citizens === 1 ? "1 citizen" : `${citizens} citizens`}
        </button>
        <button
          type="button"
          aria-pressed={runnersOpen}
          aria-label={enrolling === 0 ? "Runners" : `Runners, ${enrolling} waiting for approval`}
          onClick={onToggleRunners}
          className={`card inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none ${
            runnersOpen ? "text-fg-primary" : "text-fg-secondary hover:text-fg-primary"
          }`}
        >
          Runners
          {enrolling === 0 ? null : (
            <span className="rounded bg-amber-500/15 px-1 text-[11px] text-amber-300">
              {enrolling}
            </span>
          )}
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
          aria-pressed={metricsOpen}
          onClick={onToggleMetrics}
          className={`card inline-flex h-7 items-center rounded-md px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none ${
            metricsOpen ? "text-fg-primary" : "text-fg-secondary hover:text-fg-primary"
          }`}
        >
          Metrics
        </button>
        <button
          type="button"
          aria-expanded={logsOpen}
          onClick={onToggleLogs}
          className={`card inline-flex h-7 items-center rounded-md px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none ${
            logsOpen ? "text-fg-primary" : "text-fg-secondary hover:text-fg-primary"
          }`}
        >
          Logs
        </button>
        {signIn === undefined ? null : (
          <span
            title={`Signed in with GitHub as ${signIn.login}`}
            className="ml-1 inline-flex h-7 items-center gap-1.5 text-xs text-fg-secondary"
          >
            <img
              src={avatarAt(signIn.avatarUrl, 40)}
              alt=""
              width={20}
              height={20}
              referrerPolicy="no-referrer"
              className="size-5 rounded-full bg-surface-2 ring-1 ring-line"
            />
            <span className="max-md:sr-only">{signIn.login}</span>
          </span>
        )}
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
