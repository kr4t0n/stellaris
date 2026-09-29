import type { House, Memorial, Plot, Point, Rect, Square } from "./types.js";

/**
 * Where everything stands, in tiles. The layout is a pure function of creation order and size,
 * so a project or a citizen appears in the same place on every reload and every machine.
 * Houses line the top, the square sits beneath them, plots fill a grid below the square, and the
 * memorial garden closes the row of houses.
 */

export const HOUSE_W = 4;
export const HOUSE_H = 3;
const HOUSE_GAP = 1;
const HOUSES_Y = 1;
const HOUSES_X = 2;

const SQUARE_W = 24;
const SQUARE_H = 8;
const SQUARE_Y = HOUSES_Y + HOUSE_H + 1;

const PLOT_COLUMNS = 3;
const SLOT_W = 14;
const SLOT_H = 11;
const PLOT_GAP = 2;
const PLOTS_Y = SQUARE_Y + SQUARE_H + 1;

const MARGIN = 1;

export interface LayoutInput {
  readonly projects: readonly { readonly slug: string; readonly members: number }[];
  /** Active citizens in creation order. */
  readonly citizens: readonly string[];
  readonly memorials: readonly string[];
}

export interface Layout {
  readonly size: { readonly w: number; readonly h: number };
  readonly square: Square;
  readonly plots: ReadonlyMap<string, PlotLayout>;
  readonly houses: ReadonlyMap<string, Omit<House, "lamp">>;
  readonly memorials: ReadonlyMap<string, Point>;
}

export interface PlotLayout {
  readonly rect: Rect;
  readonly sign: Point;
  readonly gate: Point;
  readonly barn: Rect;
  /** Where crops may stand, in reading order. */
  readonly cells: readonly Point[];
  /** Where a citizen stands when it works in the plot without a crop of its own. */
  readonly desks: readonly Point[];
}

/** Plots come in three sizes by membership, all inside the same grid slot. */
export function plotSize(members: number): { w: number; h: number } {
  if (members >= 6) return { w: 14, h: 10 };
  if (members >= 3) return { w: 12, h: 9 };
  return { w: 10, h: 8 };
}

function plotLayout(rect: Rect): PlotLayout {
  const cells: Point[] = [];
  for (let y = rect.y + 3; y <= rect.y + rect.h - 2; y += 2) {
    for (let x = rect.x + 1; x <= rect.x + rect.w - 3; x += 2) {
      cells.push({ x, y });
    }
  }
  const desks: Point[] = [];
  for (let x = rect.x + 2; x <= rect.x + rect.w - 5; x += 2) {
    desks.push({ x, y: rect.y + 1 });
  }
  return {
    rect,
    sign: { x: rect.x + 1, y: rect.y },
    gate: { x: rect.x + Math.floor(rect.w / 2), y: rect.y + rect.h },
    barn: { x: rect.x + rect.w - 3, y: rect.y + 1, w: 2, h: 2 },
    cells,
    desks,
  };
}

export function layoutWorld(input: LayoutInput): Layout {
  const housesW = input.citizens.length * (HOUSE_W + HOUSE_GAP);
  const memorialW = input.memorials.length === 0 ? 0 : 2 + input.memorials.length * 2;
  const plotRows = Math.ceil(input.projects.length / PLOT_COLUMNS);
  const plotsW = Math.min(input.projects.length, PLOT_COLUMNS) * (SLOT_W + PLOT_GAP);
  const width =
    Math.max(SQUARE_W + 2 * MARGIN, HOUSES_X + housesW + memorialW + MARGIN, plotsW + 2 * MARGIN) +
    MARGIN;
  const height = PLOTS_Y + plotRows * (SLOT_H + PLOT_GAP) + MARGIN;

  const squareX = Math.floor((width - SQUARE_W) / 2);
  const square: Square = {
    rect: { x: squareX, y: SQUARE_Y, w: SQUARE_W, h: SQUARE_H },
    frontDesk: { x: squareX + 2, y: SQUARE_Y + 2, w: 3, h: 2 },
    townHall: { x: squareX + Math.floor(SQUARE_W / 2) - 2, y: SQUARE_Y + 1, w: 5, h: 3 },
    library: { x: squareX + SQUARE_W - 6, y: SQUARE_Y + 2, w: 4, h: 2 },
    mailbox: { x: squareX, y: SQUARE_Y + SQUARE_H - 2 },
    clock: { x: squareX + SQUARE_W - 2, y: SQUARE_Y + SQUARE_H - 3 },
    bench: { x: squareX + Math.floor(SQUARE_W / 2), y: SQUARE_Y + SQUARE_H - 2 },
  };

  const plots = new Map<string, PlotLayout>();
  const plotsX = Math.floor((width - plotsW) / 2);
  input.projects.forEach((project, index) => {
    const column = index % PLOT_COLUMNS;
    const row = Math.floor(index / PLOT_COLUMNS);
    const size = plotSize(project.members);
    const rect: Rect = {
      x: plotsX + column * (SLOT_W + PLOT_GAP) + Math.floor((SLOT_W - size.w) / 2),
      y: PLOTS_Y + row * (SLOT_H + PLOT_GAP),
      w: size.w,
      h: size.h,
    };
    plots.set(project.slug, plotLayout(rect));
  });

  const houses = new Map<string, Omit<House, "lamp">>();
  input.citizens.forEach((name, index) => {
    const rect: Rect = {
      x: HOUSES_X + index * (HOUSE_W + HOUSE_GAP),
      y: HOUSES_Y,
      w: HOUSE_W,
      h: HOUSE_H,
    };
    houses.set(name, { agent: name, rect, door: { x: rect.x + 1, y: rect.y + rect.h } });
  });

  const memorials = new Map<string, Point>();
  const memorialX = HOUSES_X + housesW + 2;
  input.memorials.forEach((name, index) => {
    memorials.set(name, { x: memorialX + index * 2, y: HOUSES_Y + 1 });
  });

  return { size: { w: width, h: height }, square, plots, houses, memorials };
}

/** The tile a citizen stands on in the square, by role: the front desk, the hall, or the bench. */
export function squareSpot(square: Square, role: string, index: number): Point {
  switch (role) {
    case "concierge":
      return { x: square.frontDesk.x + 1, y: square.frontDesk.y + square.frontDesk.h };
    case "steward":
      return { x: square.townHall.x + 2, y: square.townHall.y + square.townHall.h };
    default:
      return { x: square.bench.x - 1 + index, y: square.bench.y };
  }
}

/** The tile beside a crop where its claimer or reviewer stands. */
export function besideCrop(cell: Point): Point {
  return { x: cell.x + 1, y: cell.y };
}

export function memorialFrom(agent: string, role: string, reason: string, at: Point): Memorial {
  return { agent, role, reason, at };
}

export function plotFrom(
  slug: string,
  name: string,
  layout: PlotLayout,
  rest: Omit<Plot, "slug" | "name" | "rect" | "sign" | "gate" | "barn">,
): Plot {
  return {
    slug,
    name,
    rect: layout.rect,
    sign: layout.sign,
    gate: layout.gate,
    barn: layout.barn,
    ...rest,
  };
}
