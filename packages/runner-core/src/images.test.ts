import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { IMAGE_LIMIT_BYTES, imageTypeOf } from "@stellaris/shared";
import { exifOrientation } from "@stellaris/shared/image-metadata";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { readTurnImage, TurnImageFolders, type ImagePlaces } from "./images.js";

/** The smallest PNG there is: one transparent pixel. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The images the strippers run, with what is kept of each, from base64: each kind of image with
 * a made-up camera and place, as it is kept, and as no stripper can read it.
 */
const IMAGE_CASES = z
  .object({ name: z.string(), image: z.base64(), kept: z.base64().nullable() })
  .array()
  .parse(
    JSON.parse(
      await readFile(
        new URL("../../../apps/ios/fixtures/cases/image-metadata.json", import.meta.url),
        "utf8",
      ),
    ),
  )
  .map((each) => ({
    name: each.name,
    image: Buffer.from(each.image, "base64"),
    kept: each.kept === null ? null : Buffer.from(each.kept, "base64"),
  }));

/** The case of that name. */
function imageCase(name: string): { image: Buffer; kept: Buffer | null } {
  const found = IMAGE_CASES.find((each) => each.name === name);
  if (found === undefined) {
    throw new Error(`no image case named ${name}`);
  }
  return found;
}

/** A PNG chunk of `type` holding `data`, with its CRC. */
function pngChunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, check]);
}

/**
 * The pixel as a PNG of `size` bytes, a second chunk of image data filling it out: every byte of
 * it is a chunk that draws the picture, so all of it is kept.
 */
function pngOfSize(size: number): Buffer {
  return Buffer.concat([
    PIXEL.subarray(0, -12),
    pngChunk("IDAT", Buffer.alloc(size - PIXEL.length - 12)),
    PIXEL.subarray(-12),
  ]);
}

/** The orientation a JPEG's Exif gives, 1 when it has none. */
function jpegOrientation(bytes: Buffer): number {
  const exif = bytes.indexOf("Exif\0\0", 0, "latin1");
  return exif === -1 ? 1 : exifOrientation(bytes.subarray(exif));
}

