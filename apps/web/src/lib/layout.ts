/** The gap every island keeps to the window's edge and to the next island. */
export const ISLAND_MARGIN = 16;
export const NAVIGATOR_WIDTH = 256;
/** The narrowest the content island goes, which still holds a plan, a composer, and a header. */
export const CONTENT_MIN = 420;

/** A width the user chose for the content island: a number of pixels, or as wide as it goes. */
export type ChosenWidth = number | "widest" | null;

const STORAGE_KEY = "stellaris.contentWidth";

/** The content island's width when the user has chosen none: two fifths of the window, 420 to 680. */
export function defaultContentWidth(window: number): number {
  return Math.round(Math.min(680, Math.max(CONTENT_MIN, window * 0.4)));
}

/** The widest the content island goes: up to the navigator, with the usual gap between them. */
export function widestContentWidth(window: number): number {
  return Math.max(CONTENT_MIN, window - NAVIGATOR_WIDTH - 3 * ISLAND_MARGIN);
}

/** The width the content island takes: the chosen one, held within what the window allows. */
export function contentWidth(window: number, chosen: ChosenWidth): number {
  const widest = widestContentWidth(window);
  if (chosen === "widest") {
    return widest;
  }
  return Math.round(Math.min(widest, Math.max(CONTENT_MIN, chosen ?? defaultContentWidth(window))));
}

/** What a double-click on the island's edge chooses: the widest, or back to the default from there. */
export function toggledWidth(window: number, chosen: ChosenWidth): ChosenWidth {
  return contentWidth(window, chosen) >= widestContentWidth(window) ? null : "widest";
}

/** The width this browser chose, if any. */
export function readChosenWidth(): ChosenWidth {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "widest") {
    return "widest";
  }
  const width = Number(stored);
  return stored !== null && Number.isFinite(width) && width > 0 ? width : null;
}

export function saveChosenWidth(chosen: ChosenWidth): void {
  if (chosen === null) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, String(chosen));
  }
}
