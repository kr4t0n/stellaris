import { describe, expect, it } from "vitest";
import {
  frameSphere,
  freeWidth,
  homeCamera,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  viewCenter,
  zoomAt,
  type Camera,
  type Viewport,
} from "./camera.js";
import { band, lower, tableText, type InsetViewport } from "./ios-tables.js";

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

/** The web's two viewports, then ones the port's insets make, to the floor and past it. */
const VIEWS: ReadonlyArray<{ readonly name: string; readonly view: InsetViewport }> = [
  { name: "islands closed", view: { ...closed, top: 0, bottom: 0 } },
  { name: "islands open", view: { ...open, top: 0, bottom: 0 } },
  {
    name: "a narrow display with a bar on its trailing side",
    view: { width: 466, height: 678, left: 0, right: 52, top: 0, bottom: 0 },
  },
  {
    name: "a tall display with a bar and a camera at its top",
    view: { width: 669, height: 951, left: 0, right: 0, top: 70, bottom: 0 },
  },
  {
    name: "a fold across the middle as a bottom inset",
    view: { width: 669, height: 951, left: 0, right: 0, top: 24, bottom: 526 },
  },
  {
    name: "insets that leave less than the narrowest free sky",
    view: { width: 320, height: 678, left: 52, right: 40, top: 30, bottom: 20 },
  },
  {
    name: "insets past the height",
    view: { width: 400, height: 300, left: 0, right: 0, top: 200, bottom: 200 },
  },
];

/** The cameras and spheres of the tests above, and a camera off the whole numbers. */
const CAMERAS: readonly Camera[] = [
  { x: 0, y: 0, scale: 1 },
  { x: 100, y: -50, scale: 1 },
  { x: 0, y: 0, scale: 3 },
  { x: -37.5, y: 12.25, scale: 2.6 },
];

const SPHERES = [
  { x: 200, y: 0, reach: 100 },
  { x: 900, y: 300, reach: 100 },
  { x: 2_000, y: 0, reach: 300 },
];

describe("the camera's table for BoardKit's port", () => {
  it("writes what the camera gives for every case to apps/ios/fixtures/sky", async () => {
    const cases: unknown[] = [];
    for (const { name, view } of VIEWS) {
      const web = band(view);
      const at = { x: view.width * 0.75, y: view.top + web.height * 0.3 };
      cases.push(
        { name, view, op: "freeWidth", expected: freeWidth(web) },
        { name, view, op: "viewCenter", expected: lower(viewCenter(web), view.top) },
        ...[120, 400, 4_000].map((radius) => ({
          name,
          view,
          op: "homeCamera",
          radius,
          expected: homeCamera(web, radius),
        })),
      );
      for (const camera of CAMERAS) {
        cases.push(
          ...[2, 0.8, 100, 0.001].map((factor) => ({
            name,
            view,
            op: "zoomAt",
            camera,
            factor,
            at,
            expected: zoomAt(camera, web, factor, lower(at, -view.top)),
          })),
          ...SPHERES.map((sphere) => ({
            name,
            view,
            op: "frameSphere",
            camera,
            sphere,
            expected: frameSphere(camera, web, sphere),
          })),
        );
      }
    }
    for (const camera of [...CAMERAS, { x: 0, y: 0, scale: 2 }]) {
      cases.push(
        ...[
          [40, -20],
          [-13.5, 7],
        ].map(([dx = 0, dy = 0]) => ({
          name: "a drag",
          op: "panBy",
          camera,
          dx,
          dy,
          expected: panBy(camera, dx, dy),
        })),
      );
    }
    await expect(tableText(cases)).toMatchFileSnapshot("../../../ios/fixtures/sky/camera.json");
  });

  it("works out the insets as the band between them, drawn lower", () => {
    const view: InsetViewport = {
      width: 400,
      height: 900,
      left: 0,
      right: 0,
      top: 100,
      bottom: 400,
    };
    // The free sky is the band from 100 to 500, so a home view fits 400 by 400 and centres at 300.
    expect(lower(viewCenter(band(view)), view.top)).toEqual({ x: 200, y: 300 });
    expect(homeCamera(band(view), 200).scale).toBe(1);
  });
});
