import type { CliKind } from "@stellaris/shared";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CliIcon } from "../components/CliIcon.js";
import { choiceClass, LIST_CARD } from "../components/Picker.js";

/**
 * A citizen's CLI mark beside its name, which opens the CLIs it may run on, `offered`, the one
 * `shown` checked. `shown` is the CLI the model form is open on while it is, else the citizen's.
 */
export function CliMenu({
  shown,
  offered,
  onChoose,
}: {
  shown: CliKind;
  offered: readonly CliKind[];
  onChoose: (cli: CliKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = offered.indexOf(shown);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    items.current[Math.max(selected, 0)]?.focus();
    const away = (event: PointerEvent): void => {
      if (!(event.target instanceof Node && root.current?.contains(event.target) === true)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open, selected]);

  const move = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "Escape") {
      // The board closes on Escape too; this one only closes the list.
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const at = items.current.findIndex((item) => item === document.activeElement);
    const next = (at + (event.key === "ArrowDown" ? 1 : -1) + offered.length) % offered.length;
    items.current[next]?.focus();
  };

  return (
    <div ref={root} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label={`Switch CLI (${shown})`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={open ? move : undefined}
        className="grid size-9 place-items-center rounded-lg bg-surface-2/70 transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
      >
        <CliIcon cli={shown} size={20} />
      </button>
      {open ? (
        <div className={`absolute top-full left-0 z-20 w-40 ${LIST_CARD}`}>
          {offered.map((cli, index) => {
            const chosen = cli === shown;
            return (
              <button
                key={cli}
                ref={(element) => {
                  items.current[index] = element;
                }}
                type="button"
                aria-current={chosen ? "true" : undefined}
                onKeyDown={move}
                onClick={() => {
                  onChoose(cli);
                  setOpen(false);
                  trigger.current?.focus();
                }}
                className={choiceClass(chosen)}
              >
                <CliIcon cli={cli} />
                <span className="min-w-0 flex-1 truncate text-xs text-fg-secondary">{cli}</span>
                <span aria-hidden="true" className="w-3 shrink-0 pt-px text-[11px] text-fg-primary">
                  {chosen ? "✓" : ""}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
