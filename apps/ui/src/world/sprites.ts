import { Texture, type TextureSource } from "pixi.js";
import { CanvasSource } from "pixi.js";

/**
 * Every sprite in the world is drawn from a pixel map in this file: rows of characters, one per
 * pixel, mapped to a palette. No image assets, no atlas pipeline, no licence to record, and the
 * badges that tell a Claude from a Codex or an engineer from a reviewer are drawn for this project.
 * Textures are rasterized once to a canvas and sampled with nearest-neighbor scaling.
 */

export const TILE = 16;

type Palette = Readonly<Record<string, string>>;

const BASE: Palette = {
  ".": "transparent",
  k: "#1a1523", // outline
  w: "#f4efe6", // white
  s: "#f1c9a5", // skin
  S: "#c98f66", // skin shade
  e: "#2b2233", // eye
  g: "#3e8e5a", // grass green
  G: "#2f6f46", // dark green
  d: "#6b4b2a", // dirt
  D: "#4e361d", // dark dirt
  y: "#f2c94c", // yellow
  o: "#e8833a", // orange
  r: "#d64545", // red
  b: "#4b7bec", // blue
  B: "#2c4a8f", // dark blue
  t: "#2ec4b6", // teal
  T: "#1b7f78", // dark teal
  p: "#a06cd5", // purple
  m: "#8b90a0", // muted
  M: "#565a68", // dark muted
  n: "#c9a66b", // wood
  N: "#8a6a3b", // dark wood
  c: "#9bb7d4", // cloud
  h: "#e6e6e6", // light gray
  f: "#ff9f43", // flame
  z: "#7aa2f7", // accent
  x: "#3a3f52", // stone
  X: "#232636", // dark stone
};

/** Body colors by role: the outfit is how a role reads at a glance. */
const OUTFITS: Readonly<Record<string, { coat: string; trim: string }>> = {
  engineer: { coat: "#e8b04b", trim: "#b07a1e" }, // hard hat yellow
  reviewer: { coat: "#5b8def", trim: "#2c4a8f" }, // blue with glasses
  steward: { coat: "#7fb069", trim: "#4d7a3c" }, // green with a clipboard
  concierge: { coat: "#c97bd3", trim: "#8a4f93" }, // purple with a bell
  default: { coat: "#8b90a0", trim: "#565a68" },
};

/** Face colors by CLI: the face is who the citizen is under the outfit. */
const FACES: Readonly<Record<string, { skin: string; mark: string }>> = {
  claude: { skin: "#f6c9a0", mark: "#e8833a" },
  codex: { skin: "#dfe8f3", mark: "#2ec4b6" },
};

function draw(map: readonly string[], palette: Palette, scale = 1): HTMLCanvasElement {
  const height = map.length;
  const width = Math.max(...map.map((row) => row.length));
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("2d canvas unavailable");
  }
  map.forEach((row, y) => {
    row.split("").forEach((char, x) => {
      const color = palette[char] ?? BASE[char] ?? "transparent";
      if (color === "transparent") return;
      context.fillStyle = color;
      context.fillRect(x * scale, y * scale, scale, scale);
    });
  });
  return canvas;
}

const cache = new Map<string, Texture>();

function textureOf(key: string, map: readonly string[], palette: Palette = BASE): Texture {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const canvas = draw(map, palette);
  const source: TextureSource = new CanvasSource({ resource: canvas, scaleMode: "nearest" });
  const texture = new Texture({ source, label: key });
  cache.set(key, texture);
  return texture;
}

// --- Citizens: 16 wide, 20 tall, two frames per state. Row order: hat/hair, face, coat, legs. -----

