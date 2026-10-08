import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/** One entry of a picker: its value, its name, an id shown beside the name, and a line under it. */
export interface Choice {
  readonly value: string;
  readonly name: string;
  /** A second name shown beside the first, such as the id a CLI takes, or null for none. */
  readonly id: string | null;
  readonly description: string;
}

function spoken(choice: Choice | undefined): string {
  return choice === undefined ? "" : `${choice.name}${choice.id === null ? "" : ` · ${choice.id}`}`;
}

/** A dropdown in the islands' look: the choice in the header's type, the list as a floating card. */
export function Picker({
  label,
  choices,
  value,
  onChange,
  listClassName = "inset-x-0",
}: {
  /** What is being chosen, for the trigger's accessible name. */
  label: string;
  choices: readonly Choice[];
  value: string;
  onChange: (value: string) => void;
  /** Where the list sits and how wide it is; as wide as the trigger unless a narrow one needs more. */
  listClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = choices.findIndex((choice) => choice.value === value);

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
    const next = (at + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
    items.current[next]?.focus();
  };

  const current = choices[selected];
  return (
    <div ref={root} className="relative min-w-0 flex-1">
      <button
        ref={trigger}
        type="button"
        aria-label={`${label}: ${spoken(current)}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={open ? move : undefined}
        className="flex h-7 w-full items-center gap-1.5 rounded-md bg-surface-2/60 px-2.5 text-xs text-fg-secondary transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {current?.name}
          {current?.id === null || current === undefined ? null : (
            <span className="text-fg-tertiary"> · {current.id}</span>
          )}
        </span>
        <span
          aria-hidden="true"
          className={`text-[10px] text-fg-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>
      {open ? (
        <div
          className={`absolute ${listClassName} top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-xl bg-surface-1/95 p-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_16px_32px_-12px_rgba(0,0,0,0.8)] backdrop-blur-xl`}
        >
          {choices.map((choice, index) => {
            const chosen = choice.value === value;
            return (
              <button
                key={choice.value}
                ref={(element) => {
                  items.current[index] = element;
                }}
                type="button"
                aria-current={chosen ? "true" : undefined}
                onKeyDown={move}
                onClick={() => {
                  onChange(choice.value);
                  setOpen(false);
                  trigger.current?.focus();
                }}
                className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none ${
                  chosen ? "bg-surface-2/80" : "hover:bg-surface-2/50 focus-visible:bg-surface-2/50"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg-secondary">
                    {choice.name}
                    {choice.id === null ? null : (
                      <span className="text-fg-tertiary"> · {choice.id}</span>
                    )}
                  </span>
                  {choice.description === "" ? null : (
                    <span className="block truncate text-[11px] text-fg-muted">
                      {choice.description}
                    </span>
                  )}
                </span>
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
