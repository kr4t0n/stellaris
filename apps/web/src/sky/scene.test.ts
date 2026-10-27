import { TaskFrontmatterSchema, type Member, type Project, type Task } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SchedulerView } from "../lib/api.js";
import { tableText } from "./ios-tables.js";
import { skyModel, type SkyModel, type SkySnapshot } from "./model.js";
import { SkyScene } from "./scene.js";

/**
 * The scene's motion, and where its frames put what they draw, for BoardKit's port. The real
 * `SkyScene` runs here on a canvas that only records: each sequence sets models and calls the
 * scene's methods between frames on a fixed clock, and the samples read back its bodies, marks,
 * spheres, lines, and camera, with the specks and the citizens' names as it drew them. The table
 * goes to `apps/ios/fixtures/sky/scene.json`, which BoardKit's `SkyScene` replays.
 */

const ts = "2026-09-29T10:00:00.000Z";

function member(name: string, memberships: string[], cli: "claude" | "codex" = "claude"): Member {
  return {
    name,
    role: "engineer",
    cli,
    homeRunner: "server",
    status: "active",
    resident: false,
    skills: [],
    memberships,
    subscriptions: [],
    claimsHeld: 0,
    tasksDone: 0,
    createdAt: ts,
    profile: "",
  };
}

function project(slug: string, createdAt: string): Project {
  return {
    slug,
    name: slug.toUpperCase(),
    repo: null,
    defaultBranch: "main",
    channels: ["general"],
    archivedChannels: [],
    members: [],
    approvers: ["user"],
    requiredCapabilities: [],
    createdAt,
    onDone: "none",
  };
}

function task(id: string, claimedBy?: string): Task {
  return {
    ...TaskFrontmatterSchema.parse({
      id,
      project: "lab",
      title: `task ${id.slice(-1)}`,
      status: claimedBy === undefined ? "open" : "claimed",
      createdBy: "desk",
      createdAt: ts,
      updatedAt: ts,
      blockedBy: [],
      requiredCapabilities: [],
      stages: [{ id: "s1", name: "Work", role: "engineer" }],
      stage: "s1",
      stageSince: ts,
      stageSeq: 1,
      ...(claimedBy === undefined ? {} : { claimedBy }),
    }),
    body: "",
  };
}

function scheduler(running: string[] = [], pending: string[] = [], resident: string[] = []) {
  const view: SchedulerView = { paused: false, running, pending, resident, signals: [], turns: [] };
  return view;
}

const people = [
  member("ada", ["lab"]),
  member("bo", ["lab"], "codex"),
  member("cy", ["web"]),
  member("stew", []),
];
const places = [project("lab", ts), project("web", "2026-09-29T11:00:00.000Z")];
const T1 = "01M3Q2BBBBBBBBBBBBBBBBBBB1";
const T2 = "01M3Q2BBBBBBBBBBBBBBBBBBB2";

function sky(extra: Partial<SkySnapshot>): SkyModel {
  return skyModel({ members: people, projects: places, scheduler: scheduler(), ...extra });
}

/** Everyone at the core. */
const resting = sky({});
/** ada in a turn at lab on the task she holds, bo queued for lab, stew's session warm. */
const working = sky({
  scheduler: scheduler(["ada/lab/x"], ["bo/lab"], ["stew/society"]),
  tasks: [task(T1, "ada"), task(T2)],
});
/** ada in turns at lab and at web at once. */
const split = sky({ scheduler: scheduler(["ada/lab", "ada/web"]), tasks: [task(T1, "ada")] });

/** The models the sequences hand the scene, by the names the table gives them. */
const models: Record<string, SkyModel> = { resting, working, split };

function named(name: string): SkyModel {
  const model = models[name];
  if (model === undefined) {
    throw new Error(`no model named ${name}`);
  }
  return model;
}

/** What happens before a frame, in the order given. */
type Op =
  | { readonly model: string }
  | { readonly view: { width: number; height: number; left: number; right: number } }
  | { readonly flash: string }
  | { readonly say: readonly [string, string] }
  | { readonly zoom: readonly [number, number, number] }
  | { readonly zoomMiddle: number }
  | { readonly pan: readonly [number, number] }
  | { readonly home: true }
  | { readonly focus: string | null }
  | { readonly paused: boolean };