const CITIZEN_FRAMES: Readonly<Record<string, readonly (readonly string[])[]>> = {
  idle: [
    [
      "................",
      ".....HHHHHH.....",
      "....HHHHHHHH....",
      "....kFFFFFFk....",
      "....kFeFFeFk....",
      "....kFFFFFFk....",
      ".....kFFFFk.....",
      "......kmmk......",
      "....kCCCCCCk....",
      "...kCCCCCCCCk...",
      "...kCCcCCcCCk...",
      "...kCCCCCCCCk...",
      "....kCCCCCCk....",
      "....kLLkkLLk....",
      "....kLLk.kLLk...",
      "....kLLk.kLLk...",
      "....kkkk.kkkk...",
      "................",
      "................",
      "................",
    ],
    [
      "................",
      "................",
      ".....HHHHHH.....",
      "....HHHHHHHH....",
      "....kFFFFFFk....",
      "....kFeFFeFk....",
      "....kFFFFFFk....",
      ".....kFFFFk.....",
      "......kmmk......",
      "....kCCCCCCk....",
      "...kCCCCCCCCk...",
      "...kCCcCCcCCk...",
      "...kCCCCCCCCk...",
      "....kCCCCCCk....",
      "....kLLkkLLk....",
      "....kLLk.kLLk...",
      "....kkkk.kkkk...",
      "................",
      "................",
      "................",
    ],
  ],
  walk: [
    [
      "................",
      ".....HHHHHH.....",
      "....HHHHHHHH....",
      "....kFFFFFFk....",
      "....kFeFFeFk....",
      "....kFFFFFFk....",
      ".....kFFFFk.....",
      "......kmmk......",
      "....kCCCCCCk....",
      "...kCCCCCCCCk...",
      "...kCCcCCcCCk...",
      "...kCCCCCCCCk...",
      "....kCCCCCCk....",
      "...kLLk..kLLk...",
      "..kLLk....kLLk..",
      "..kkkk....kkkk..",
      "................",
      "................",
      "................",
      "................",
    ],
    [
      "................",
      ".....HHHHHH.....",
      "....HHHHHHHH....",
      "....kFFFFFFk....",
      "....kFeFFeFk....",
      "....kFFFFFFk....",
      ".....kFFFFk.....",
      "......kmmk......",
      "....kCCCCCCk....",
      "...kCCCCCCCCk...",
      "...kCCcCCcCCk...",
      "...kCCCCCCCCk...",
      "....kCCCCCCk....",
      ".....kLLLLk.....",
      ".....kLLLLk.....",
      ".....kkkkkk.....",
      "................",
      "................",
      "................",
      "................",
    ],
  ],
  work: [
    [
      "................",
      ".....HHHHHH.....",
      "....HHHHHHHH....",
      "....kFFFFFFk....",
      "....kFeFFeFk....",
      "....kFFFFFFk....",
      ".....kFFFFk.....",
      "......kmmk...nn.",
      "....kCCCCCCkknn.",
      "...kCCCCCCCCkk..",
      "...kCCcCCcCCk...",
      "...kCCCCCCCCk...",
      "....kCCCCCCk....",
      "....kLLkkLLk....",
      "....kLLk.kLLk...",
      "....kLLk.kLLk...",
      "....kkkk.kkkk...",
      "................",
      "................",
      "................",
    ],
    [
      "................",
      ".....HHHHHH.....",
      "....HHHHHHHH....",
      "....kFFFFFFk....",
      "....kFeFFeFk....",
      "....kFFFFFFk....",
      ".....kFFFFk.....",
      "......kmmk......",
      "....kCCCCCCk....",
      "...kCCCCCCCCkk..",
      "...kCCcCCcCCknn.",
      "...kCCCCCCCCknn.",
      "....kCCCCCCk....",
      "....kLLkkLLk....",
      "....kLLk.kLLk...",
      "....kLLk.kLLk...",
      "....kkkk.kkkk...",
      "................",
      "................",
      "................",
    ],
  ],
  sleep: [
    [
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      ".....HHHHHH.....",
      "....HHHHHHHH....",
      "....kFFFFFFk....",
      "....kFkFFkFk....",
      "....kFFFFFFk....",
      ".....kFFFFk.....",
      "....kCCCCCCkkkk.",
      "...kCCCCCCCCLLk.",
      "...kCCcCCcCCLLk.",
      "....kkkkkkkkkkk.",
      "................",
      "................",
      "................",
      "................",
    ],
    [
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      ".....HHHHHH.....",
      "....HHHHHHHH....",
      "....kFFFFFFk....",
      "....kFkFFkFk....",
      "....kFFFFFFk....",
      ".....kFFFFk.....",
      "....kCCCCCCkkkk.",
      "...kCCCCCCCCLLk.",
      "...kCCcCCcCCLLk.",
      "....kkkkkkkkkkk.",
      "................",
      "................",
      "................",
      "................",
    ],
  ],
};

