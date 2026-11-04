import { z } from "zod";
import { UlidSchema } from "./ids.js";

/**
 * Images a citizen uploads with `upload_image`, where the runner its turn runs on reads the file,
 * and the user posts from a composer as its bytes: the board keeps them, and a post shows one as
 * `![what it shows](image:<id>)`. A citizen opens one with `read_image`, which has the runner its
 * turn runs on write the bytes to a file of the turn's own.
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

/**
 * The path of an image file on the machine a turn runs on, as `upload_image` takes it and the
 * runner is asked for it: one schema for both, so a path the verb takes is never one the runner's
 * stream refuses, which would leave the call waiting for an answer that never comes.
 */
export const ImagePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), { message: "a path with no NUL character" });

/**
 * The file name of an image the user posts from a composer, sent beside its bytes as
 * `POST /api/images?name=…`, which becomes the image's description in the markdown answered.
 */
export const ImageNameSchema = z.string().max(1024);

/**
 * A file's name as an image's description in markdown: no brackets, backslashes, or line breaks,
 * which would end the description, and no backticks, which would open a code span that a later one
 * in the post closes, so the image never renders.
 */
export function imageDescription(name: string): string {
  return name.replaceAll(/[[\]\\\r\n`]/g, "");
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

/**
 * An uploaded image as `read_image` takes it: its id, or the `image:<id>` address a post shows it
 * by, as a citizen copies it from the markdown. A pattern rather than a transform, so the tool's
 * schema says it; `imageIdOf` takes the id out.
 */
export const ImageRefSchema = z
  .string()
  .regex(/^(?:image:)?[0-9A-HJKMNP-TV-Z]{26}$/, "expected an image's id or image:<id>");

/** The id an image reference names, with or without its `image:`. */
export function imageIdOf(ref: string): string {
  return ref.startsWith(IMAGE_SCHEME) ? ref.slice(IMAGE_SCHEME.length) : ref;
}

/** The extension the file `read_image` writes takes for each kind, so a reader tells it by name too. */
export const IMAGE_EXTENSIONS: Readonly<Record<ImageType, string>> = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
};

/**
 * What `read_image` answers: the image's id, kind, and size, and the file holding its bytes on the
 * machine the calling turn runs on, which the turn opens with its own file tools.
 */
export const ImageFileSchema = z.object({
  id: UlidSchema,
  type: ImageTypeSchema,
  size: z.number().int().positive(),
  path: ImagePathSchema,
});
export type ImageFile = z.infer<typeof ImageFileSchema>;

/**
 * What `upload_image` and `POST /api/images` answer: the image's id and the markdown that shows it
 * in a post.
 */
export const UploadedImageSchema = z.object({
  id: UlidSchema,
  type: ImageTypeSchema,
  size: z.number().int().positive(),
  markdown: z.string(),
});
export type UploadedImage = z.infer<typeof UploadedImageSchema>;
