import type { CliKind } from "@stellaris/shared";
import { CLI_MARKS } from "../lib/marks.js";
import type { Anchor, SkyModel, Star } from "./model.js";

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface SceneOptions {
  readonly reducedMotion: boolean;
  /** Called every frame with the hovered star's screen position, or null when none is drawn. */
  readonly onHoverPosition: (point: ScreenPoint | null) => void;
}

/** A star as the scene animates it: eased toward its place, fading in and out. */
interface Body {
  star: Star;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Offsets the citizen's drift and breathing so no two stars move in step. */
  phase: number;
  /** 0 to 1: fades in when the citizen appears and out when it leaves the sky. */
  presence: number;
  leaving: boolean;
  screen: ScreenPoint;
}

/** A sphere as the scene draws it: eased toward its anchor's place and size, like the stars. */
interface Sphere {
  anchor: Anchor;
  x: number;
  y: number;
  radius: number;
}

interface Speck {
  x: number;
  y: number;
  size: number;
  alpha: number;
  rate: number;
  phase: number;
}

// Mirrors of the theme tokens in styles.css, as the canvas cannot read Tailwind classes.
const SURFACE_0 = "#0a0a0a";
const SURFACE_1 = "#171717";
const FG_SECONDARY = "212, 212, 212";
const FG_TERTIARY = "163, 163, 163";
const FG_MUTED = "115, 115, 115";
const LABEL_FAMILY = '"Instrument Sans Variable", ui-sans-serif, sans-serif';
const ANCHOR_FONT = '500 12px "Onest Variable", ui-sans-serif, sans-serif';
const SOCIETY_FONT = '600 10px "Onest Variable", ui-sans-serif, sans-serif';

const CORE_RADIUS = 15;
const SPRING = 5;
const DAMPING = 4.2;
const SPECKS = 280;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function phaseOf(name: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < name.length; i += 1) {
    hash = Math.imul(hash ^ name.charCodeAt(i), 16_777_619);
  }
  return ((hash >>> 0) / 4_294_967_296) * Math.PI * 2;
}

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