/** Hats by role, drawn over the hair rows: a hard hat, glasses, a clipboard, a bell. */
const HATS: Readonly<Record<string, readonly string[]>> = {
  engineer: ["....kyyyyyyk....", "...kyyyyyyyyk...", "...kkkkkkkkkk..."],
  reviewer: [
    "................",
    "................",
    "................",
    "....kFFFFFFk....",
    "...kbFbFFbFbk...",
    "....kbbFFbbk....",
  ],
  steward: [],
  concierge: ["......kyyk......", ".....kyyyyk.....", ".....kkkkkk....."],
};

export type CitizenFrameState = "idle" | "walk" | "work" | "sleep";

/** The citizen's two frames for a state, with the role's outfit and the CLI's face. */
export function citizenTextures(
  role: string,
  cli: "claude" | "codex",
  state: CitizenFrameState,
): Texture[] {
  const outfit = OUTFITS[role] ?? OUTFITS["default"];
  const face = FACES[cli] ?? FACES["claude"];
  const palette: Palette = {
    ...BASE,
    H: role === "engineer" ? "#f2c94c" : role === "concierge" ? "#4a3a6b" : "#3b2f2f",
    F: face?.skin ?? "#f6c9a0",
    C: outfit?.coat ?? "#8b90a0",
    c: outfit?.trim ?? "#565a68",
    L: outfit?.trim ?? "#565a68",
    m: face?.mark ?? "#e8833a",
  };
  const frames = CITIZEN_FRAMES[state] ?? CITIZEN_FRAMES["idle"] ?? [];
  return frames.map((frame, index) => {
    const hat = HATS[role] ?? [];
    const merged = frame.map((row, y) => {
      const hatRow = hat[y];
      if (hatRow === undefined || state === "sleep") return row;
      return row
        .split("")
        .map((char, x) => (hatRow[x] !== undefined && hatRow[x] !== "." ? hatRow[x] : char))
        .join("");
    });
    return textureOf(`citizen:${role}:${cli}:${state}:${index}`, merged, palette);
  });
}

// --- Tiles and buildings ----------------------------------------------------------------------------

const GRASS = [
  "gggggggggggggggg",
  "ggggGgggggggggGg",
  "gggggggggggggggg",
  "gggggggGgggggggg",
  "gggggggggggggggg",
  "gGgggggggggggggg",
  "gggggggggggggggg",
  "ggggggggggGggggg",
  "gggggggggggggggg",
  "gggGgggggggggggg",
  "gggggggggggggggg",
  "gggggggggggGgggg",
  "gggggggggggggggg",
  "ggGggggggggggggg",
  "gggggggggggggggg",
  "gggggggGgggggggg",
];

const PATH = [
  "nnnnnnnnnnnnnnnn",
  "nnNnnnnnnnnnnNnn",
  "nnnnnnnnnnnnnnnn",
  "nnnnnnnNnnnnnnnn",
  "nnnnnnnnnnnnnnnn",
  "nNnnnnnnnnnnnnnn",
  "nnnnnnnnnnnnnnnn",
  "nnnnnnnnnnNnnnnn",
  "nnnnnnnnnnnnnnnn",
  "nnnNnnnnnnnnnnnn",
  "nnnnnnnnnnnnnnnn",
  "nnnnnnnnnnnNnnnn",
  "nnnnnnnnnnnnnnnn",
  "nnNnnnnnnnnnnnnn",
  "nnnnnnnnnnnnnnnn",
  "nnnnnnnNnnnnnnnn",
];

const SOIL = [
  "dddddddddddddddd",
  "dDdddddddddddDdd",
  "dddddddddddddddd",
  "dddddddDdddddddd",
  "dddddddddddddddd",
  "dDdddddddddddddd",
  "dddddddddddddddd",
  "ddddddddddDddddd",
  "dddddddddddddddd",
  "dddDdddddddddddd",
  "dddddddddddddddd",
  "dddddddddddDdddd",
  "dddddddddddddddd",
  "ddDddddddddddddd",
  "dddddddddddddddd",
  "dddddddDdddddddd",
];

