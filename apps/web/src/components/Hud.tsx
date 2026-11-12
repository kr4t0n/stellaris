import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * PROTOTYPE: which corner the demo draws. `plain` (the default) ends the corner with Sign out, as
 * today, and puts Logs in the navigator; `menu` puts Logs and Sign out behind one ⋯ button.
 */
export type CornerForm = "plain" | "menu";
export function readCornerForm(): CornerForm {
  return localStorage.getItem("stellaris.cornerForm") === "menu" ? "menu" : "plain";
}

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
  readonly form: CornerForm;
  /** Whether the operations log floats open; it is the server's, not the board's. */
  readonly logsOpen: boolean;
  readonly onToggleLogs: () => void;
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

const ITEM =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-fg-secondary outline-none hover:bg-surface-2/70 hover:text-fg-primary focus-visible:bg-surface-2/70 focus-visible:text-fg-primary";

/** PROTOTYPE: the ⋯ button and its menu, Logs and Sign out, for the `menu` form. */
function MoreMenu({
  logsOpen,
  onToggleLogs,
  onSignOut,
}: {
  logsOpen: boolean;
  onToggleLogs: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = (): HTMLElement[] => [
    ...(menu.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? []),
  ];
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const away = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) {
      button.current?.focus();
    }
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const all = items();
    const focused = document.activeElement;
    const at = all.findIndex((item) => item === focused);
    const move = (to: number): void => {
      event.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (event.key === "Escape") {
      // The menu closes alone; the playground's Escape would close the log or the board.
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown") {
      move(at + 1);
    } else if (event.key === "ArrowUp") {
      move(at - 1);
    } else if (event.key === "Home") {
      move(0);
    } else if (event.key === "End") {
      move(all.length - 1);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };
  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (
            event.key === "ArrowDown" ||
            ((event.key === "Enter" || event.key === " ") && !open)
          ) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
            requestAnimationFrame(() => items()[0]?.focus());
          }
        }}
        className={`card grid size-7 place-items-center rounded-md text-sm transition-colors focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none ${
          open ? "text-fg-primary" : "text-fg-secondary hover:text-fg-primary"
        }`}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label="More"
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className="card absolute top-9 right-0 z-30 w-44 rounded-lg p-1"
        >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={logsOpen}
            tabIndex={-1}
            onClick={() => {
              onToggleLogs();
              close(false);
            }}
            className={ITEM}
          >
            <span className="flex-1">Logs</span>
            {logsOpen ? <span aria-hidden="true">✓</span> : null}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              close(false);
              onSignOut();
            }}
            className={ITEM}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
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
  form,
  logsOpen,
  onToggleLogs,
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
        {form === "menu" ? (
          <MoreMenu logsOpen={logsOpen} onToggleLogs={onToggleLogs} onSignOut={onSignOut} />
        ) : (
          <button
            type="button"
            onClick={onSignOut}
            className="h-7 rounded-md px-2.5 text-xs text-fg-tertiary transition-colors hover:bg-surface-2/60 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
          >
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