/** A soft round glow in one color, drawn once and stamped under every star of that color. */
function glowSprite(color: string): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    const channels = rgb(color);
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, `rgba(${channels}, 0.55)`);
    gradient.addColorStop(0.22, `rgba(${channels}, 0.2)`);
    gradient.addColorStop(0.55, `rgba(${channels}, 0.05)`);
    gradient.addColorStop(1, `rgba(${channels}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return canvas;
}

/**
 * The night sky, drawn imperatively on a 2D canvas. The scene never decides where anything is:
 * `setModel` hands it the targets from `skyModel`, and every frame eases each body toward its
 * target while it drifts and breathes, so animation frames and React renders stay separate clocks.
 */
export class SkyScene {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly glyphs: Record<CliKind, Path2D>;
  private readonly glows = new Map<string, HTMLCanvasElement>();
  private readonly bodies = new Map<string, Body>();
  private readonly specks: Speck[];
  private readonly spheres = new Map<string, Sphere>();
  private radius = 400;
  private scale = 1;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private hovered: string | null = null;
  private focus: string | null = null;
  private paused = false;
  /** Screen space the islands cover at the left and right; the sky fits the gap between. */
  private insetLeft = 0;
  private insetRight = 0;
  private centerX = 0;
  private frameId: number | null = null;
  private last = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: SceneOptions,
  ) {
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("the sky needs a 2D canvas context");
    }
    this.ctx = ctx;
    this.glyphs = {
      claude: new Path2D(CLI_MARKS.claude.path),
      codex: new Path2D(CLI_MARKS.codex.path),
    };
    const random = mulberry32(7);
    this.specks = Array.from({ length: SPECKS }, () => ({
      x: random(),
      y: random(),
      size: 0.5 + random() * 1.1,
      alpha: 0.12 + random() * 0.45,
      rate: 0.2 + random() * 0.8,
      phase: random() * Math.PI * 2,
    }));
  }

  setModel(model: SkyModel): void {
    this.radius = model.radius;
    for (const anchor of model.anchors) {
      const sphere = this.spheres.get(anchor.id);
      if (sphere === undefined) {
        this.spheres.set(anchor.id, { anchor, x: anchor.x, y: anchor.y, radius: anchor.radius });
      } else {
        sphere.anchor = anchor;
      }
    }
    for (const id of this.spheres.keys()) {
      if (!model.anchors.some((anchor) => anchor.id === id)) {
        this.spheres.delete(id);
      }
    }

    // A citizen's stars are one body of light: a star that leaves hands its body to the star
    // that replaces it, a second turn splits off from the first, and a turn that ends while
    // another goes on merges back into it. Only a citizen new to the sky rises from its anchor.
    const present = new Set(model.stars.map((star) => star.id));
    const departing = [...this.bodies.entries()].filter(([id]) => !present.has(id));
    for (const star of model.stars) {
      const body = this.bodies.get(star.id);
      if (body !== undefined) {
        body.star = star;
        body.leaving = false;
        continue;
      }
      const handed = departing.findIndex(([, other]) => other.star.name === star.name);
      const donor = departing[handed];
      if (donor !== undefined) {
        departing.splice(handed, 1);
        this.bodies.delete(donor[0]);
        this.bodies.set(star.id, { ...donor[1], star, leaving: false });
        continue;
      }
      const sibling = [...this.bodies.values()].find(
        (other) => other.star.name === star.name && present.has(other.star.id),
      );
      const anchor = model.anchors.find((candidate) => candidate.id === star.anchor);
      const from = sibling ?? anchor ?? star;
      this.bodies.set(star.id, {
        star,
        x: this.options.reducedMotion ? star.x : from.x,
        y: this.options.reducedMotion ? star.y : from.y,
        vx: 0,
        vy: 0,
        phase: phaseOf(star.name),
        presence: this.options.reducedMotion ? 1 : 0,
        leaving: false,
        screen: { x: 0, y: 0 },
      });
    }
    for (const [, body] of departing) {
      const into = model.stars.find((star) => star.name === body.star.name);
      body.leaving = true;
      if (into !== undefined) {
        body.star = { ...body.star, x: into.x, y: into.y };
      }
    }
  }

  /** The star to light up and follow with the card, by its id. */
  setHovered(id: string | null): void {
    this.hovered = id;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** The sphere of the project the board has open, drawn brighter. */
  setFocus(anchor: string | null): void {
    this.focus = anchor;
  }

  setInsets(left: number, right: number): void {
    this.insetLeft = left;
    this.insetRight = right;
  }

  /** The sphere under a point in CSS pixels, when no star is. */
  hitTestAnchor(x: number, y: number): string | null {
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const sphere of this.spheres.values()) {
      const at = this.toScreen(sphere.x, sphere.y);
      const distance = Math.hypot(at.x - x, at.y - y);
      if (distance <= sphere.radius * this.scale && distance < bestDistance) {
        best = sphere.anchor.id;
        bestDistance = distance;
      }
    }
    return best;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
  }

  /** The id of the star under a point in CSS pixels, if any. */
  hitTest(x: number, y: number): string | null {
    let best: string | null = null;
    let bestDistance = Math.max(CORE_RADIUS * this.scale + 8, 18);
    for (const [id, body] of this.bodies) {
      if (body.leaving) {
        continue;
      }
      const distance = Math.hypot(body.screen.x - x, body.screen.y - y);
      if (distance < bestDistance) {
        best = id;
        bestDistance = distance;
      }
    }
    return best;
  }

  start(): void {
    if (this.frameId === null) {
      this.last = performance.now() / 1000;
      this.frameId = requestAnimationFrame(this.frame);
    }
  }

  stop(): void {
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
  }

  private readonly frame = (now: number): void => {
    const t = now / 1000;
    const dt = Math.min(0.05, Math.max(0, t - this.last));
    this.last = t;
    this.step(dt);
    this.draw(this.options.reducedMotion ? 0 : t);
    this.frameId = requestAnimationFrame(this.frame);
  };

  private step(dt: number): void {
    const free = Math.max(240, this.width - this.insetLeft - this.insetRight);
    const fit = Math.min(free, this.height) / (2 * this.radius);
    const target = Math.min(1.35, Math.max(0.45, fit));
    const ease = this.options.reducedMotion ? 1 : Math.min(1, dt * 3);
    this.scale += (target - this.scale) * ease;
    // The first frame places the center; after that it glides as the islands open and close.
    const center = this.insetLeft + free / 2;
    this.centerX = this.centerX === 0 ? center : this.centerX + (center - this.centerX) * ease;
    for (const sphere of this.spheres.values()) {
      sphere.x += (sphere.anchor.x - sphere.x) * ease;
      sphere.y += (sphere.anchor.y - sphere.y) * ease;
      sphere.radius += (sphere.anchor.radius - sphere.radius) * ease;
    }
    for (const [id, body] of this.bodies) {
      if (this.options.reducedMotion) {
        body.x = body.star.x;
        body.y = body.star.y;
        body.presence = body.leaving ? 0 : 1;
      } else {
        // A damped spring: citizens glide to a new place and settle without snapping.
        body.vx += (SPRING * (body.star.x - body.x) - DAMPING * body.vx) * dt;
        body.vy += (SPRING * (body.star.y - body.y) - DAMPING * body.vy) * dt;
        body.x += body.vx * dt;
        body.y += body.vy * dt;
        const toward = body.leaving ? 0 : 1;
        body.presence += (toward - body.presence) * Math.min(1, dt * 2.5);
      }
      if (body.leaving && body.presence < 0.02) {
        this.bodies.delete(id);
      }
    }
  }

  private toScreen(x: number, y: number): ScreenPoint {
    return { x: this.centerX + x * this.scale, y: this.height / 2 + y * this.scale };
  }

  private glow(color: string): HTMLCanvasElement {
    let sprite = this.glows.get(color);
    if (sprite === undefined) {
      sprite = glowSprite(color);
      this.glows.set(color, sprite);
    }
    return sprite;
  }

  private draw(t: number): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = SURFACE_0;
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawSpecks(t);
    this.drawAnchors();
    const order = [...this.bodies.values()].toSorted(
      (a, b) => Number(a.star.id === this.hovered) - Number(b.star.id === this.hovered),
    );
    for (const body of order) {
      this.drawBody(body, t);
    }
    const hovered = this.hovered === null ? undefined : this.bodies.get(this.hovered);
    this.options.onHoverPosition(hovered === undefined || hovered.leaving ? null : hovered.screen);
  }

  private drawSpecks(t: number): void {
    const { ctx } = this;
    for (const speck of this.specks) {
      const twinkle = t === 0 ? 1 : 0.6 + 0.4 * Math.sin(t * speck.rate + speck.phase);
      ctx.fillStyle = `rgba(255, 255, 255, ${(speck.alpha * twinkle * (this.paused ? 0.6 : 1)).toFixed(3)})`;
      ctx.fillRect(speck.x * this.width, speck.y * this.height, speck.size, speck.size);
    }
    // A faint core of light behind the society, so the center reads as the heart of the sky.
    const center = this.toScreen(0, 0);
    const core = ctx.createRadialGradient(
      center.x,
      center.y,
      0,
      center.x,
      center.y,
      320 * this.scale,
    );
    core.addColorStop(0, "rgba(255, 255, 255, 0.035)");
    core.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  private drawAnchors(): void {
    const { ctx } = this;
    const center = this.toScreen(0, 0);
    ctx.save();
    ctx.setLineDash([2, 7]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
    for (const sphere of this.spheres.values()) {
      if (sphere.anchor.kind === "project") {
        const at = this.toScreen(sphere.x, sphere.y);
        ctx.beginPath();
        ctx.moveTo(center.x, center.y);
        ctx.lineTo(at.x, at.y);
        ctx.stroke();
      }
    }
    ctx.restore();

    for (const { anchor, x, y, radius } of this.spheres.values()) {
      const at = this.toScreen(x, y);
      const ring = radius * this.scale;
      const focused = anchor.id === this.focus;
      if (anchor.kind === "project") {
        const nebula = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, ring * 1.8);
        nebula.addColorStop(0, `rgba(160, 170, 255, ${focused ? 0.1 : 0.05})`);
        nebula.addColorStop(1, "rgba(160, 170, 255, 0)");
        ctx.fillStyle = nebula;
        ctx.fillRect(at.x - ring * 1.8, at.y - ring * 1.8, ring * 3.6, ring * 3.6);
      }
      ctx.beginPath();
      ctx.arc(at.x, at.y, ring, 0, Math.PI * 2);
      ctx.lineWidth = focused ? 1.5 : 1;
      ctx.strokeStyle = focused
        ? "rgba(255, 255, 255, 0.28)"
        : anchor.kind === "society"
          ? "rgba(255, 255, 255, 0.09)"
          : "rgba(255, 255, 255, 0.06)";
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      if (anchor.kind === "society") {
        ctx.font = SOCIETY_FONT;
        ctx.letterSpacing = "2px";
        ctx.fillStyle = `rgba(${FG_MUTED}, 0.9)`;
        ctx.fillText(anchor.label.toUpperCase(), at.x, at.y + ring + 10);
        ctx.letterSpacing = "0px";
      } else {
        ctx.font = ANCHOR_FONT;
        ctx.fillStyle = focused ? "rgba(245, 245, 245, 1)" : `rgba(${FG_TERTIARY}, 0.95)`;
        ctx.fillText(anchor.label, at.x, at.y + ring + 10);
      }
    }
  }

  private drawBody(body: Body, t: number): void {
    const { ctx } = this;
    const { star } = body;
    const mark = CLI_MARKS[star.cli];
    const hovered = star.id === this.hovered;
    const working = star.state === "working";
    const amplitude = working ? 2.5 : 5;
    const driftX =
      amplitude * (Math.sin(t * 0.29 + body.phase) + 0.6 * Math.sin(t * 0.17 + body.phase * 2.1));
    const driftY =
      amplitude * (Math.cos(t * 0.23 + body.phase * 1.3) + 0.6 * Math.cos(t * 0.11 + body.phase));
    const at = this.toScreen(body.x + driftX, body.y + driftY);
    body.screen = at;

    const rate = working ? 2.4 : star.state === "queued" ? 1.4 : 0.7;
    const breath = t === 0 ? 0.5 : 0.5 + 0.5 * Math.sin(t * rate + body.phase);
    const base = working
      ? 0.95 + 0.35 * breath
      : star.state === "queued"
        ? 0.7 + 0.2 * breath
        : 0.5 + 0.2 * breath;
    const intensity = (base + (hovered ? 0.25 : 0)) * body.presence * (this.paused ? 0.7 : 1);
    const radius = Math.max(10, CORE_RADIUS * this.scale);

    const glowSize = (working ? 170 : 130) * this.scale * (0.9 + 0.15 * breath);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, intensity);
    ctx.drawImage(
      this.glow(mark.accent),
      at.x - glowSize / 2,
      at.y - glowSize / 2,
      glowSize,
      glowSize,
    );
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = body.presence;
    const accent = rgb(mark.accent);
    if (working && t !== 0) {
      // A ripple leaves the star every 1.8 seconds while its turn runs.
      const progress = ((t + body.phase) % 1.8) / 1.8;
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius + (6 + 30 * progress) * this.scale, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${accent}, ${(0.4 * (1 - progress)).toFixed(3)})`;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
    if (star.resident) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius + 5 * this.scale, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${accent}, 0.3)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (star.state === "queued") {
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius + 8 * this.scale, 0, Math.PI * 2);
      ctx.setLineDash([3, 4]);
      ctx.lineDashOffset = -t * 8;
      ctx.strokeStyle = `rgba(${FG_SECONDARY}, 0.55)`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = SURFACE_1;
    ctx.fill();
    ctx.strokeStyle = `rgba(${accent}, ${hovered ? 0.95 : 0.6})`;
    ctx.lineWidth = hovered ? 1.75 : 1.25;
    ctx.stroke();

    ctx.save();
    const glyph = (radius * 1.2) / 24;
    ctx.translate(at.x, at.y);
    ctx.scale(glyph, glyph);
    ctx.translate(-12, -12);
    ctx.fillStyle = mark.fill;
    ctx.fill(this.glyphs[star.cli], "evenodd");
    ctx.restore();

    if (working) {
      // Three sparks orbit a working star.
      for (let i = 0; i < 3; i += 1) {
        const angle = t * 1.8 + (i * Math.PI * 2) / 3 + body.phase;
        const orbit = radius + 9 * this.scale;
        ctx.beginPath();
        ctx.arc(
          at.x + orbit * Math.cos(angle),
          at.y + orbit * Math.sin(angle),
          1.6,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = `rgba(${accent}, 0.9)`;
        ctx.fill();
      }
    }

    // Names shrink with the sky, down to a floor, so they keep clear of neighbouring stars.
    ctx.font = `500 ${Math.max(9, Math.min(11, 11 * this.scale)).toFixed(1)}px ${LABEL_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = `rgba(${FG_SECONDARY}, ${hovered || working ? 1 : 0.7})`;
    ctx.fillText(star.name, at.x, at.y + radius + 8 * this.scale + 3);
    ctx.restore();
  }
}