const FENCE_H = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "nnnnnnnnnnnnnnnn",
  "NNNNNNNNNNNNNNNN",
  "................",
  "................",
  "nnnnnnnnnnnnnnnn",
  "NNNNNNNNNNNNNNNN",
  "................",
  "................",
  "................",
  "................",
];

const FENCE_V = [
  "......nn........",
  "......nN........",
  "......nN........",
  "......nN........",
  "......nN........",
  "......nN........",
  "......nN........",
  "......nN........",
  "......nN........",
  "......nN........",
  "......nN........",
  "......nN........",
  "......nN........",
  "......nN........",
  "......nN........",
  "......NN........",
];

function put(rows: string[], x: number, y: number, text: string): void {
  const row = rows[y];
  if (row === undefined || x < 0 || x + text.length > row.length) return;
  rows[y] = `${row.slice(0, x)}${text}${row.slice(x + text.length)}`;
}

/**
 * A building drawn to an exact pixel size: a pitched roof over a wall, a door, and windows that
 * light up in the same color everywhere so a lit window reads the same on every building.
 */
function building(width: number, height: number, roof: string, wall: string): readonly string[] {
  const rows: string[] = [];
  const roofRows = Math.max(4, Math.floor(height / 3));
  for (let y = 0; y < height; y += 1) {
    let row = "";
    for (let x = 0; x < width; x += 1) {
      const inset = y < roofRows ? Math.max(0, roofRows - 1 - y) : 0;
      if (x < inset || x >= width - inset) {
        row += ".";
        continue;
      }
      const edge =
        x === inset || x === width - 1 - inset || y === 0 || y === height - 1 || y === roofRows;
      row += edge ? "k" : y < roofRows ? roof : wall;
    }
    rows.push(row);
  }
  const doorX = Math.floor(width / 2) - 3;
  for (let y = height - 9; y < height - 1; y += 1) {
    put(rows, doorX, y, y === height - 9 ? "kkkkkk" : "kNNNNk");
  }
  put(rows, doorX + 3, height - 5, "y");
  const windowY = roofRows + 3;
  for (const windowX of width >= 48 ? [4, width - 10] : [4]) {
    if (windowX + 6 >= doorX && windowX <= doorX + 6) continue;
    put(rows, windowX, windowY, "kkkkkk");
    put(rows, windowX, windowY + 1, "kzzzzk");
    put(rows, windowX, windowY + 2, "kzzzzk");
    put(rows, windowX, windowY + 3, "kzzzzk");
    put(rows, windowX, windowY + 4, "kkkkkk");
  }
  return rows;
}

export const tiles = {
  grass: (): Texture => textureOf("tile:grass", GRASS),
  path: (): Texture => textureOf("tile:path", PATH),
  soil: (): Texture => textureOf("tile:soil", SOIL),
  fenceH: (): Texture => textureOf("tile:fenceH", FENCE_H),
  fenceV: (): Texture => textureOf("tile:fenceV", FENCE_V),
  house: (): Texture => textureOf("building:house", building(64, 48, "r", "n")),
  frontDesk: (): Texture => textureOf("building:frontDesk", building(48, 32, "p", "n")),
  townHall: (): Texture => textureOf("building:townHall", building(80, 48, "b", "h")),
  library: (): Texture => textureOf("building:library", building(64, 32, "t", "n")),
  barn: (): Texture => textureOf("building:barn", building(32, 32, "r", "N")),
};

// --- Crops, weather, props ------------------------------------------------------------------------

