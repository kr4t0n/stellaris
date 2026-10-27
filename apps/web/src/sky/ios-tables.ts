import type { ScreenPoint, Viewport } from "./camera.js";

/**
 * The sky's tables for BoardKit's port, in `apps/ios/fixtures/sky`, as JSON with each value on
 * one line when it fits in 160 columns and spread one entry to a line when it doesn't, so a change
 * shows as the lines it touched. Only the tests that write the tables import it.
 */
export function tableText(value: unknown): string {
  return `${layout(value, "")}\n`;
}

const WIDTH = 160;

function layout(value: unknown, indent: string): string {
  const flat = JSON.stringify(value) ?? "null";
  if (value === null || typeof value !== "object" || indent.length + flat.length <= WIDTH) {
    return flat;
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.length === 0
      ? "[]"
      : `[\n${items.map((item) => `${inner}${layout(item, inner)}`).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value).filter(([, each]) => each !== undefined);
  const lines = entries.map(
    ([key, each]) => `${inner}${JSON.stringify(key)}: ${layout(each, inner)}`,
  );
  return entries.length === 0 ? "{}" : `{\n${lines.join(",\n")}\n${indent}}`;
}

/**
 * A viewport as BoardKit's port takes it, with top and bottom insets beside the islands' left and
 * right, for a fold, the chat part, or the cameras. It is the web's camera over the band between
 * the two, drawn `top` lower, which is how the tables work out the port's answers.
 */
export interface InsetViewport extends Viewport {
  readonly top: number;
  readonly bottom: number;
}

/** The band between the insets, as a viewport of the web's camera. */
export function band(view: InsetViewport): Viewport {
  return {
    width: view.width,
    height: view.height - view.top - view.bottom,
    left: view.left,
    right: view.right,
  };
}

/** A point moved down the screen, from the band's top to the viewport's, or back with a negative `by`. */
export function lower(point: ScreenPoint, by: number): ScreenPoint {
  return { x: point.x, y: point.y + by };
}
