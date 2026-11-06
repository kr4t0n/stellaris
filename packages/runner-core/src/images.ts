import { constants } from "node:fs";
import { mkdtemp, open, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  IMAGE_EXTENSIONS,
  IMAGE_KIND_NAMES,
  IMAGE_LIMIT_BYTES,
  imageTypeOf,
  type ImageRefusal,
  type TurnImage,
  type TurnImageWrite,
} from "@stellaris/shared";
import { withoutMetadata } from "@stellaris/shared/image-metadata";

/** Where a turn may upload an image from. */
export interface ImagePlaces {
  /** The turn's working directory, which a relative path is read from. */
  readonly cwd: string;
  /** The folders an image may be in once every link on its way is followed. */
  readonly roots: readonly string[];
}

function refused(why: ImageRefusal, detail: string): TurnImage {
  return { kind: "refused", why, detail };
}

/** Whether a path is a folder or lies inside it, both with every link followed. */
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Whether bytes that are no image look like an SVG document, which is refused by name. */
function looksLikeSvg(bytes: Uint8Array): boolean {
  return /<svg[\s>]/i.test(new TextDecoder().decode(bytes.subarray(0, 4096)));
}

/**
 * How many times the limit a file may be before its metadata is left out: a photo whose picture
 * is at the limit with three times as much after it, such as an HDR gain map or a motion photo's
 * video, which go.
 */
const READ_LIMIT_FACTOR = 4;

/**
 * The image a turn names for `upload_image`, without its metadata (`withoutMetadata`), or why it
 * is refused. The path is resolved with every link followed before it is placed, so a link inside
 * a root cannot lead out of it, and the file is opened without following a link and without
 * waiting on a pipe. Only a regular file of at most `readLimit` bytes, whose first bytes are a
 * PNG's, a JPEG's, a GIF's, or a WebP's, is read, and only one that reads to its end and comes to
 * at most `limit` bytes without its metadata is answered. The file itself is never changed.
 */
export async function readTurnImage(
  file: string,
  places: ImagePlaces,
  limit = IMAGE_LIMIT_BYTES,
  readLimit = limit * READ_LIMIT_FACTOR,
): Promise<TurnImage> {
  const named = path.resolve(places.cwd, file);
  let real: string;
  try {
    real = await realpath(named);
  } catch {
    return refused("missing", `${file} does not exist on this runner`);
  }
  const roots = await Promise.all(places.roots.map((root) => realpath(root).catch(() => null)));
  if (!roots.some((root) => root !== null && inside(root, real))) {
    const leads = real === named ? "" : `, which leads to ${real},`;
    return refused(
      "outside",
      `${file}${leads} is outside your worktree, your home, and the system temp folder, the places an image may be uploaded from`,
    );
  }
  let handle: FileHandle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return refused("missing", `${file} cannot be read on this runner`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return refused("not_image", `${file} is not a file`);
    }
    if (stats.size > readLimit) {
      return refused(
        "too_big",
        `${file} is ${stats.size} bytes, over the ${readLimit} read for an image of at most ${limit} without its metadata`,
      );
    }
    // One byte past the limit tells a file that grew since it was measured.
    const buffer = Buffer.alloc(readLimit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) {
        break;
      }
      size += bytesRead;
    }
    if (size > readLimit) {
      return refused(
        "too_big",
        `${file} is over the ${readLimit} bytes read for an image of at most ${limit} without its metadata`,
      );
    }
    const bytes = buffer.subarray(0, size);
    const type = imageTypeOf(bytes);
    if (type === null) {
      return refused(
        "not_image",
        looksLikeSvg(bytes)
          ? `${file} is an SVG, which is not taken since it can carry script; save it as a PNG`
          : `${file} is not a PNG, JPEG, GIF, or WebP image by its first bytes, whatever its name says`,
      );
    }
    const kept = withoutMetadata(bytes);
    if (kept === null) {
      return refused(
        "not_image",
        `${file} does not read to its end as a ${IMAGE_KIND_NAMES[type]}, so its metadata cannot be told from its picture; save it again and upload that copy`,
      );
    }
    if (kept.byteLength > limit) {
      return refused(
        "too_big",
        `${file} is ${kept.byteLength} bytes without its metadata, over the ${limit} an image may be`,
      );
    }
    return {
      kind: "image",
      type,
      size: kept.byteLength,
      content: Buffer.from(kept.buffer, kept.byteOffset, kept.byteLength).toString("base64"),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Where the images a turn opens with `read_image` go: a folder of the turn's own in the system
 * temp folder, made at its first image and removed when the turn ends. Never the turn's worktree,
 * whose files the runner commits to a task's branch, nor its citizen's home, which is kept in git
 * and shared.
 */
export class TurnImageFolders {
  private readonly folders = new Map<string, Promise<string>>();

  /** Writes an image the board sent for a turn, as `<id>.<extension>`, and answers its path. */
  async write(image: TurnImageWrite): Promise<string> {
    let folder = this.folders.get(image.turnId);
    if (folder === undefined) {
      folder = mkdtemp(path.join(tmpdir(), `stellaris-images-${image.turnId}-`));
      this.folders.set(image.turnId, folder);
    }
    const file = path.join(await folder, `${image.id}.${IMAGE_EXTENSIONS[image.type]}`);
    await writeFile(file, Buffer.from(image.content, "base64"));
    return file;
  }

  /** Removes a turn's folder and every image in it, if it had any. */
  async remove(turnId: string): Promise<void> {
    const folder = this.folders.get(turnId);
    if (folder === undefined) {
      return;
    }
    this.folders.delete(turnId);
    await rm(await folder, { recursive: true, force: true });
  }
}
