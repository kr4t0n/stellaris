/** The gap every island keeps to the window's edge and to the next island. */
export const ISLAND_MARGIN = 16;
export const NAVIGATOR_WIDTH = 256;
/** The narrowest the content island goes, which still holds a plan, a composer, and a header. */
export const CONTENT_MIN = 420;
/** The ask box's widest, and its narrowest, which still holds the composer's row. */
export const ASK_WIDEST = 560;
export const ASK_NARROWEST = 280;
/** The sky's room below which, around the sky, the ask box leaves it for the window's middle. */
const ASK_ROOM = 460;

/**
 * Where the open board sits: `around` the sky, the navigator island on the left and the content
 * island on the right with the sky between them, or `beside` it, both in one panel on the left
 * with the sky to its right.
 */
export type BoardLayout = "around" | "beside";

/** A width the user chose for the content island: a number of pixels, or as wide as it goes. */
export type ChosenWidth = number | "widest" | null;

/** The room the board leaves the sky, as insets from the window's edges. */
export interface SkyRoom {
  readonly left: number;
  readonly right: number;
}

const STORAGE_KEY = "stellaris.contentWidth";
const LAYOUT_KEY = "stellaris.boardLayout";

/** The content island's width when the user has chosen none: two fifths of the window, 420 to 680. */
export function defaultContentWidth(window: number): number {
  return Math.round(Math.min(680, Math.max(CONTENT_MIN, window * 0.4)));
}

/**
 * The widest the content goes: around the sky, up to the navigator with the usual gap between the
 * islands; beside it, until the panel reaches the window's right margin.
 */
export function widestContentWidth(window: number, layout: BoardLayout): number {
  const margins = layout === "around" ? 3 : 2;
  return Math.max(CONTENT_MIN, window - NAVIGATOR_WIDTH - margins * ISLAND_MARGIN);
}

/** The width the content takes: the chosen one, held within what the window allows. */
export function contentWidth(window: number, chosen: ChosenWidth, layout: BoardLayout): number {
  const widest = widestContentWidth(window, layout);
  if (chosen === "widest") {
    return widest;
  }
  return Math.round(Math.min(widest, Math.max(CONTENT_MIN, chosen ?? defaultContentWidth(window))));
}

/** What a double-click on the content's edge chooses: the widest, or back to the default from there. */
export function toggledWidth(
  window: number,
  chosen: ChosenWidth,
  layout: BoardLayout,
): ChosenWidth {
  return contentWidth(window, chosen, layout) >= widestContentWidth(window, layout)
    ? null
    : "widest";
}

/** The room the open board leaves the sky, which centers in the rest. */
export function skyRoom(layout: BoardLayout, content: number): SkyRoom {
  return layout === "around"
    ? { left: NAVIGATOR_WIDTH + 2 * ISLAND_MARGIN, right: content + 2 * ISLAND_MARGIN }
    : { left: NAVIGATOR_WIDTH + content + 2 * ISLAND_MARGIN, right: 0 };
}

/**
 * Where the ask box floats: in the middle of the sky's room. Around the sky, a room too narrow
 * for it sends it to the middle of the window; beside the sky, it narrows to fit the room, and
 * once it can narrow no further it keeps to the window's right margin, over as little of the
 * panel as it can.
 */
export function askBoxPlacement(
  window: number,
  room: SkyRoom,
  layout: BoardLayout,
): { left: number; width: number } {
  const sky = window - room.left - room.right;
  if (layout === "beside") {
    const width = Math.max(ASK_NARROWEST, Math.min(ASK_WIDEST, sky - 2 * ISLAND_MARGIN));
    const centred = room.left + (sky - width) / 2;
    return { left: Math.max(0, Math.min(centred, window - ISLAND_MARGIN - width)), width };
  }
  const roomy = sky >= ASK_ROOM;
  const across = roomy ? sky : window;
  const width = Math.min(ASK_WIDEST, across - 2 * ISLAND_MARGIN);
  return { left: (roomy ? room.left : 0) + (across - width) / 2, width };
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

/** Where this browser chose to put the board: around the sky, as before, unless it chose beside. */
export function readBoardLayout(): BoardLayout {
  return localStorage.getItem(LAYOUT_KEY) === "beside" ? "beside" : "around";
}

export function saveBoardLayout(layout: BoardLayout): void {
  localStorage.setItem(LAYOUT_KEY, layout);
}
