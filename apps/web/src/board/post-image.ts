import {
  IMAGE_KIND_NAMES,
  IMAGE_LIMIT_BYTES,
  IMAGE_MEDIA_TYPES,
  imageTypeOf,
} from "@stellaris/shared";
import { withoutMetadata } from "@stellaris/shared/image-metadata";
import { ApiError } from "../lib/api.js";

/** The longest side, in pixels, a picture the composer draws again starts at, as the app's does. */
const LARGEST_SIDE = 4096;

/** The longest side below which a picture is not drawn smaller again. */
const SMALLEST_SIDE = 32;

/** The quality of a JPEG drawn again, at which a photo keeps its detail, as the app's. */
const JPEG_QUALITY = 0.85;

/**
 * What the composer posts for `file`, named `name`: an image without its metadata, such as where,
 * when, and with what a photo was taken, so none of it leaves the browser. A PNG, JPEG, GIF, or
 * WebP that reads to its end and fits the limit without its metadata goes in its kind, its
 * pictures byte for byte (`withoutMetadata`). One that doesn't read to its end, or is still past
 * the limit, goes as a JPEG of its picture drawn again upright by the browser, scaled down until
 * it fits, as the app's `ComposerImage.prepare` does, so an animation keeps its first frame alone.
 * Anything else goes as it is, for the board to refuse in its own words, unless it is past the
 * limit, which is refused here without being sent. A refusal is an `ApiError`, as the board's is.
 */
export async function imageToPost(
  file: Blob,
  name: string,
  limit = IMAGE_LIMIT_BYTES,
): Promise<Blob> {
  const type = imageTypeOf(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  if (type === null) {
    if (file.size > limit) {
      throw new ApiError(413, `${name} is ${file.size} bytes, over the ${limit} an image may be`);
    }
    return file;
  }
  const kept = withoutMetadata(new Uint8Array(await file.arrayBuffer()));
  if (kept !== null && kept.byteLength <= limit) {
    return new Blob([kept], { type: IMAGE_MEDIA_TYPES[type] });
  }
  const drawn = await drawnAgain(file, limit);
  if (drawn !== null) {
    return drawn;
  }
  throw kept === null
    ? new ApiError(
        400,
        `${name} does not read as a ${IMAGE_KIND_NAMES[type]}; save it again and send that copy`,
      )
    : new ApiError(
        413,
        `${name} is ${kept.byteLength} bytes without its metadata, over the ${limit} an image may be`,
      );
}

/**
 * The sizes a picture `width` by `height` pixels is drawn again at, in turn, until one fits: at
 * most `LARGEST_SIDE` pixels on its longest side and never larger than it is, then 0.7 times the
 * last one's longest side, down to `SMALLEST_SIDE`, as the app's `prepare` steps.
 */
export function drawnSizes(
  width: number,
  height: number,
): Array<{ width: number; height: number }> {
  const sizes: Array<{ width: number; height: number }> = [];
  const longest = Math.max(width, height);
  let side = LARGEST_SIDE;
  while (side >= SMALLEST_SIDE) {
    const scale = Math.min(1, side / longest);
    const size = {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
    sizes.push(size);
    side = Math.trunc(Math.max(size.width, size.height) * 0.7);
  }
  return sizes;
}

/**
 * The picture `file` holds, drawn again upright as a JPEG at each of its `drawnSizes` until one
 * fits `limit`, with what the browser wrote beside the picture left out too; null when the
 * browser can't draw it, or it fits at no size. Decoded by an image element, which draws what a
 * file cut short holds, where `createImageBitmap` refuses it.
 */
async function drawnAgain(file: Blob, limit: number): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const picture = new Image();
    picture.src = url;
    try {
      await picture.decode();
    } catch {
      return null;
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) {
      return null;
    }
    for (const size of drawnSizes(picture.naturalWidth, picture.naturalHeight)) {
      canvas.width = size.width;
      canvas.height = size.height;
      // Sizing a canvas resets its context.
      context.imageSmoothingQuality = "high";
      context.drawImage(picture, 0, 0, size.width, size.height);
      const jpeg = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY);
      });
      if (jpeg === null) {
        return null;
      }
      const bytes = new Uint8Array(await jpeg.arrayBuffer());
      const kept = withoutMetadata(bytes) ?? bytes;
      if (kept.byteLength <= limit) {
        return new Blob([kept], { type: IMAGE_MEDIA_TYPES.jpeg });
      }
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
