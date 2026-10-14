import { z } from "zod";
import { UlidSchema } from "./ids.js";

/**
 * Images a citizen uploads with `upload_image`: the runner its turn runs on reads the file, the
 * board keeps the bytes, and a post shows it as `![what it shows](image:<id>)`.
 */

/** The largest image the board takes. */
export const IMAGE_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * The kinds of image the board takes, told by their first bytes, never by a file's name. SVG is
 * not one: it is a document that can carry script.
 */
export const ImageTypeSchema = z.enum(["png", "jpeg", "gif", "webp"]);
export type ImageType = z.infer<typeof ImageTypeSchema>;

export const IMAGE_MEDIA_TYPES: Readonly<Record<ImageType, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function startsWith(bytes: Uint8Array, prefix: ArrayLike<number>, at = 0): boolean {
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[at + index] !== prefix[index]) {
      return false;
    }
  }
  return true;
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The kind of image the bytes hold by their header, or null for anything else, SVG included. */
export function imageTypeOf(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "jpeg";
  }
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return "gif";
  }
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return "webp";
  }
  return null;
}

/** How an uploaded image is written in a post's markdown: `image:` and its id. */
export const IMAGE_SCHEME = "image:";

/** The id an `image:<id>` address names, or null for any other address. */
export function uploadedImageId(href: string): string | null {
  if (!href.startsWith(IMAGE_SCHEME)) {
    return null;
  }
  const id = href.slice(IMAGE_SCHEME.length);
  return UlidSchema.safeParse(id).success ? id : null;
}

/** What `upload_image` answers: the image's id and the markdown that shows it in a post. */
export const UploadedImageSchema = z.object({
  id: UlidSchema,
  type: ImageTypeSchema,
  size: z.number().int().positive(),
  markdown: z.string(),
});
export type UploadedImage = z.infer<typeof UploadedImageSchema>;
