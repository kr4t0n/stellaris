import { useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

/** How far an arrow key moves the edge. */
const STEP = 32;

/**
 * The width a drag that began at `from` has reached: the content grows as its edge moves away from
 * it, left for an edge on its left, right for one on its right.
 */
function dragged(
  event: PointerEvent<HTMLButtonElement>,
  from: { x: number; width: number },
  edge: "left" | "right",
): number {
  const moved = event.clientX - from.x;
  return from.width + (edge === "left" ? -moved : moved);
}

/**
 * The content's edge toward the sky, which drags to widen or narrow it: its left edge while the
 * board is around the sky, its right edge while the board is beside it. A double-click, or Enter
 * or Space, widens it as far as it goes or brings it back; the arrow keys move the edge a step, so
 * the arrow pointing away from the content widens it. A single click does nothing, since one ends
 * every drag.
 */
export function ResizeHandle({
  edge,
  width,
  min,
  max,
  onResize,
  onToggle,
}: {
  edge: "left" | "right";
  width: number;
  min: number;
  max: number;
  /** A new width; `done` when the drag or the key press that made it has ended. */
  onResize: (width: number, done: boolean) => void;
  onToggle: () => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    if (drag.current !== null) {
      onResize(dragged(event, drag.current, edge), false);
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>): void => {
    if (drag.current !== null) {
      onResize(dragged(event, drag.current, edge), true);
      drag.current = null;
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const outward = edge === "left" ? "ArrowLeft" : "ArrowRight";
    const inward = edge === "left" ? "ArrowRight" : "ArrowLeft";
    const next =
      event.key === outward
        ? width + STEP
        : event.key === inward
          ? width - STEP
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : null;
    if (next !== null) {
      event.preventDefault();
      onResize(next, true);
    }
  };
  // A click from the keyboard has no pointer behind it, and its detail is 0.
  const onClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (event.detail === 0) {
      onToggle();
    }
  };

  return (
    <button
      type="button"
      aria-label={`Width of the board's content, ${width} of at most ${max} pixels: drag or use the arrow keys, Enter widens it all the way or back`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
      onDoubleClick={onToggle}
      onKeyDown={onKeyDown}
      className={`absolute inset-y-0 ${edge === "left" ? "left-0 before:left-0.5" : "right-0 before:right-0.5"} z-10 w-2 cursor-col-resize touch-none before:absolute before:inset-y-4 before:w-0.5 before:rounded-full before:transition-colors hover:before:bg-fg-muted/60 focus-visible:outline-none focus-visible:before:bg-fg-primary/60 active:before:bg-fg-primary/60`}
    />
  );
}
