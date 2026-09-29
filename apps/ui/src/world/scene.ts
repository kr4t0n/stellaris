import {
  Application,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
  TilingSprite,
  type FederatedPointerEvent,
} from "pixi.js";
import {
  citizenTextures,
  cropTexture,
  propTexture,
  TILE,
  tiles,
  weatherTexture,
  type CitizenFrameState,
} from "./sprites.js";
import type { Citizen, Plot, Point, Rect, World } from "./types.js";

/**
 * The canvas layer of the playground: it draws a World and animates the difference between one
 * World and the next. It owns no state of its own beyond what is on screen, and every event it
 * raises names a board entity, never a pixel.
 */

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export type Building = "frontDesk" | "townHall" | "library" | "mailbox" | "clock";

export type Focus =
  | { readonly kind: "citizen"; readonly name: string }
  | { readonly kind: "plot"; readonly slug: string }
  | { readonly kind: "building"; readonly building: Building }
  | null;

export interface SceneCallbacks {
  readonly onHoverCitizen: (name: string | null) => void;
  readonly onHoverPlot: (slug: string | null) => void;
  readonly onClickCitizen: (name: string) => void;
  readonly onClickPlot: (slug: string) => void;
  readonly onClickCrop: (taskId: string, slug: string) => void;
  readonly onClickBuilding: (building: Building) => void;
  /** A citizen dropped on a plot, or outside every plot (`null`). */
  readonly onDropCitizen: (name: string, from: string, target: string | null) => void;
  /** A crop dropped on a citizen. */
  readonly onDropCrop: (taskId: string, slug: string, citizen: string) => void;
  readonly onCamera: (camera: Camera) => void;
}

export interface WorldScene {
  apply(world: World): void;
  focus(target: Focus, animate?: boolean): void;
  fit(): void;
  panBy(dx: number, dy: number): void;
  zoomBy(step: number): void;
  toScreen(point: Point): { x: number; y: number };
  setReducedMotion(reduced: boolean): void;
  /** How much of the canvas's right side a drawer covers, so focusing centers in the visible part. */
  setInset(right: number): void;
  destroy(): void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const WALK_TILES_PER_SECOND = 6;
const FRAME_MS = 420;
const DRAG_THRESHOLD_PX = 6;

interface Tween {
  readonly target: { x: number; y: number };
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
  readonly duration: number;
  elapsed: number;
  readonly onDone?: (() => void) | undefined;
}

function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function px(point: Point): { x: number; y: number } {
  return { x: point.x * TILE, y: point.y * TILE };
}

function frameStateOf(state: Citizen["state"]): CitizenFrameState {
  switch (state) {
    case "walking":
      return "walk";
    case "working":
    case "talking":
      return "work";
    case "sleeping":
      return "sleep";
    default:
      return "idle";
  }
}

class CitizenActor {
  readonly root = new Container();
  readonly sprite: Sprite;
  readonly glow: Sprite;
  readonly zzz: Sprite;
  frames: Texture[] = [];
  frameIndex = 0;
  frameClock = 0;
  target = { x: 0, y: 0 };
  state: Citizen["state"] = "idle";
  role: string;
  cli: Citizen["cli"];
  where: string;

  constructor(citizen: Citizen) {
    this.role = citizen.role;
    this.cli = citizen.cli;
    this.where = citizen.where;
    this.glow = new Sprite({ texture: propTexture("glow"), anchor: 0.5, blendMode: "add" });
    this.glow.alpha = 0.22;
    this.glow.scale.set(2.5);
    this.glow.y = -TILE * 0.6;
    this.glow.visible = false;
    this.sprite = new Sprite({
      texture: citizenTextures(citizen.role, citizen.cli, "idle")[0] ?? Texture.EMPTY,
      anchor: { x: 0.5, y: 1 },
    });
    this.zzz = new Sprite({ texture: propTexture("zzz"), anchor: { x: 0, y: 1 } });
    this.zzz.x = 4;
    this.zzz.y = -TILE * 0.9;
    this.zzz.visible = false;
    this.root.addChild(this.glow, this.sprite, this.zzz);
    this.root.eventMode = "static";
    this.root.cursor = "pointer";
    this.root.hitArea = new Rectangle(-8, -20, 16, 20);
    this.setState(citizen.state, citizen.role, citizen.cli);
  }

