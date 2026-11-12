import type { BoardLayout } from "../lib/layout.js";

const NAME: Record<BoardLayout, string> = {
  around: "Board around the sky",
  beside: "Board beside the sky",
};

const ACTION: Record<BoardLayout, string> = {
  around: "Put the board around the sky",
  beside: "Put the board beside the sky",
};

/** A window with the board drawn in it and a dot for the sky: between two islands, or to the right of one panel. */
function LayoutMark({ layout }: { layout: BoardLayout }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true">
      <rect x="1" y="2.5" width="14" height="11" rx="2" fill="none" stroke="currentColor" />
      {layout === "around" ? (
        <>
          <rect x="2.5" y="4" width="2.5" height="8" rx="0.75" fill="currentColor" />
          <circle cx="7.75" cy="8" r="1.1" fill="currentColor" />
          <rect x="10.5" y="4" width="3" height="8" rx="0.75" fill="currentColor" />
        </>
      ) : (
        <>
          <rect x="2.5" y="4" width="6.5" height="8" rx="0.75" fill="currentColor" />
          <circle cx="11.75" cy="8" r="1.1" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/**
 * The board header's switch between the two layouts: one button, drawn as the layout a press puts
 * the board in, whose name it shows on hover.
 */
export function LayoutSwitch({
  layout,
  onLayout,
}: {
  layout: BoardLayout;
  onLayout: (layout: BoardLayout) => void;
}) {
  const other: BoardLayout = layout === "around" ? "beside" : "around";
  return (
    <button
      type="button"
      aria-label={ACTION[other]}
      title={NAME[other]}
      onClick={() => onLayout(other)}
      className="grid size-7 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
    >
      <LayoutMark layout={other} />
    </button>
  );
}
