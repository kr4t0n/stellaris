import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IMAGE_LIMIT_BYTES } from "@stellaris/shared";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTurnImage, type ImagePlaces } from "./images.js";

/** The smallest PNG there is: one transparent pixel. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const HEADERS = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  gif: Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"),
  webp: Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1"),
};

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
    for (const [type, bytes] of Object.entries(HEADERS)) {
      const file = path.join(temp, `${type}.png`);
      await writeFile(file, bytes);
      expect(await readTurnImage(file, places)).toMatchObject({ kind: "image", type });
    }
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

  it("takes an image of exactly the limit and refuses one a byte over it", async () => {
    const file = path.join(temp, "big.png");
    await writeFile(file, Buffer.concat([PIXEL, Buffer.alloc(IMAGE_LIMIT_BYTES - PIXEL.length)]));
    expect(await readTurnImage(file, places)).toMatchObject({
      kind: "image",
      size: IMAGE_LIMIT_BYTES,
    });
    await writeFile(
      file,
      Buffer.concat([PIXEL, Buffer.alloc(IMAGE_LIMIT_BYTES + 1 - PIXEL.length)]),
    );
    expect(await readTurnImage(file, places)).toEqual({
      kind: "refused",
      why: "too_big",
      detail: `${file} is ${IMAGE_LIMIT_BYTES + 1} bytes, over the ${IMAGE_LIMIT_BYTES} an image may be`,
    });
    // A smaller limit is the same rule.
    expect(await readTurnImage(file, places, PIXEL.length - 1)).toMatchObject({ why: "too_big" });
  });

  it("stops reading at the limit a file its size does not tell runs past", async () => {
    // A file under /proc says it holds nothing, and holds more than ten bytes.
    expect(await readTurnImage("status", { cwd: "/proc/self", roots: ["/proc"] }, 10)).toEqual({
      kind: "refused",
      why: "too_big",
      detail: "status is over the 10 bytes an image may be",
    });
  });
});
