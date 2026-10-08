import { describe, expect, it } from "vitest";
import {
  CONTENT_MIN,
  contentWidth,
  defaultContentWidth,
  toggledWidth,
  widestContentWidth,
} from "./layout.js";

describe("the content island's width", () => {
  it("takes two fifths of the window by default, between 420 and 680", () => {
    expect(defaultContentWidth(1440)).toBe(576);
    expect(defaultContentWidth(800)).toBe(CONTENT_MIN);
    expect(defaultContentWidth(2560)).toBe(680);
    expect(contentWidth(1440, null)).toBe(576);
  });

  it("holds a chosen width within the window, up to the navigator", () => {
    expect(widestContentWidth(1440)).toBe(1440 - 256 - 48);
    expect(contentWidth(1440, 900)).toBe(900);
    expect(contentWidth(1440, 5000)).toBe(1136);
    expect(contentWidth(1440, 100)).toBe(CONTENT_MIN);
    expect(contentWidth(1440, "widest")).toBe(1136);
    // A window too small for both islands still gives the content its narrowest.
    expect(contentWidth(600, "widest")).toBe(CONTENT_MIN);
  });

  it("toggles between the widest and the default", () => {
    expect(toggledWidth(1440, null)).toBe("widest");
    expect(toggledWidth(1440, 800)).toBe("widest");
    expect(toggledWidth(1440, "widest")).toBeNull();
    expect(toggledWidth(1440, 5000)).toBeNull();
  });
});