  setState(state: Citizen["state"], role: string, cli: Citizen["cli"]): void {
    if (state === this.state && role === this.role && cli === this.cli && this.frames.length > 0)
      return;
    this.state = state;
    this.role = role;
    this.cli = cli;
    this.frames = citizenTextures(role, cli, frameStateOf(state));
    this.frameIndex = 0;
    this.sprite.texture = this.frames[0] ?? this.sprite.texture;
    this.zzz.visible = state === "sleeping";
  }

  tick(deltaMs: number): void {
    this.frameClock += deltaMs;
    const period = this.state === "walking" ? FRAME_MS / 2 : FRAME_MS;
    if (this.frameClock >= period) {
      this.frameClock = 0;
      this.frameIndex = (this.frameIndex + 1) % Math.max(1, this.frames.length);
      const frame = this.frames[this.frameIndex];
      if (frame !== undefined) this.sprite.texture = frame;
    }
    if (this.state === "sleeping") {
      this.zzz.alpha = 0.6 + 0.4 * Math.sin(performance.now() / 500);
    }
    this.root.zIndex = this.root.y;
  }
}

interface PlotView {
  readonly hit: Container;
  readonly crops: Map<string, Sprite>;
  readonly marks: Map<string, Sprite>;
  readonly weather: Map<string, Sprite>;
  readonly flagless: Sprite | null;
}

function layoutKey(world: World): string {
  return JSON.stringify({
    size: world.size,
    plots: world.plots.map((plot) => [plot.slug, plot.rect]),
    houses: world.houses.map((house) => [house.agent, house.rect]),
    memorials: world.memorials.map((memorial) => [memorial.agent, memorial.at]),
  });
}

function tiling(texture: Texture, rect: Rect): TilingSprite {
  const sprite = new TilingSprite({ texture, width: rect.w * TILE, height: rect.h * TILE });
  sprite.x = rect.x * TILE;
  sprite.y = rect.y * TILE;
  return sprite;
}

function contains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h
  );
}

