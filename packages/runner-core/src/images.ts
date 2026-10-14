import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  IMAGE_LIMIT_BYTES,
  imageTypeOf,
  type ImageRefusal,
  type TurnImage,
} from "@stellaris/shared";

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
 * The image a turn names for `upload_image`, or why it is refused. The path is resolved with every
 * link followed before it is placed, so a link inside a root cannot lead out of it, and the file
 * is opened without following a link and without waiting on a pipe. Only a regular file whose
 * first bytes are a PNG's, a JPEG's, a GIF's, or a WebP's, of at most `limit` bytes, is read.
 */
export async function readTurnImage(
  file: string,
  places: ImagePlaces,
  limit = IMAGE_LIMIT_BYTES,
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
    if (stats.size > limit) {
      return refused(
        "too_big",
        `${file} is ${stats.size} bytes, over the ${limit} an image may be`,
      );
    }
    // One byte past the limit tells a file that grew since it was measured.
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) {
        break;
      }
      size += bytesRead;
    }
    if (size > limit) {
      return refused("too_big", `${file} is over the ${limit} bytes an image may be`);
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
    return { kind: "image", type, size, content: bytes.toString("base64") };
  } finally {
    await handle.close();
  }
}