const CROPS: Readonly<Record<string, readonly string[]>> = {
  seed: [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "......kk........",
    ".....kddk.......",
    "....kDDDDk......",
    ".....kkkk.......",
    "................",
    "................",
  ],
  growing: [
    "................",
    "................",
    "................",
    "................",
    "......gg........",
    ".....kggk.......",
    "....kgggGk......",
    ".....kgGk.......",
    "......kGk.......",
    "......kGk.......",
    ".....kGGGk......",
    "....kDDDDDk.....",
    "....kDDDDDk.....",
    ".....kkkkk......",
    "................",
    "................",
  ],
  ripe: [
    "................",
    "......kk........",
    ".....kyyk.......",
    "....kyyyyk......",
    "....kyyyyk......",
    ".....kyyk.......",
    "....kgGGgk......",
    "...kggGGggk.....",
    "....kgGGgk......",
    "......kGk.......",
    "......kGk.......",
    ".....kGGGk......",
    "....kDDDDDk.....",
    "....kDDDDDk.....",
    ".....kkkkk......",
    "................",
  ],
  harvested: [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "....kkkkkkk.....",
    "...knnnnnnnk....",
    "...knyynyynk....",
    "...knnnnnnnk....",
    "...kNNNNNNNk....",
    "....kkkkkkk.....",
    "................",
    "................",
    "................",
  ],
  withered: [
    "................",
    "................",
    "................",
    "................",
    "......MM........",
    ".....kMMk.......",
    "......kMk.......",
    "......kMk.......",
    ".....kMMMk......",
    "......kMk.......",
    "......kMk.......",
    ".....kMMMk......",
    "....kDDDDDk.....",
    "....kDDDDDk.....",
    ".....kkkkk......",
    "................",
  ],
  fenced: [
    "................",
    "................",
    "................",
    "..kk........kk..",
    "..kn........nk..",
    "..knnnnnnnnnnk..",
    "..kNNNNNNNNNNk..",
    "..kn...gg...nk..",
    "..kn..kggk..nk..",
    "..knnnkGGknnnk..",
    "..kNNNkGkNNNNk..",
    "..kn..kGGGk.nk..",
    "..kk.kDDDDDk.kk.",
    ".....kDDDDDk....",
    "......kkkkk.....",
    "................",
  ],
};

export function cropTexture(stage: string, wilted: boolean): Texture {
  const map = CROPS[stage] ?? CROPS["seed"] ?? [];
  return wilted
    ? textureOf(`crop:${stage}:wilted`, map, { ...BASE, g: "#8a7a3a", G: "#5c5127", y: "#a08a3a" })
    : textureOf(`crop:${stage}`, map);
}

