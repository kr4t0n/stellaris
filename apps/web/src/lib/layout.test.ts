import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASK_NARROWEST,
  CONTENT_MIN,
  askBoxPlacement,
  contentWidth,
  defaultContentWidth,
  readBoardLayout,
  saveBoardLayout,
  skyRoom,
  toggledWidth,
  widestContentWidth,
  type BoardLayout,
} from "./layout.js";

/** Where the ask box goes at a window's width, with the content at its default. */
function placed(window: number, layout: BoardLayout) {
  return askBoxPlacement(window, skyRoom(layout, contentWidth(window, null, layout)), layout);
}

/** A local storage of the test's own, whose items it hands back. */
function storage(): Map<string, string> {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  });
  return items;
}

describe("the content's width", () => {
  it("takes two fifths of the window by default, between 420 and 680, in either layout", () => {
    expect(defaultContentWidth(1440)).toBe(576);
    expect(defaultContentWidth(800)).toBe(CONTENT_MIN);
    expect(defaultContentWidth(2560)).toBe(680);
    expect(contentWidth(1440, null, "around")).toBe(576);
    expect(contentWidth(1440, null, "beside")).toBe(576);
  });

  it("around the sky, holds a chosen width within the window, up to the navigator", () => {
    expect(widestContentWidth(1440, "around")).toBe(1440 - 256 - 48);
    expect(contentWidth(1440, 900, "around")).toBe(900);
    expect(contentWidth(1440, 5000, "around")).toBe(1136);
    expect(contentWidth(1440, 100, "around")).toBe(CONTENT_MIN);
    expect(contentWidth(1440, "widest", "around")).toBe(1136);
    // A window too small for both islands still gives the content its narrowest.
    expect(contentWidth(600, "widest", "around")).toBe(CONTENT_MIN);
  });

  it("beside the sky, holds a chosen width until the panel reaches the window's right margin", () => {
    // The panel is the navigator and the content, 16 px in from both edges at its widest.
    expect(widestContentWidth(1440, "beside")).toBe(1440 - 256 - 32);
    expect(contentWidth(1440, 900, "beside")).toBe(900);
    expect(contentWidth(1440, 5000, "beside")).toBe(1152);
    expect(contentWidth(1440, 100, "beside")).toBe(CONTENT_MIN);
    expect(contentWidth(1440, "widest", "beside")).toBe(1152);
    expect(contentWidth(600, "widest", "beside")).toBe(CONTENT_MIN);
  });

  it("toggles between the widest and the default in either layout", () => {
    for (const layout of ["around", "beside"] as const) {
      expect(toggledWidth(1440, null, layout)).toBe("widest");
      expect(toggledWidth(1440, 800, layout)).toBe("widest");
      expect(toggledWidth(1440, "widest", layout)).toBeNull();
      expect(toggledWidth(1440, 5000, layout)).toBeNull();
    }
    // 1140 is past the widest around the sky and short of it beside the sky.
    expect(toggledWidth(1440, 1140, "around")).toBeNull();
    expect(toggledWidth(1440, 1140, "beside")).toBe("widest");
  });
});

describe("the sky's room", () => {
  it("around the sky, lies between the navigator island and the content island", () => {
    expect(skyRoom("around", 576)).toEqual({ left: 256 + 32, right: 576 + 32 });
  });

  it("beside the sky, lies right of the panel, out to the window's edge", () => {
    expect(skyRoom("beside", 576)).toEqual({ left: 256 + 576 + 32, right: 0 });
  });
});

describe("the ask box", () => {
  it("around the sky, sits in the middle of the room, or of the window when the room is under 460", () => {
    // 1440: a room of 544 from 288.
    expect(placed(1440, "around")).toEqual({ left: 304, width: 512 });
    // 1280: a room of 448, so the box takes the window's middle at its widest.
    expect(placed(1280, "around")).toEqual({ left: 360, width: 560 });
  });

  it("beside the sky, sits in the middle of the room, narrowing with it", () => {
    // 1440: a room of 576 from 864.
    expect(placed(1440, "beside")).toEqual({ left: 880, width: 544 });
    // 1246: a room of 460 from 786.
    expect(placed(1246, "beside")).toEqual({ left: 802, width: 428 });
    // 1024: a room of 316 from 708, under the 460 that sends it to the window's middle around the sky.
    expect(placed(1024, "beside")).toEqual({ left: 724, width: 284 });
  });

  it("beside the sky, keeps inside the room at every width it fits, and to the window's right margin once it can't", () => {
    const wrong = [];
    const seen = { fits: 0, narrowest: 0 };
    for (let window = 700; window <= 2560; window += 1) {
      const room = skyRoom("beside", contentWidth(window, null, "beside"));
      const sky = window - room.left;
      const { left, width } = placed(window, "beside");
      const fits = sky - 32 >= ASK_NARROWEST;
      seen[fits ? "fits" : "narrowest"] += 1;
      const right = fits
        ? left - room.left === (sky - width) / 2 &&
          left >= room.left + 16 &&
          left + width <= window - 16
        : width === ASK_NARROWEST && left + width === window - 16;
      if (!right) {
        wrong.push({ window, left, width, room: room.left });
      }
    }
    expect(wrong).toEqual([]);
    // Both cases were met: the box fits from 1020 up and keeps to the margin below.
    expect(seen).toEqual({ fits: 2560 - 1020 + 1, narrowest: 1020 - 700 });
  });
});

describe("where this browser puts the board", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is around the sky until the browser chooses beside, and stays as chosen", () => {
    const items = storage();
    expect(readBoardLayout()).toBe("around");
    saveBoardLayout("beside");
    expect(items.get("stellaris.boardLayout")).toBe("beside");
    expect(readBoardLayout()).toBe("beside");
    saveBoardLayout("around");
    expect(readBoardLayout()).toBe("around");
    // Anything else stored there reads as the old layout, and the width's own key is untouched.
    items.set("stellaris.boardLayout", "sideways");
    expect(readBoardLayout()).toBe("around");
    expect(items.has("stellaris.contentWidth")).toBe(false);
  });
});