let dir: string;
let places: ImagePlaces;
let worktree: string;
let home: string;
let temp: string;
let elsewhere: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-images-"));
  worktree = path.join(dir, "worktrees", "ada", ".tasks", "01M4WY483E0XG4Q2ZTHAX3JBZV");
  home = path.join(dir, "agents", "ada");
  temp = path.join(dir, "tmp");
  elsewhere = path.join(dir, "elsewhere");
  for (const each of [worktree, home, temp, elsewhere]) {
    await mkdir(each, { recursive: true });
  }
  places = { cwd: worktree, roots: [worktree, home, temp] };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readTurnImage", () => {
  it("reads an image from the turn's worktree, its citizen's home, or the temp folder", async () => {
    await mkdir(path.join(home, "scratch"), { recursive: true });
    const files = [
      path.join(worktree, "shots", "before.png"),
      path.join(home, "scratch", "after.png"),
      path.join(temp, "runners.png"),
    ];
    for (const file of files) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, PIXEL);
    }
    for (const file of [...files, "shots/before.png", "./shots/../shots/before.png"]) {
      expect(await readTurnImage(file, places)).toEqual({
        kind: "image",
        type: "png",
        size: PIXEL.length,
        content: PIXEL.toString("base64"),
      });
    }
  });

  it("tells a JPEG, a GIF, and a WebP by their first bytes, whatever their names say", async () => {
    for (const [type, name] of [
      ["jpeg", "a JPEG that holds no metadata"],
      ["gif", "a GIF that holds no metadata"],
      ["webp", "a WebP that holds no metadata"],
    ] as const) {
      const file = path.join(temp, `${type}.png`);
      await writeFile(file, imageCase(name).image);
      expect(await readTurnImage(file, places)).toMatchObject({ kind: "image", type });
    }
  });

  it("answers a camera's photo without its camera and its place, keeping its orientation, and leaves the file as it was", async () => {
    const { image, kept } = imageCase("a camera's JPEG");
    const file = path.join(worktree, "photo.jpg");
    await writeFile(file, image);
    const read = await readTurnImage(file, places);
    const content = Buffer.from(read.kind === "image" ? read.content : "", "base64");
    expect(read).toMatchObject({ kind: "image", type: "jpeg", size: kept?.length });
    expect(content).toEqual(kept);
    // The made-up camera's make, and the GPS directory's latitude reference, a southern one.
    expect(image.includes("Example\0")).toBe(true);
    expect(content.includes("Example")).toBe(false);
    expect(image.includes(Buffer.from([0x01, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x53]))).toBe(
      true,
    );
    expect(content.includes(Buffer.from([0x53, 0x00]))).toBe(false);
    expect(jpegOrientation(image)).not.toBe(1);
    expect(jpegOrientation(content)).toBe(jpegOrientation(image));
    expect(await readFile(file)).toEqual(image);
  });

  it("answers every image of the strippers' table as it is kept, and refuses one that doesn't read to its end, saying to save it again", async () => {
    let refusals = 0;
    for (const { name, image, kept } of IMAGE_CASES) {
      const type = imageTypeOf(image);
      if (type === null) {
        continue;
      }
      const file = path.join(temp, "case.img");
      await writeFile(file, image);
      const read = await readTurnImage(file, places);
      if (kept === null) {
        refusals += 1;
        expect(read, name).toEqual({
          kind: "refused",
          why: "not_image",
          detail: `${file} does not read to its end as a ${{ png: "PNG", jpeg: "JPEG", gif: "GIF", webp: "WebP" }[type]}, so its metadata cannot be told from its picture; save it again and upload that copy`,
        });
      } else {
        expect(read, name).toEqual({
          kind: "image",
          type,
          size: kept.length,
          content: kept.toString("base64"),
        });
      }
    }
    expect(refusals).toBeGreaterThan(20);
  });

  it("answers a photo over the limit only for what follows its picture, without it", async () => {
    const { image, kept } = imageCase("a camera's JPEG");
    const file = path.join(temp, "motion.jpg");
    // As an HDR gain map or a motion photo's video follows a camera's picture.
    await writeFile(file, Buffer.concat([image, Buffer.alloc(IMAGE_LIMIT_BYTES)]));
    expect(await readTurnImage(file, places)).toEqual({
      kind: "image",
      type: "jpeg",
      size: kept?.length,
      content: kept?.toString("base64"),
    });
  });

  it("refuses a file outside those places, and a link that leads out of them", async () => {
    const secret = path.join(elsewhere, "credentials.png");
    await writeFile(secret, PIXEL);
    expect(await readTurnImage(secret, places)).toMatchObject({
      kind: "refused",
      why: "outside",
      detail: expect.stringContaining("is outside your worktree, your home, and the system temp"),
    });
    expect(await readTurnImage("../../../../elsewhere/credentials.png", places)).toMatchObject({
      why: "outside",
    });
    // A folder that holds a root is not inside it.
    expect(await readTurnImage(dir, places)).toMatchObject({ why: "outside" });
    // A link inside the worktree is followed before the file is placed, a folder's link too.
    await symlink(secret, path.join(worktree, "shot.png"));
    await symlink(elsewhere, path.join(temp, "shots"));
    for (const file of [
      path.join(worktree, "shot.png"),
      path.join(temp, "shots", "credentials.png"),
    ]) {
      const read = await readTurnImage(file, places);
      expect(read).toMatchObject({ kind: "refused", why: "outside" });
      expect(read.kind === "refused" && read.detail).toContain(`which leads to ${secret}`);
    }
    // A root that is itself a link counts where it leads.
    const linked = path.join(dir, "linked-home");
    await symlink(home, linked);
    await writeFile(path.join(home, "mine.png"), PIXEL);
    expect(
      await readTurnImage(path.join(linked, "mine.png"), { cwd: worktree, roots: [linked] }),
    ).toMatchObject({ kind: "image" });
  });

  it("refuses a file that is not there", async () => {
    for (const file of [path.join(temp, "gone.png"), "gone.png", path.join(elsewhere, "x.png")]) {
      expect(await readTurnImage(file, places)).toMatchObject({
        kind: "refused",
        why: "missing",
        detail: expect.stringContaining("does not exist on this runner"),
      });
    }
  });

  it("refuses text named like an image, an SVG, an empty file, a folder, and a pipe", async () => {
    const text = path.join(worktree, "notes.png");
    await writeFile(text, "these are notes, not a picture\n");
    expect(await readTurnImage(text, places)).toEqual({
      kind: "refused",
      why: "not_image",
      detail: `${text} is not a PNG, JPEG, GIF, or WebP image by its first bytes, whatever its name says`,
    });
    const svg = path.join(worktree, "chart.svg");
    await writeFile(
      svg,
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n',
    );
    expect(await readTurnImage(svg, places)).toMatchObject({
      why: "not_image",
      detail: `${svg} is an SVG, which is not taken since it can carry script; save it as a PNG`,
    });
    // A PNG header after an SVG's opening is still an SVG.
    await writeFile(svg, Buffer.concat([Buffer.from("<svg>"), PIXEL]));
    expect(await readTurnImage(svg, places)).toMatchObject({ why: "not_image" });
    const empty = path.join(worktree, "empty.png");
    await writeFile(empty, "");
    expect(await readTurnImage(empty, places)).toMatchObject({ why: "not_image" });
    expect(await readTurnImage(worktree, places)).toMatchObject({
      why: "not_image",
      detail: `${worktree} is not a file`,
    });
    const pipe = path.join(temp, "pipe.png");
    await execa("mkfifo", [pipe]);
    expect(await readTurnImage(pipe, places)).toMatchObject({ why: "not_image" });
  });

  it("takes an image of exactly the limit without its metadata and refuses one a byte over it", async () => {
    const file = path.join(temp, "big.png");
    await writeFile(file, pngOfSize(IMAGE_LIMIT_BYTES));
    expect(await readTurnImage(file, places)).toMatchObject({
      kind: "image",
      size: IMAGE_LIMIT_BYTES,
    });
    await writeFile(file, pngOfSize(IMAGE_LIMIT_BYTES + 1));
    expect(await readTurnImage(file, places)).toEqual({
      kind: "refused",
      why: "too_big",
      detail: `${file} is ${IMAGE_LIMIT_BYTES + 1} bytes without its metadata, over the ${IMAGE_LIMIT_BYTES} an image may be`,
    });
    // A smaller limit is the same rule.
    expect(await readTurnImage(file, places, PIXEL.length - 1)).toMatchObject({ why: "too_big" });
  });

  it("reads a file of at most four times the limit, and refuses a larger one by its size before reading it", async () => {
    const file = path.join(temp, "long.png");
    await writeFile(file, Buffer.concat([PIXEL, Buffer.alloc(4 * 1000 - PIXEL.length)]));
    expect(await readTurnImage(file, places, 1000)).toEqual({
      kind: "image",
      type: "png",
      size: PIXEL.length,
      content: PIXEL.toString("base64"),
    });
    // A hole of zeros the file system never wrote, so nothing but its size is there.
    await truncate(file, 4 * IMAGE_LIMIT_BYTES + 1);
    expect(await readTurnImage(file, places)).toEqual({
      kind: "refused",
      why: "too_big",
      detail: `${file} is ${4 * IMAGE_LIMIT_BYTES + 1} bytes, over the ${4 * IMAGE_LIMIT_BYTES} read for an image of at most ${IMAGE_LIMIT_BYTES} without its metadata`,
    });
  });

  it("stops reading at the limit a file its size does not tell runs past", async () => {
    // A file under /proc says it holds nothing, and holds more than forty bytes.
    expect(await readTurnImage("status", { cwd: "/proc/self", roots: ["/proc"] }, 10)).toEqual({
      kind: "refused",
      why: "too_big",
      detail: "status is over the 40 bytes read for an image of at most 10 without its metadata",
    });
  });
});