const WEATHER: Readonly<Record<string, readonly string[]>> = {
  cloud: [
    "................",
    "................",
    "......cccc......",
    "....cccccccc....",
    "..cccccccccccc..",
    ".cccccccccccccc.",
    ".ccccccccccccccc",
    "..cccccccccccc..",
    "................",
    "...b...b...b....",
    "..b...b...b.....",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  hiring: [
    "................",
    "...kkkkkkkkkk...",
    "...kwwwwwwwwk...",
    "...kwrwwrwwwk...",
    "...kwrrwrwrwk...",
    "...kwrwrrwrwk...",
    "...kwrwwrwwwk...",
    "...kwwwwwwwwk...",
    "...kkkkkkkkkk...",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    "......kkkk......",
    "................",
  ],
  dust: [
    "................",
    "......nn........",
    ".....n..n.......",
    "....n....n......",
    ".....n..n.......",
    "......nn........",
    ".....n..n.......",
    "....n....n......",
    "...n......n.....",
    "....n....n......",
    ".....n..n.......",
    "......nn........",
    ".....n..n.......",
    "....n....n......",
    "................",
    "................",
  ],
  cobweb: [
    "h.......h.......",
    ".h.....h........",
    "..h...h.........",
    "...h.h..........",
    "hhhhhhhhh.......",
    "...h.h..........",
    "..h...h.........",
    ".h.....h........",
    "h.......h.......",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  lock: [
    "................",
    "......kkkk......",
    ".....kmmmmk.....",
    "....kmk..kmk....",
    "....kmk..kmk....",
    "....kmk..kmk....",
    "...kkkkkkkkkk...",
    "...kyyyyyyyyk...",
    "...kyyykkyyyk...",
    "...kyyykkyyyk...",
    "...kyyyykyyyk...",
    "...kyyyyyyyyk...",
    "...kkkkkkkkkk...",
    "................",
    "................",
    "................",
  ],
  frame: [
    "................",
    ".......kk.......",
    "......knnk......",
    ".....kn..nk.....",
    "....kn....nk....",
    "...kn......nk...",
    "..kkkkkkkkkkkk..",
    "..kn........nk..",
    "..kn........nk..",
    "..kn........nk..",
    "..kn........nk..",
    "..kn........nk..",
    "..kn........nk..",
    "..kkkkkkkkkkkk..",
    "................",
    "................",
  ],
};

export function weatherTexture(kind: string): Texture {
  return textureOf(`weather:${kind}`, WEATHER[kind] ?? WEATHER["cloud"] ?? []);
}

const PROPS: Readonly<Record<string, readonly string[]>> = {
  sign: [
    "................",
    "..kkkkkkkkkkkk..",
    "..knnnnnnnnnnk..",
    "..knNNnNnNNnnk..",
    "..knnnnnnnnnnk..",
    "..kkkkkkkkkkkk..",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    ".....kkkkkk.....",
    "................",
  ],
  mailbox: [
    "................",
    "....kkkkkkkk....",
    "...kbbbbbbbbk...",
    "...kbbbbbbbbk...",
    "...kbwwwwwwbk...",
    "...kbbbbbbbbk...",
    "...kkkkkkkkkk...",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    "......kNNk......",
    ".....kkkkkk.....",
    "................",
  ],
  flag: [
    "................",
    "..........kk....",
    "..........krk...",
    "..........krrk..",
    "..........krrrk.",
    "..........krrk..",
    "..........krk...",
    "..........kk....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  clock: [
    ".....kkkkkk.....",
    "....khhhhhhk....",
    "...khhkhhkhhk...",
    "...khhhhhhhhk...",
    "...khhhhkhhhk...",
    "...khhhhkhhhk...",
    "...khhkkkhhhk...",
    "...khhhhhhhhk...",
    "....khhhhhhk....",
    ".....kkkkkk.....",
    "......kxxk......",
    "......kxxk......",
    "......kxxk......",
    "......kxxk......",
    ".....kkkkkk.....",
    "................",
  ],
  bench: [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "kkkkkkkkkkkkkkkk",
    "knnnnnnnnnnnnnnk",
    "kkkkkkkkkkkkkkkk",
    "kNNkkkkkkkkkkNNk",
    "kNNk........kNNk",
    "kNNk........kNNk",
    "kkkk........kkkk",
    "................",
    "................",
    "................",
  ],
  stone: [
    "................",
    "................",
    "......kkkk......",
    ".....kxxxxk.....",
    "....kxxxxxxk....",
    "....kxxkkxxk....",
    "....kxkxxkxk....",
    "....kxxkkxxk....",
    "....kxxxxxxk....",
    "....kxxxxxxk....",
    "....kxxxxxxk....",
    "...kxxxxxxxxk...",
    "...kkkkkkkkkk...",
    "..ggggggggggggg.",
    "................",
    "................",
  ],
  lamp: [
    "................",
    "................",
    "......kkkk......",
    ".....kffffk.....",
    ".....kfyyfk.....",
    ".....kfyyfk.....",
    ".....kffffk.....",
    "......kkkk......",
    "......kxxk......",
    "......kxxk......",
    "......kxxk......",
    "......kxxk......",
    "......kxxk......",
    ".....kkkkkk.....",
    "................",
    "................",
  ],
  zzz: [
    "................",
    "........hhhh....",
    "..........hh....",
    ".........hh.....",
    "........hhhh....",
    "................",
    "....hhh.........",
    ".....hh.........",
    "....hh..........",
    "....hhh.........",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  mark: [
    "................",
    "......krrk......",
    "......krrk......",
    "......krrk......",
    "......krrk......",
    "......krrk......",
    "......krrk......",
    "......kkkk......",
    "................",
    "......krrk......",
    "......kkkk......",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  glow: [
    "......ffff......",
    "....ffffffff....",
    "...ffffffffff...",
    "..ffffffffffff..",
    ".ffffffffffffff.",
    ".ffffffffffffff.",
    "ffffffffffffffff",
    "ffffffffffffffff",
    "ffffffffffffffff",
    "ffffffffffffffff",
    ".ffffffffffffff.",
    ".ffffffffffffff.",
    "..ffffffffffff..",
    "...ffffffffff...",
    "....ffffffff....",
    "......ffff......",
  ],
};

export function propTexture(name: string): Texture {
  return textureOf(`prop:${name}`, PROPS[name] ?? PROPS["sign"] ?? []);
}