/**
 * Frames: one at `ms` on the scene's clock, in milliseconds as `requestAnimationFrame` hands them,
 * after `ops`; or with `count`, that many a thirtieth of a second apart, every `every`th sampled.
 */
interface Frame {
  readonly ms: number;
  readonly ops?: readonly Op[];
  readonly sample?: true;
  readonly count?: number;
  readonly every?: number;
}

interface Sequence {
  readonly name: string;
  readonly reducedMotion: boolean;
  readonly view: { width: number; height: number; left: number; right: number };
  readonly frames: readonly Frame[];
}

const START = 1_000_000;
const FRAME = 33;

/** `count` frames a thirtieth of a second apart from `from`, every `every`th sampled. */
function run(from: number, count: number, every: number): Frame {
  return { ms: from, count, every };
}

/** Each frame a run stands for, with whether it is sampled. */
function expand(frame: Frame): Frame[] {
  const { count, every } = frame;
  if (count === undefined || every === undefined) {
    return [frame];
  }
  return Array.from({ length: count }, (_, index) => ({
    ms: frame.ms + index * FRAME,
    ...((index + 1) % every === 0 ? { sample: true as const } : {}),
  }));
}

/** A number as the table keeps it, to a ten-millionth: the port compares within a millionth. */
function kept(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

/** Every number in `value` as the table keeps it. */
function rounded<T>(value: T): T {
  return z
    .custom<T>(() => true)
    .parse(
      JSON.parse(JSON.stringify(value), (_key, each: unknown) =>
        typeof each === "number" ? kept(each) : each,
      ),
    );
}

/** One frame at `ms`, after `ops`, sampled. */
function at(ms: number, ...ops: Op[]): Frame {
  return { ms, ops, sample: true };
}

const landscape = { width: 475, height: 669, left: 0, right: 0 };

const sequences: Sequence[] = [
  {
    name: "a citizen rises, goes to a turn, and comes back",
    reducedMotion: false,
    view: landscape,
    frames: [
      at(START, { model: "resting" }),
      run(START + FRAME, 60, 30),
      at(START + 61 * FRAME, { model: "working" }),
      run(START + 62 * FRAME, 90, 30),
      at(START + 152 * FRAME, { model: "resting" }),
      run(START + 153 * FRAME, 90, 30),
    ],
  },
  {
    name: "a second turn splits off and merges back",
    reducedMotion: false,
    view: landscape,
    frames: [
      at(START, { model: "working" }),
      run(START + FRAME, 45, 15),
      at(START + 46 * FRAME, { model: "split" }),
      run(START + 47 * FRAME, 60, 30),
      at(START + 107 * FRAME, { model: "working" }),
      run(START + 108 * FRAME, 75, 15),
    ],
  },
  {
    name: "a call flickers and a post rises, then fades",
    reducedMotion: false,
    view: landscape,
    frames: [
      at(START, { model: "working" }),
      run(START + FRAME, 45, 45),
      at(START + 46 * FRAME, { flash: "ada/lab" }, { say: ["ada/lab", "The export view is in"] }),
      run(START + 47 * FRAME, 180, 30),
      at(START + 227 * FRAME, { say: ["stew", "Next"] }, { flash: "nobody" }),
      run(START + 228 * FRAME, 15, 5),
    ],
  },
  {
    name: "the camera zooms, pans, goes home, frames a project, and lets it go",
    reducedMotion: false,
    view: landscape,
    frames: [
      at(START, { model: "working" }),
      run(START + FRAME, 30, 30),
      at(START + 31 * FRAME, { zoom: [2.5, 120, 200] }),
      run(START + 32 * FRAME, 30, 30),
      at(START + 62 * FRAME, { pan: [-80, 40] }, { zoomMiddle: 1 / 1.3 }),
      run(START + 63 * FRAME, 30, 30),
      at(START + 93 * FRAME, { home: true }),
      run(START + 94 * FRAME, 45, 15),
      at(START + 139 * FRAME, { zoom: [3, 237, 334] }, { focus: "web" }),
      run(START + 140 * FRAME, 45, 15),
      at(START + 185 * FRAME, { focus: null }),
      run(START + 186 * FRAME, 45, 15),
      at(START + 231 * FRAME, { view: { width: 951, height: 669, left: 0, right: 476 } }),
      run(START + 232 * FRAME, 45, 15),
      // The clock jumps two seconds, as after the background, then goes back one.
      at(START + 277 * FRAME + 2_000),
      run(START + 278 * FRAME + 2_000, 15, 15),
      at(START + 293 * FRAME + 1_000),
      run(START + 294 * FRAME + 1_000, 15, 15),
    ],
  },
  {
    // From a camera zoomed past what fits, a framed sphere's room around it decides the zoom. A
    // resize keeps the height: the port eases its center's height where the web moves it at once.
    name: "a project framed close up, where the room around it decides the zoom",
    reducedMotion: false,
    view: landscape,
    frames: [
      at(START, { model: "working" }),
      run(START + FRAME, 15, 15),
      at(START + 16 * FRAME, { zoom: [3, 237, 334] }, { zoom: [3, 237, 334] }, { focus: "lab" }),
      run(START + 17 * FRAME, 45, 15),
      at(
        START + 62 * FRAME,
        { view: { width: 320, height: 669, left: 52, right: 0 } },
        { focus: null },
      ),
      run(START + 63 * FRAME, 15, 15),
      at(START + 78 * FRAME, { zoomMiddle: 3 }, { zoomMiddle: 3 }, { focus: "web" }),
      run(START + 79 * FRAME, 45, 15),
    ],
  },
  {
    name: "a paused society dims its specks",
    reducedMotion: false,
    view: landscape,
    frames: [
      at(START, { model: "resting" }),
      run(START + FRAME, 30, 30),
      at(START + 31 * FRAME, { paused: true }),
      at(START + 32 * FRAME, { paused: false }),
    ],
  },
  {
    name: "with Reduce Motion everything lands at once",
    reducedMotion: true,
    view: landscape,
    frames: [
      at(START, { model: "resting" }),
      at(START + FRAME),
      at(START + 2 * FRAME, { model: "working" }, { flash: "ada/lab" }),
      at(START + 3 * FRAME, { say: ["ada/lab", "Merged"] }, { zoom: [2, 100, 100] }),
      run(START + 4 * FRAME, 30, 30),
      at(START + 34 * FRAME, { model: "split" }, { focus: "lab" }),
      at(START + 35 * FRAME, { model: "resting" }, { home: true }),
      run(START + 36 * FRAME, 10, 10),
    ],
  },
];

/** Where the scene keeps what moves, read back through its private fields. */
const PointSchema = z.object({ x: z.number(), y: z.number() });
const BodySchema = z.object({
  x: z.number(),
  y: z.number(),
  vx: z.number(),
  vy: z.number(),
  presence: z.number(),
  flash: z.number(),
  leaving: z.boolean(),
  screen: PointSchema,
});
const MarkBodySchema = z.object({
  x: z.number(),
  y: z.number(),
  presence: z.number(),
  leaving: z.boolean(),
  screen: PointSchema,
});
const SphereSchema = z.object({ x: z.number(), y: z.number(), radius: z.number() });
const BubbleSchema = z.object({ text: z.string(), born: z.number() });
const CameraSchema = z.object({ x: z.number(), y: z.number(), scale: z.number() });

function field<T>(scene: SkyScene, name: string, schema: z.ZodType<T>): T {
  return schema.parse(Reflect.get(scene, name));
}

/** The specks a sample keeps of the 280, each as x, y, size, and alpha. */
const SPECKS = [0, 1, 100, 279];

/** What one star's drawing holds: its glow's size and alpha, and each circle's x, y, and radius. */
interface StarDrawn {
  readonly id: string;
  glow: number[];
  readonly arcs: number[][];
}

/**
 * A 2D context that does nothing but note what a frame draws: the specks, the citizens' names,
 * each star's glow and circles (its rings, its disc, and its sparks), each task mark's glow, and
 * the threads from held tasks with the sparks running along them. `play` tells it whose drawing
 * is under way, by wrapping the scene's own `drawTasks` and `drawBody`.
 */
function recordingContext(names: ReadonlySet<string>) {
  let fillStyle = "";
  let font = "";
  let alpha = 1;
  let rects = 0;
  const drawn = {
    specks: [] as number[][],
    names: [] as (string | number)[][],
    stars: [] as StarDrawn[],
    /** Each task mark's glow, as its size and alpha. */
    marks: [] as number[][],
    /** Each thread as it starts at its task's mark and ends at its holder's star. */
    lines: [] as number[][],
    /** Where each thread's spark is. */
    sparks: [] as number[][],
    /** Whose drawing is under way: the tasks', a star's, or neither. */
    phase: null as "tasks" | StarDrawn | null,
  };
  let line: number[] = [];
  const gradient = { addColorStop: () => {} };
  const context = new Proxy(
    {},
    {
      get(_target, key) {
        switch (key) {
          case "fillStyle":
            return fillStyle;
          case "font":
            return font;
          case "setTransform":
            // The first call of every frame's drawing.
            return () => {
              rects = 0;
              drawn.specks = [];
              drawn.names = [];
              drawn.stars = [];
              drawn.marks = [];
              drawn.lines = [];
              drawn.sparks = [];
            };
          case "fillRect":
            return (x: number, y: number, width: number) => {
              rects += 1;
              // The first rectangle is the night itself; the next 280 are the specks.
              if (rects >= 2 && rects <= 281) {
                const speck = Number(/,\s*([\d.]+)\)$/.exec(fillStyle)?.[1] ?? Number.NaN);
                drawn.specks.push([x, y, width, speck]);
              }
            };
          case "fillText":
            return (text: string, x: number, y: number) => {
              if (names.has(text)) {
                const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? Number.NaN);
                drawn.names.push([text, x, y, size]);
              }
            };
          case "drawImage":
            return (_image: unknown, _x: number, _y: number, width: number) => {
              if (drawn.phase === "tasks") {
                drawn.marks.push([width, alpha]);
              } else if (drawn.phase !== null) {
                drawn.phase.glow = [width, alpha];
              }
            };
          case "arc":
            return (x: number, y: number, radius: number) => {
              if (drawn.phase === "tasks") {
                drawn.sparks.push([x, y]);
              } else if (drawn.phase !== null) {
                drawn.phase.arcs.push([x, y, radius]);
              }
            };
          case "moveTo":
            return (x: number, y: number) => {
              line = [x, y];
            };
          case "lineTo":
            return (x: number, y: number) => {
              if (drawn.phase === "tasks") {
                drawn.lines.push([...line, x, y]);
              }
            };
          case "createRadialGradient":
          case "createLinearGradient":
            return () => gradient;
          case "measureText":
            return (text: string) => ({ width: text.length * 6 });
          default:
            return () => {};
        }
      },
      set(_target, key, value) {
        if (key === "fillStyle") {
          fillStyle = String(value);
        } else if (key === "font") {
          font = String(value);
        } else if (key === "globalAlpha") {
          alpha = Number(value);
        }
        return true;
      },
    },
  );
  return { context, drawn };
}

