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
  readonly working: number;
  readonly queued: number;
  readonly paused: boolean;
  readonly onSignOut: () => void;
}

/** The frame around the sky: the wordmark, what the society is doing, and the way out. */
export function Hud({ society, citizens, working, queued, paused, onSignOut }: HudProps) {
  return (
    <>
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-5">
        <div className="flex items-center gap-2.5">
          <span className="brand-dot" />
          <span className="text-display">Stellaris</span>
          {society === undefined ? null : <span className="text-meta">{society}</span>}
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          {paused ? <Chip tone="warn">paused</Chip> : null}
          <Chip>{citizens === 1 ? "1 citizen" : `${citizens} citizens`}</Chip>
          <Chip tone={working > 0 ? "live" : "plain"}>{working} working</Chip>
          {queued > 0 ? <Chip>{queued} queued</Chip> : null}
          <button
            type="button"
            onClick={onSignOut}
            className="h-7 rounded-md px-2.5 text-xs text-fg-tertiary transition-colors hover:bg-surface-2/60 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
          >
            Sign out
          </button>
        </div>
      </header>
      <p className="pointer-events-none absolute bottom-5 left-5 text-meta">
        Hover a star to meet a citizen.
      </p>
    </>
  );
}
