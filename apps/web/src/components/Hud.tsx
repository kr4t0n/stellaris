import type { ReactNode } from "react";

type Tone = "plain" | "live" | "warn";

const TONES: Record<Tone, string> = {
  plain: "text-fg-tertiary",
  live: "text-emerald-300",
  warn: "text-amber-300",
};

function Chip({ tone = "plain", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`card inline-flex h-7 items-center rounded-md px-2.5 text-xs ${TONES[tone]}`}>
      {children}
    </span>
  );
}

interface HudProps {
  readonly society: string | undefined;
  readonly citizens: number;
  /** Whether the citizens view is open; the count opens and closes it. */
  readonly citizensOpen: boolean;
  readonly onToggleCitizens: () => void;
  /** Citizens in a turn. */
  readonly working: number;
  /** Turns running: more than `working` when a citizen is in turns in two projects. */
  readonly turns: number;
  readonly queued: number;
  /** How many things wait on the user; the chip opens them. */
  readonly attention: number;
  readonly onOpenAttention: () => void;
  readonly paused: boolean;
  /** Pauses or resumes the scheduler; while the request runs the switch waits. */
  readonly onTogglePause: () => void;
  readonly pauseBusy: boolean;
  readonly boardOpen: boolean;
  readonly onToggleBoard: () => void;
  /** Whether the operations log floats open; it is the server's, not the board's. */
  readonly logsOpen: boolean;
  readonly onToggleLogs: () => void;
  readonly onSignOut: () => void;
}

/** The frame around the sky: the wordmark, what the society is doing, and the way out. */
export function Hud({
  society,
  citizens,
  citizensOpen,
  onToggleCitizens,
  working,
  turns,
  queued,
  attention,
  onOpenAttention,
  paused,
  onTogglePause,
  pauseBusy,
  boardOpen,
  onToggleBoard,
  logsOpen,
  onToggleLogs,
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
        <Chip tone={working > 0 ? "live" : "plain"}>
          {working} working{turns > working ? ` · ${turns} turns` : ""}
        </Chip>
        {queued > 0 ? <Chip>{queued} queued</Chip> : null}
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
          aria-expanded={logsOpen}
          onClick={onToggleLogs}
          className={`card inline-flex h-7 items-center rounded-md px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none ${
            logsOpen ? "text-fg-primary" : "text-fg-secondary hover:text-fg-primary"
          }`}
        >
          Logs
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