/** Wraps one of the scene's own methods so `around` runs it. */
function wrap(scene: SkyScene, name: string, around: (call: () => void, args: unknown[]) => void) {
  const original = z
    .custom<(...args: unknown[]) => unknown>((value) => typeof value === "function")
    .parse(Reflect.get(scene, name));
  Reflect.set(scene, name, (...args: unknown[]) =>
    around(() => {
      Reflect.apply(original, scene, args);
    }, args),
  );
}

/** How far along its thread a spark is, from the holder's star at 0 to the task's mark at 1. */
function along(line: readonly number[], spark: readonly number[] | undefined): number | null {
  const [fromX = 0, fromY = 0, toX = 0, toY = 0] = line;
  if (spark === undefined) {
    return null;
  }
  const [x = 0, y = 0] = spark;
  return Math.abs(fromX - toX) >= Math.abs(fromY - toY)
    ? (x - toX) / (fromX - toX)
    : (y - toY) / (fromY - toY);
}

function canvas(context: object): HTMLCanvasElement {
  const element = { width: 0, height: 0, getContext: () => context };
  return z.custom<HTMLCanvasElement>(() => true).parse(element);
}

/** A sequence played through the real scene, with each sampled frame's state read back. */
function play(sequence: Sequence) {
  const names = new Set(people.map((each) => each.name));
  const { context, drawn } = recordingContext(names);
  const scene = new SkyScene(canvas(context), {
    reducedMotion: sequence.reducedMotion,
    onHoverPosition: () => {},
  });
  const frame = z
    .custom<(now: number) => void>((value) => typeof value === "function")
    .parse(Reflect.get(scene, "frame"));
  wrap(scene, "drawTasks", (call) => {
    drawn.phase = "tasks";
    call();
    drawn.phase = null;
  });
  const BodyStarSchema = z.object({ star: z.object({ id: z.string() }) });
  wrap(scene, "drawBody", (call, args) => {
    const star: StarDrawn = { id: BodyStarSchema.parse(args[0]).star.id, glow: [], arcs: [] };
    drawn.stars.push(star);
    drawn.phase = star;
    call();
    drawn.phase = null;
  });
  let view = sequence.view;
  scene.resize(view.width, view.height, 1);
  scene.setInsets(view.left, view.right);
  // As `start` does, so the first frame moves nothing.
  Reflect.set(scene, "last", (sequence.frames[0]?.ms ?? 0) / 1000);
  const samples = [];
  for (const each of sequence.frames.flatMap(expand)) {
    for (const op of each.ops ?? []) {
      if ("model" in op) {
        scene.setModel(named(op.model));
      } else if ("view" in op) {
        view = op.view;
        scene.resize(view.width, view.height, 1);
        scene.setInsets(view.left, view.right);
      } else if ("flash" in op) {
        scene.flash(op.flash);
      } else if ("say" in op) {
        scene.say(op.say[0], op.say[1]);
      } else if ("zoom" in op) {
        scene.zoomBy(op.zoom[0], { x: op.zoom[1], y: op.zoom[2] });
      } else if ("zoomMiddle" in op) {
        scene.zoomBy(op.zoomMiddle);
      } else if ("pan" in op) {
        scene.panBy(op.pan[0], op.pan[1]);
      } else if ("home" in op) {
        scene.home();
      } else if ("focus" in op) {
        scene.setFocus(op.focus);
      } else {
        scene.setPaused(op.paused);
      }
    }
    frame(each.ms);
    if (each.sample === true) {
      const entries = <T>(name: string, schema: z.ZodType<T>) =>
        [...field(scene, name, z.map(z.string(), schema))].map(([id, value]) => ({ id, ...value }));
      samples.push(
        rounded({
          ms: each.ms,
          camera: {
            mode: field(scene, "mode", z.string()),
            target: field(scene, "target", CameraSchema),
            x: field(scene, "camX", z.number()),
            y: field(scene, "camY", z.number()),
            scale: field(scene, "scale", z.number()),
            centerX: field(scene, "centerX", z.number()),
          },
          bodies: entries("bodies", BodySchema),
          marks: entries("marks", MarkBodySchema),
          spheres: entries("spheres", SphereSchema),
          bubbles: entries("bubbles", BubbleSchema),
          specks: SPECKS.map((index) => drawn.specks[index]),
          names: drawn.names,
          stars: drawn.stars,
          markGlows: drawn.marks,
          links: drawn.lines.map((line, index) => along(line, drawn.sparks[index])),
        }),
      );
    }
  }
  return {
    name: sequence.name,
    reducedMotion: sequence.reducedMotion,
    view: sequence.view,
    frames: sequence.frames,
    samples,
  };
}