export async function createWorldScene(
  host: HTMLElement,
  callbacks: SceneCallbacks,
): Promise<WorldScene> {
  const app = new Application();
  await app.init({
    resizeTo: host,
    background: "#0c0f17",
    antialias: false,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    roundPixels: true,
  });
  host.appendChild(app.canvas);
  app.canvas.style.display = "block";
  app.canvas.style.touchAction = "none";

  const camera = new Container();
  const ground = new Container();
  const actors = new Container({ sortableChildren: true });
  const night = new Graphics();
  const highlight = new Graphics();
  camera.addChild(ground, actors, night, highlight);
  app.stage.addChild(camera);
  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;

  let zoom = 2;
  let world: World | null = null;
  let currentLayout = "";
  let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tweens: Tween[] = [];
  const citizens = new Map<string, CitizenActor>();
  const plots = new Map<string, PlotView>();
  const houseGlows = new Map<string, Sprite>();
  let mailFlag: Sprite | null = null;
  let destroyed = false;
  // A focus asked for before the first world arrives is honored when it does, instead of a fit.
  let requestedFocus: Focus = null;

  const emitCamera = (): void => {
    callbacks.onCamera({ x: camera.x, y: camera.y, zoom });
  };

  const setZoom = (next: number, around?: { x: number; y: number }): void => {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(next)));
    if (clamped === zoom) return;
    const pivot = around ?? { x: app.screen.width / 2, y: app.screen.height / 2 };
    const worldX = (pivot.x - camera.x) / zoom;
    const worldY = (pivot.y - camera.y) / zoom;
    zoom = clamped;
    camera.scale.set(zoom);
    camera.x = Math.round(pivot.x - worldX * zoom);
    camera.y = Math.round(pivot.y - worldY * zoom);
    emitCamera();
  };

  const tweenCamera = (x: number, y: number): void => {
    for (let index = tweens.length - 1; index >= 0; index -= 1) {
      if (tweens[index]?.target === camera.position) tweens.splice(index, 1);
    }
    if (reducedMotion) {
      camera.x = x;
      camera.y = y;
      emitCamera();
      return;
    }
    tweens.push({
      target: camera.position,
      from: { x: camera.x, y: camera.y },
      to: { x, y },
      duration: 450,
      elapsed: 0,
      onDone: emitCamera,
    });
  };

  // A drawer covers the right of the canvas; centering and fitting use what is left.
  let insetRight = 0;
  const viewport = (): { width: number; height: number } => ({
    width: Math.max(160, app.screen.width - insetRight),
    height: app.screen.height,
  });

  const centerOn = (
    worldPx: { x: number; y: number },
    targetZoom: number,
    animate: boolean,
  ): void => {
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, targetZoom));
    camera.scale.set(zoom);
    const view = viewport();
    const x = Math.round(view.width / 2 - worldPx.x * zoom);
    const y = Math.round(view.height / 2 - worldPx.y * zoom);
    if (animate) {
      tweenCamera(x, y);
    } else {
      camera.x = x;
      camera.y = y;
    }
    emitCamera();
  };

  /**
   * The largest integer zoom at which the world's width fits and its height nearly does. When no
   * zoom of two or more manages that, two is taken anyway with the top of the world anchored,
   * because a readable world that needs a scroll beats a whole one nobody can make out.
   */
  const fittingZoom = (widthPx: number, heightPx: number): number => {
    const view = viewport();
    for (let candidate = 3; candidate >= 2; candidate -= 1) {
      if (widthPx * candidate <= view.width && heightPx * candidate <= view.height * 1.15) {
        return candidate;
      }
    }
    return widthPx * 2 <= view.width ? 2 : MIN_ZOOM;
  };

  const fit = (): void => {
    if (world === null) return;
    const widthPx = world.size.w * TILE;
    const heightPx = world.size.h * TILE;
    const fitted = fittingZoom(widthPx, heightPx);
    const view = viewport();
    // Anchor the top of the world near the top of the view when the world is taller than the view.
    const centerY = heightPx * fitted > view.height ? view.height / 2 / fitted : heightPx / 2;
    centerOn({ x: widthPx / 2, y: centerY }, fitted, false);
  };

  // --- Ground: rebuilt only when the layout changes -----------------------------------------------

  const buildGround = (next: World): void => {
    ground.removeChildren().forEach((child) => child.destroy({ children: true }));
    plots.clear();
    houseGlows.clear();
    const grass = tiling(tiles.grass(), { x: 0, y: 0, w: next.size.w, h: next.size.h });
    ground.addChild(grass);
    const square = next.square;
    ground.addChild(tiling(tiles.path(), square.rect));
    const building = (texture: Texture, rect: Rect, kind: Building): void => {
      const sprite = new Sprite({ texture });
      sprite.x = rect.x * TILE;
      sprite.y = rect.y * TILE;
      sprite.eventMode = "static";
      sprite.cursor = "pointer";
      sprite.on("pointertap", () => callbacks.onClickBuilding(kind));
      ground.addChild(sprite);
    };
    building(tiles.frontDesk(), square.frontDesk, "frontDesk");
    building(tiles.townHall(), square.townHall, "townHall");
    building(tiles.library(), square.library, "library");
    const mailbox = new Sprite({ texture: propTexture("mailbox") });
    mailbox.x = square.mailbox.x * TILE;
    mailbox.y = square.mailbox.y * TILE;
    mailbox.eventMode = "static";
    mailbox.cursor = "pointer";
    mailbox.on("pointertap", () => callbacks.onClickBuilding("mailbox"));
    ground.addChild(mailbox);
    mailFlag = new Sprite({ texture: propTexture("flag") });
    mailFlag.x = mailbox.x;
    mailFlag.y = mailbox.y;
    mailFlag.visible = false;
    ground.addChild(mailFlag);
    const clock = new Sprite({ texture: propTexture("clock") });
    clock.x = square.clock.x * TILE;
    clock.y = square.clock.y * TILE;
    clock.eventMode = "static";
    clock.cursor = "pointer";
    clock.on("pointertap", () => callbacks.onClickBuilding("clock"));
    ground.addChild(clock);
    const bench = new Sprite({ texture: propTexture("bench") });
    bench.x = (square.bench.x - 1) * TILE;
    bench.y = square.bench.y * TILE;
    ground.addChild(bench);

    for (const house of next.houses) {
      const sprite = new Sprite({ texture: tiles.house() });
      sprite.x = house.rect.x * TILE;
      sprite.y = house.rect.y * TILE;
      ground.addChild(sprite);
      const glow = new Sprite({ texture: propTexture("glow"), anchor: 0.5, blendMode: "add" });
      glow.alpha = 0.3;
      glow.scale.set(3);
      glow.x = sprite.x + (house.rect.w * TILE) / 2;
      glow.y = sprite.y + (house.rect.h * TILE) / 2;
      glow.visible = false;
      ground.addChild(glow);
      houseGlows.set(house.agent, glow);
    }
    for (const memorial of next.memorials) {
      const stone = new Sprite({ texture: propTexture("stone") });
      stone.x = memorial.at.x * TILE;
      stone.y = memorial.at.y * TILE;
      ground.addChild(stone);
    }

    for (const plot of next.plots) {
      const { rect } = plot;
      ground.addChild(tiling(tiles.soil(), { x: rect.x, y: rect.y + 1, w: rect.w, h: rect.h - 1 }));
      ground.addChild(tiling(tiles.fenceH(), { x: rect.x, y: rect.y, w: rect.w, h: 1 }));
      ground.addChild(
        tiling(tiles.fenceH(), { x: rect.x, y: rect.y + rect.h - 1, w: rect.w, h: 1 }),
      );
      ground.addChild(tiling(tiles.fenceV(), { x: rect.x, y: rect.y, w: 1, h: rect.h }));
      ground.addChild(
        tiling(tiles.fenceV(), { x: rect.x + rect.w - 1, y: rect.y, w: 1, h: rect.h }),
      );
      const gate = tiling(tiles.path(), { x: plot.gate.x - 1, y: plot.gate.y - 1, w: 2, h: 2 });
      ground.addChild(gate);
      const sign = new Sprite({ texture: propTexture("sign") });
      sign.x = plot.sign.x * TILE;
      sign.y = plot.sign.y * TILE - 6;
      ground.addChild(sign);
      const barn = new Sprite({ texture: tiles.barn() });
      barn.x = plot.barn.x * TILE;
      barn.y = plot.barn.y * TILE;
      ground.addChild(barn);
      const hit = new Container();
      hit.hitArea = new Rectangle(rect.x * TILE, rect.y * TILE, rect.w * TILE, rect.h * TILE);
      hit.eventMode = "static";
      hit.cursor = "pointer";
      hit.on("pointertap", () => callbacks.onClickPlot(plot.slug));
      hit.on("pointerover", () => callbacks.onHoverPlot(plot.slug));
      hit.on("pointerout", () => callbacks.onHoverPlot(null));
      ground.addChild(hit);
      plots.set(plot.slug, {
        hit,
        crops: new Map(),
        marks: new Map(),
        weather: new Map(),
        flagless: null,
      });
    }
    night.clear();
    night.rect(0, 0, next.size.w * TILE, next.size.h * TILE).fill(0x0b1030);
    night.alpha = 0.5;
    night.eventMode = "none";
    highlight.eventMode = "none";
  };

  // --- Objects and citizens: diffed on every apply ---------------------------------------------------

  const syncPlot = (plot: Plot): void => {
    const view = plots.get(plot.slug);
    if (view === undefined) return;
    const seen = new Set<string>();
    for (const crop of plot.crops) {
      seen.add(crop.taskId);
      let sprite = view.crops.get(crop.taskId);
      if (sprite === undefined) {
        const created = new Sprite({ texture: cropTexture(crop.stage, crop.wilted) });
        created.eventMode = "static";
        created.cursor = "pointer";
        created.on("pointerdown", (event: FederatedPointerEvent) =>
          beginDrag(event, { kind: "crop", taskId: crop.taskId, slug: plot.slug, sprite: created }),
        );
        actors.addChild(created);
        view.crops.set(crop.taskId, created);
        sprite = created;
      }
      sprite.texture = cropTexture(crop.stage, crop.wilted);
      sprite.x = crop.at.x * TILE;
      sprite.y = crop.at.y * TILE;
      sprite.zIndex = sprite.y + TILE - 1;
      let mark = view.marks.get(crop.taskId);
      if (crop.marked && mark === undefined) {
        mark = new Sprite({ texture: propTexture("mark") });
        actors.addChild(mark);
        view.marks.set(crop.taskId, mark);
      }
      if (mark !== undefined) {
        mark.visible = crop.marked;
        mark.x = sprite.x;
        mark.y = sprite.y - TILE;
        mark.zIndex = sprite.zIndex + 1;
      }
    }
    for (const [taskId, sprite] of view.crops) {
      if (!seen.has(taskId)) {
        sprite.destroy();
        view.crops.delete(taskId);
        view.marks.get(taskId)?.destroy();
        view.marks.delete(taskId);
      }
    }
    const weatherSeen = new Set<string>();
    for (const weather of plot.weather) {
      weatherSeen.add(weather.key);
      let sprite = view.weather.get(weather.key);
      if (sprite === undefined) {
        sprite = new Sprite({ texture: weatherTexture(weather.kind) });
        sprite.eventMode = "none";
        actors.addChild(sprite);
        view.weather.set(weather.key, sprite);
      }
      sprite.x = weather.at.x * TILE;
      sprite.y = weather.at.y * TILE - (weather.kind === "cloud" ? TILE : 0);
      sprite.zIndex = 100_000;
    }
    for (const [key, sprite] of view.weather) {
      if (!weatherSeen.has(key)) {
        sprite.destroy();
        view.weather.delete(key);
      }
    }
  };

  const moveActor = (actor: CitizenActor, to: Point, animate: boolean): void => {
    const dest = px(to);
    dest.x += TILE / 2;
    dest.y += TILE;
    actor.target = dest;
    for (let index = tweens.length - 1; index >= 0; index -= 1) {
      if (tweens[index]?.target === actor.root.position) tweens.splice(index, 1);
    }
    const distance = Math.hypot(dest.x - actor.root.x, dest.y - actor.root.y);
    if (!animate || reducedMotion || distance < 1) {
      actor.root.x = dest.x;
      actor.root.y = dest.y;
      return;
    }
    actor.sprite.scale.x = dest.x < actor.root.x ? -1 : 1;
    tweens.push({
      target: actor.root.position,
      from: { x: actor.root.x, y: actor.root.y },
      to: dest,
      duration: (distance / (WALK_TILES_PER_SECOND * TILE)) * 1000,
      elapsed: 0,
    });
  };

  const syncCitizens = (next: World): void => {
    const seen = new Set<string>();
    for (const citizen of next.citizens) {
      seen.add(citizen.name);
      let actor = citizens.get(citizen.name);
      const fresh = actor === undefined;
      if (actor === undefined) {
        actor = new CitizenActor(citizen);
        const created = actor;
        created.root.on("pointerover", () => callbacks.onHoverCitizen(citizen.name));
        created.root.on("pointerout", () => callbacks.onHoverCitizen(null));
        created.root.on("pointerdown", (event: FederatedPointerEvent) =>
          beginDrag(event, { kind: "citizen", name: citizen.name, actor: created }),
        );
        actors.addChild(created.root);
        citizens.set(citizen.name, created);
      }
      actor.where = citizen.where;
      actor.setState(citizen.state, citizen.role, citizen.cli);
      actor.glow.visible = citizen.lamp;
      if (dragging?.kind !== "citizen" || dragging.name !== citizen.name) {
        moveActor(actor, citizen.at, !fresh);
      }
    }
    for (const [name, actor] of citizens) {
      if (!seen.has(name)) {
        actor.root.destroy({ children: true });
        citizens.delete(name);
      }
    }
  };

  // --- Dragging: a citizen onto a plot, a crop onto a citizen; the stage pans otherwise ------------

  type Drag =
    | {
        kind: "citizen";
        name: string;
        actor: CitizenActor;
        start: { x: number; y: number };
        moved: boolean;
        origin: { x: number; y: number };
      }
    | {
        kind: "crop";
        taskId: string;
        slug: string;
        sprite: Sprite;
        start: { x: number; y: number };
        moved: boolean;
        origin: { x: number; y: number };
      }
    | {
        kind: "pan";
        start: { x: number; y: number };
        origin: { x: number; y: number };
        moved: boolean;
      };
  let dragging: Drag | null = null;

  const beginDrag = (
    event: FederatedPointerEvent,
    what:
      | { kind: "citizen"; name: string; actor: CitizenActor }
      | { kind: "crop"; taskId: string; slug: string; sprite: Sprite },
  ): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const start = { x: event.global.x, y: event.global.y };
    dragging =
      what.kind === "citizen"
        ? { ...what, start, moved: false, origin: { x: what.actor.root.x, y: what.actor.root.y } }
        : { ...what, start, moved: false, origin: { x: what.sprite.x, y: what.sprite.y } };
  };

  const worldTileAt = (global: { x: number; y: number }): Point => ({
    x: Math.floor((global.x - camera.x) / zoom / TILE),
    y: Math.floor((global.y - camera.y) / zoom / TILE),
  });

  const plotAt = (tile: Point): string | null => {
    if (world === null) return null;
    return world.plots.find((plot) => contains(plot.rect, tile))?.slug ?? null;
  };

  const citizenAt = (tile: Point): string | null => {
    if (world === null) return null;
    let best: { name: string; distance: number } | null = null;
    for (const citizen of world.citizens) {
      const distance = Math.hypot(citizen.at.x - tile.x, citizen.at.y - tile.y);
      if (distance <= 1.5 && (best === null || distance < best.distance)) {
        best = { name: citizen.name, distance };
      }
    }
    return best?.name ?? null;
  };

  app.stage.on("pointerdown", (event: FederatedPointerEvent) => {
    if (event.button !== 0 || dragging !== null || event.target !== app.stage) return;
    dragging = {
      kind: "pan",
      start: { x: event.global.x, y: event.global.y },
      origin: { x: camera.x, y: camera.y },
      moved: false,
    };
  });

  app.stage.on("globalpointermove", (event: FederatedPointerEvent) => {
    if (dragging === null) return;
    const dx = event.global.x - dragging.start.x;
    const dy = event.global.y - dragging.start.y;
    if (!dragging.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    dragging.moved = true;
    switch (dragging.kind) {
      case "pan":
        camera.x = Math.round(dragging.origin.x + dx);
        camera.y = Math.round(dragging.origin.y + dy);
        emitCamera();
        return;
      case "citizen":
        dragging.actor.root.x = dragging.origin.x + dx / zoom;
        dragging.actor.root.y = dragging.origin.y + dy / zoom;
        dragging.actor.root.zIndex = 200_000;
        return;
      case "crop":
        dragging.sprite.x = dragging.origin.x + dx / zoom;
        dragging.sprite.y = dragging.origin.y + dy / zoom;
        dragging.sprite.zIndex = 200_000;
        return;
      default:
        return;
    }
  });

  const endDrag = (event: FederatedPointerEvent): void => {
    if (dragging === null) return;
    const drag = dragging;
    dragging = null;
    const tile = worldTileAt(event.global);
    switch (drag.kind) {
      case "pan":
        return;
      case "citizen": {
        if (!drag.moved) {
          callbacks.onClickCitizen(drag.name);
          return;
        }
        const target = plotAt(tile);
        const current = world?.citizens.find((citizen) => citizen.name === drag.name);
        moveActor(drag.actor, current?.at ?? { x: 0, y: 0 }, true);
        callbacks.onDropCitizen(drag.name, drag.actor.where, target);
        return;
      }
      case "crop": {
        drag.sprite.x = drag.origin.x;
        drag.sprite.y = drag.origin.y;
        drag.sprite.zIndex = drag.origin.y + TILE - 1;
        if (!drag.moved) {
          callbacks.onClickCrop(drag.taskId, drag.slug);
          return;
        }
        const citizen = citizenAt(tile);
        if (citizen !== null) callbacks.onDropCrop(drag.taskId, drag.slug, citizen);
        return;
      }
      default:
        return;
    }
  };
  app.stage.on("pointerup", endDrag);
  app.stage.on("pointerupoutside", endDrag);

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = app.canvas.getBoundingClientRect();
    setZoom(zoom + (event.deltaY < 0 ? 1 : -1), {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };
  app.canvas.addEventListener("wheel", onWheel, { passive: false });

  // --- The clock -------------------------------------------------------------------------------------

  // Animations run on the wall clock, not on frame deltas: a slow machine drops frames, it does
  // not stretch a walk. The frame rate is capped so a software renderer leaves the page responsive.
  app.ticker.maxFPS = 30;
  let lastTick = performance.now();
  app.ticker.add(() => {
    const now = performance.now();
    const delta = Math.min(1_000, now - lastTick);
    lastTick = now;
    for (let index = tweens.length - 1; index >= 0; index -= 1) {
      const tween = tweens[index];
      if (tween === undefined) continue;
      tween.elapsed += delta;
      const t = Math.min(1, tween.elapsed / Math.max(1, tween.duration));
      const k = ease(t);
      tween.target.x = tween.from.x + (tween.to.x - tween.from.x) * k;
      tween.target.y = tween.from.y + (tween.to.y - tween.from.y) * k;
      if (t >= 1) {
        tween.target.x = tween.to.x;
        tween.target.y = tween.to.y;
        tweens.splice(index, 1);
        tween.onDone?.();
      }
    }
    for (const actor of citizens.values()) {
      actor.tick(delta);
    }
    for (const view of plots.values()) {
      for (const sprite of view.weather.values()) {
        sprite.y += Math.sin(performance.now() / 700 + sprite.x) * 0.05;
      }
    }
  });

  const drawHighlight = (target: Focus): void => {
    highlight.clear();
    if (target === null || world === null) return;
    let rect: Rect | null = null;
    if (target.kind === "plot") {
      rect = world.plots.find((plot) => plot.slug === target.slug)?.rect ?? null;
    } else if (target.kind === "citizen") {
      const citizen = world.citizens.find((entry) => entry.name === target.name);
      rect = citizen === undefined ? null : { x: citizen.at.x, y: citizen.at.y - 1, w: 1, h: 2 };
    } else {
      const square = world.square;
      rect =
        target.building === "mailbox"
          ? { x: square.mailbox.x, y: square.mailbox.y, w: 1, h: 1 }
          : target.building === "clock"
            ? { x: square.clock.x, y: square.clock.y, w: 1, h: 1 }
            : square[target.building];
    }
    if (rect === null) return;
    highlight
      .rect(rect.x * TILE - 2, rect.y * TILE - 2, rect.w * TILE + 4, rect.h * TILE + 4)
      .stroke({ color: 0x7aa2f7, width: 2, alpha: 0.9 });
  };

  const scene: WorldScene = {
    apply(next) {
      if (destroyed) return;
      const first = world === null;
      world = next;
      const key = layoutKey(next);
      if (key !== currentLayout) {
        currentLayout = key;
        buildGround(next);
        for (const actor of citizens.values()) actor.root.destroy({ children: true });
        citizens.clear();
      }
      for (const plot of next.plots) syncPlot(plot);
      syncCitizens(next);
      for (const house of next.houses) {
        const glow = houseGlows.get(house.agent);
        if (glow !== undefined) glow.visible = house.lamp;
      }
      if (mailFlag !== null) mailFlag.visible = next.mailbox.flag;
      night.visible = next.night;
      if (first) {
        if (requestedFocus === null) fit();
        else scene.focus(requestedFocus, false);
      }
    },
    focus(target, animate = true) {
      requestedFocus = target;
      drawHighlight(target);
      if (target === null || world === null) return;
      if (target.kind === "plot") {
        const plot = world.plots.find((entry) => entry.slug === target.slug);
        if (plot === undefined) return;
        const view = viewport();
        const fitted = Math.floor(
          Math.min(
            view.width / ((plot.rect.w + 4) * TILE),
            view.height / ((plot.rect.h + 4) * TILE),
          ),
        );
        centerOn(
          { x: (plot.rect.x + plot.rect.w / 2) * TILE, y: (plot.rect.y + plot.rect.h / 2) * TILE },
          Math.max(2, Math.min(MAX_ZOOM, fitted)),
          animate,
        );
      } else if (target.kind === "citizen") {
        const citizen = world.citizens.find((entry) => entry.name === target.name);
        if (citizen === undefined) return;
        centerOn(
          { x: (citizen.at.x + 0.5) * TILE, y: citizen.at.y * TILE },
          Math.max(zoom, 3),
          animate,
        );
      } else {
        const square = world.square;
        centerOn(
          {
            x: (square.rect.x + square.rect.w / 2) * TILE,
            y: (square.rect.y + square.rect.h / 2) * TILE,
          },
          Math.max(zoom, 2),
          animate,
        );
      }
    },
    fit,
    panBy(dx, dy) {
      camera.x = Math.round(camera.x + dx);
      camera.y = Math.round(camera.y + dy);
      emitCamera();
    },
    zoomBy(step) {
      setZoom(zoom + step);
    },
    toScreen(point) {
      return { x: camera.x + point.x * TILE * zoom, y: camera.y + point.y * TILE * zoom };
    },
    setReducedMotion(reduced) {
      reducedMotion = reduced;
    },
    setInset(right) {
      insetRight = Math.max(0, right);
    },
    destroy() {
      destroyed = true;
      app.canvas.removeEventListener("wheel", onWheel);
      app.destroy(true, { children: true });
    },
  };
  return scene;
}
