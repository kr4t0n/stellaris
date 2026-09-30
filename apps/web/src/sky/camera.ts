/** A point on the canvas in CSS pixels. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** Where the camera looks: the world point drawn at the middle of the free sky, and the scale. */
export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** The sky's canvas and the islands covering its sides, in CSS pixels. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
}

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 3;
/** The home view never draws the sky smaller or larger than this, however it fits. */
const HOME_MIN = 0.45;
const HOME_MAX = 1.35;
/** Room kept clear at the top of the sky for the HUD. */
const TOP = 64;
/** A framed sphere keeps this much of its own size again around it. */
const FRAME_ROOM = 1.15;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function freeWidth(view: Viewport): number {
  return Math.max(240, view.width - view.left - view.right);
}

/** Where the camera's world point is drawn: the middle of the gap between the islands. */
export function viewCenter(view: Viewport): ScreenPoint {
  return { x: view.left + freeWidth(view) / 2, y: view.height / 2 };
}

/** The whole sky, centered on the core and fitted to the gap between the islands. */
export function homeCamera(view: Viewport, radius: number): Camera {
  const fit = Math.min(freeWidth(view), view.height) / (2 * radius);
  return { x: 0, y: 0, scale: clamp(fit, HOME_MIN, HOME_MAX) };
}

/** Zoomed by `factor` so the world point under `at` stays under it. */
export function zoomAt(camera: Camera, view: Viewport, factor: number, at: ScreenPoint): Camera {
  const scale = clamp(camera.scale * factor, MIN_SCALE, MAX_SCALE);
  const center = viewCenter(view);
  const worldX = camera.x + (at.x - center.x) / camera.scale;
  const worldY = camera.y + (at.y - center.y) / camera.scale;
  return {
    x: worldX - (at.x - center.x) / scale,
    y: worldY - (at.y - center.y) / scale,
    scale,
  };
}

/** Moved so the sky follows a drag of `dx`, `dy` screen pixels. */
export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: camera.x - dx / camera.scale, y: camera.y - dy / camera.scale };
}

/**
 * A camera that brings a sphere, with room around it, into the free sky: centered on it, and
 * zoomed out only as far as it needs to fit. Null when the sphere is in view already, so a focus
 * the user can already see moves nothing.
 */
export function frameSphere(
  camera: Camera,
  view: Viewport,
  sphere: { readonly x: number; readonly y: number; readonly reach: number },
): Camera | null {
  const center = viewCenter(view);
  const x = center.x + (sphere.x - camera.x) * camera.scale;
  const y = center.y + (sphere.y - camera.y) * camera.scale;
  const reach = sphere.reach * camera.scale;
  const inside =
    x - reach >= view.left &&
    x + reach <= view.width - view.right &&
    y - reach >= TOP &&
    y + reach <= view.height;
  if (inside) {
    return null;
  }
  const fits = Math.min(freeWidth(view), view.height - TOP) / (2 * sphere.reach * FRAME_ROOM);
  return {
    x: sphere.x,
    y: sphere.y,
    scale: Math.min(camera.scale, clamp(fits, MIN_SCALE, MAX_SCALE)),
  };
}