describe("TurnImageFolders", () => {
  const TURN = "01M4WY483E0XG4Q2ZTHAX3JBZV";
  const OTHER = "01M4WY483E0XG4Q2ZTHAX3JBZW";
  const IMAGE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  let tmpdir: string | undefined;

  beforeEach(() => {
    // The system temp folder is a place of its own here, apart from the worktree and the home.
    tmpdir = process.env["TMPDIR"];
    process.env["TMPDIR"] = temp;
  });

  afterEach(() => {
    if (tmpdir === undefined) {
      delete process.env["TMPDIR"];
    } else {
      process.env["TMPDIR"] = tmpdir;
    }
  });

  it("writes each turn's images into a folder of its own in the temp folder, and removes it", async () => {
    const folders = new TurnImageFolders();
    const content = PIXEL.toString("base64");
    const first = await folders.write({ turnId: TURN, id: IMAGE, type: "png", content });
    expect(path.basename(first)).toBe(`${IMAGE}.png`);
    expect(path.dirname(path.dirname(first))).toBe(temp);
    expect(await readFile(first)).toEqual(PIXEL);
    expect((await stat(path.dirname(first))).mode & 0o777).toBe(0o700);
    for (const outside of [worktree, home]) {
      expect(path.relative(outside, first).startsWith("..")).toBe(true);
    }
    // The same turn's next image goes beside it, another turn's into a folder of that turn's.
    const jpeg = imageCase("a JPEG that holds no metadata").image;
    const second = await folders.write({
      turnId: TURN,
      id: OTHER,
      type: "jpeg",
      content: jpeg.toString("base64"),
    });
    expect(second).toBe(path.join(path.dirname(first), `${OTHER}.jpg`));
    expect(await readFile(second)).toEqual(jpeg);
    const other = await folders.write({ turnId: OTHER, id: IMAGE, type: "png", content });
    expect(path.dirname(other)).not.toBe(path.dirname(first));

    await folders.remove(TURN);
    expect(await readdir(temp)).toEqual([path.basename(path.dirname(other))]);
    // A turn that opened none, or whose folder went already, leaves nothing to remove.
    await folders.remove(TURN);
    await folders.remove("01M4WY483E0XG4Q2ZTHAX3JBZX");
    await folders.remove(OTHER);
    expect(await readdir(temp)).toEqual([]);
  });
});