describe("the scene's table for BoardKit", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    // The marks' paths, which the recording canvas never fills.
    vi.stubGlobal(
      "Path2D",
      class {
        readonly data: string;
        constructor(data = "") {
          this.data = data;
        }
      },
    );
    // The glows' sprites are drawn once on canvases of their own, which record nothing.
    vi.stubGlobal("document", { createElement: () => canvas(recordingContext(new Set()).context) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("plays each sequence through the real scene", async () => {
    const played = sequences.map(play);
    const sampled = played.flatMap((each) => each.samples);
    expect(sampled.length).toBeGreaterThan(60);
    // Every sample drew the specks and every citizen's name.
    expect(sampled.every((each) => each.specks.every((speck) => speck?.length === 4))).toBe(true);
    expect(sampled.every((each) => each.names.length >= each.bodies.length)).toBe(true);
    // Every star drew its glow and its disc, every mark its glow.
    expect(sampled.every((each) => each.stars.length === each.bodies.length)).toBe(true);
    expect(sampled.every((each) => each.stars.every((star) => star.glow.length === 2))).toBe(true);
    expect(sampled.every((each) => each.markGlows.length === each.marks.length)).toBe(true);
    expect(sampled.some((each) => each.links.some((spark) => spark !== null))).toBe(true);
    await expect(tableText({ models, sequences: played })).toMatchFileSnapshot(
      "../../../ios/fixtures/sky/scene.json",
    );
  });
});
