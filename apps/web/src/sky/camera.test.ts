import { describe, expect, it } from "vitest";
import {
  frameSphere,
  homeCamera,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  viewCenter,
  zoomAt,
  type Camera,
  type Viewport,
} from "./camera.js";

const open: Viewport = { width: 1600, height: 1000, left: 288, right: 712 };
const closed: Viewport = { width: 1600, height: 1000, left: 0, right: 0 };

function screenOf(camera: Camera, view: Viewport, x: number, y: number) {
  const center = viewCenter(view);
  return {
    x: center.x + (x - camera.x) * camera.scale,
    y: center.y + (y - camera.y) * camera.scale,
  };
}

describe("camera", () => {
  it("fits the whole sky in the gap between the islands, within the home bounds", () => {
    expect(homeCamera(closed, 400)).toEqual({ x: 0, y: 0, scale: 1.25 });
    expect(homeCamera(open, 400).scale).toBe(0.75);
    expect(homeCamera(closed, 4_000).scale).toBe(0.45);
    expect(viewCenter(open)).toEqual({ x: 588, y: 500 });
  });

  it("zooms around the pointer, keeping the world point under it where it was", () => {
    const camera: Camera = { x: 100, y: -50, scale: 1 };
    const at = { x: 1200, y: 300 };
    const zoomed = zoomAt(camera, closed, 2, at);
    expect(zoomed.scale).toBe(2);
    const before = screenOf(camera, closed, 500, -250);
    expect(before).toEqual(at);
    expect(screenOf(zoomed, closed, 500, -250)).toEqual(at);
    expect(zoomAt(camera, closed, 100, at).scale).toBe(MAX_SCALE);
    expect(zoomAt(camera, closed, 0.001, at).scale).toBe(MIN_SCALE);
  });

  it("pans so the sky follows the drag", () => {
    const camera: Camera = { x: 0, y: 0, scale: 2 };
    const moved = panBy(camera, 40, -20);
    expect(screenOf(moved, closed, 0, 0)).toEqual({ x: 840, y: 480 });
  });

  it("frames a sphere out of view and leaves one in view alone", () => {
    const camera: Camera = { x: 0, y: 0, scale: 1 };
    expect(frameSphere(camera, closed, { x: 200, y: 0, reach: 100 })).toBeNull();
    expect(frameSphere(camera, open, { x: 900, y: 300, reach: 100 })).toEqual({
      x: 900,
      y: 300,
      scale: 1,
    });
    // A sphere too big for the gap at this scale is fitted by zooming out.
    const framed = frameSphere({ x: 0, y: 0, scale: 3 }, open, { x: 2_000, y: 0, reach: 300 });
    expect(framed?.x).toBe(2_000);
    expect(framed?.scale).toBeCloseTo(600 / (2 * 300 * 1.15));
  });
});
