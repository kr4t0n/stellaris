import { describe, expect, it } from "vitest";
import { drawnSizes } from "./post-image.js";

describe("drawnSizes", () => {
  it("starts at 4,096 pixels on the longest side and steps down by 0.7 of the last, to 32", () => {
    const square = drawnSizes(4400, 4400).map((size) => size.width);
    expect(square).toEqual([4096, 2867, 2006, 1404, 982, 687, 480, 336, 235, 164, 114, 79, 55, 38]);
    expect(drawnSizes(4400, 4400).every((size) => size.width === size.height)).toBe(true);
    // The other side keeps the picture's shape.
    expect(drawnSizes(6000, 4000).slice(0, 3)).toEqual([
      { width: 4096, height: 2731 },
      { width: 2867, height: 1911 },
      { width: 2006, height: 1337 },
    ]);
    expect(drawnSizes(4000, 6000)[0]).toEqual({ width: 2731, height: 4096 });
    expect(drawnSizes(5000, 40)[0]).toEqual({ width: 4096, height: 33 });
  });

  it("never draws a picture larger than it is", () => {
    expect(drawnSizes(1800, 1200).slice(0, 2)).toEqual([
      { width: 1800, height: 1200 },
      { width: 1260, height: 840 },
    ]);
    expect(drawnSizes(40, 20)).toEqual([{ width: 40, height: 20 }]);
    expect(drawnSizes(1, 1)).toEqual([{ width: 1, height: 1 }]);
    // A side that rounds to nothing is a pixel.
    expect(drawnSizes(8000, 1)[0]).toEqual({ width: 4096, height: 1 });
  });
});
