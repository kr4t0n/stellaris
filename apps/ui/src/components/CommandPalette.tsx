import { useMemo, useState } from "react";
import { inputClass } from "./ui.js";

export interface PaletteEntry {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly run: () => void;
}

/** Reaches any project, citizen, task, or place by name. Opens with Ctrl or Cmd plus K. */
export function CommandPalette({
  open,
  entries,
  onClose,
}: {
  open: boolean;
  entries: readonly PaletteEntry[];
  onClose: () => void;
}) {
  // Mounted fresh on every open, so the query and the cursor start empty without an effect.
  return open ? <PaletteDialog entries={entries} onClose={onClose} /> : null;
}

function PaletteDialog({
  entries,
  onClose,
}: {
  entries: readonly PaletteEntry[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (
      needle.length === 0
        ? entries
        : entries.filter((entry) => `${entry.label} ${entry.hint}`.toLowerCase().includes(needle))
    ).slice(0, 12);
  }, [entries, query]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Go to"
        className="w-[32rem] max-w-[90vw] rounded-lg border border-board-border bg-board-panel p-2 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          // The palette is opened deliberately, so moving focus into it is the expected outcome.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((value) => Math.min(matches.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              matches[index]?.run();
              onClose();
            } else if (event.key === "Escape") {
              onClose();
            }
          }}
          placeholder="Go to a project, citizen, task, or place"
          className={`${inputClass} w-full`}
        />
        <ul className="mt-2 max-h-80 overflow-y-auto text-sm">
          {matches.map((entry, position) => (
            <li key={entry.key}>
              <button
                type="button"
                onClick={() => {
                  entry.run();
                  onClose();
                }}
                className={`flex w-full items-center justify-between rounded px-2 py-1 text-left ${
                  position === index
                    ? "bg-board-bg text-board-text"
                    : "text-board-muted hover:text-board-text"
                }`}
              >
                <span>{entry.label}</span>
                <span className="text-xs">{entry.hint}</span>
              </button>
            </li>
          ))}
          {matches.length === 0 ? (
            <li className="px-2 py-1 text-xs text-board-muted">Nothing matches.</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
