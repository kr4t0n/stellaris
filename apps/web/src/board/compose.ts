import { imageDescription } from "@stellaris/shared";

/** The `@name` being typed where the caret is: where it starts and what is typed so far. */
export function mentionAt(text: string, caret: number): { start: number; prefix: string } | null {
  const match = /(^|[^\w@])@([a-z0-9-]*)$/.exec(text.slice(0, caret));
  const prefix = match?.[2];
  return prefix === undefined ? null : { start: caret - prefix.length - 1, prefix };
}

/** The text with the mention being typed completed to a name, and where the caret goes next. */
export function completeMention(
  text: string,
  caret: number,
  start: number,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  return {
    text: text.slice(0, start) + inserted + text.slice(caret),
    caret: start + inserted.length,
  };
}

/**
 * What holds an image's place in a draft while it uploads, in the words that say so, numbered from
 * the second line of one name on.
 */
export function uploadingImage(name: string, number = 1): string {
  const described = imageDescription(name);
  return number === 1 ? `![Uploading ${described}…]()` : `![Uploading ${described} (${number})…]()`;
}

/**
 * A line of its own for an upload of an image named `name`: the first numbering found neither in
 * `text` nor among `held`, the lines of uploads still on their way, so each upload fills its own
 * line even when every image pasted has the same name, as a browser names each `image.png`.
 */
export function uploadPlaceholder(name: string, text: string, held: readonly string[]): string {
  for (let number = 1; ; number += 1) {
    const line = uploadingImage(name, number);
    if (!text.includes(line) && !held.includes(line)) {
      return line;
    }
  }
}

/** The text with `inserted` in place of what is selected from `start` to `end`, and the caret after it. */
export function insertAt(
  text: string,
  start: number,
  end: number,
  inserted: string,
): { text: string; caret: number } {
  const from = Math.min(Math.max(start, 0), text.length);
  const to = Math.min(Math.max(end, from), text.length);
  return { text: text.slice(0, from) + inserted + text.slice(to), caret: from + inserted.length };
}

/**
 * The text with the first `placeholder` in it replaced by `markdown`, the image's once it is kept
 * or nothing when it was not, and the caret where it was among the text around it, or after the
 * markdown when it was inside the placeholder; null when the placeholder is gone, as when the user
 * deleted it, which leaves the upload out of the post.
 */
export function settleUpload(
  text: string,
  caret: number,
  placeholder: string,
  markdown: string,
): { text: string; caret: number } | null {
  const at = text.indexOf(placeholder);
  if (at === -1) {
    return null;
  }
  const end = at + placeholder.length;
  return {
    text: text.slice(0, at) + markdown + text.slice(end),
    caret:
      caret <= at
        ? caret
        : caret >= end
          ? caret - placeholder.length + markdown.length
          : at + markdown.length,
  };
}

/**
 * An image a draft holds, where it stands: one the board kept, by its id and description, or one
 * still uploading, by the line an upload holds. `start` and `text` place it in the draft, in UTF-16
 * code units, as the string's own indices count.
 */
export interface DraftImage {
  readonly kind: "kept" | "uploading";
  readonly start: number;
  readonly text: string;
  readonly id: string | null;
  readonly alt: string;
}

/** An uploaded image in markdown: its description, then `image:` and a ULID. */
const KEPT_IMAGE = /!\[([^\]\n]*)\]\(image:([0-9A-HJKMNP-TV-Z]{26})\)/g;

/**
 * The images a draft holds, in the order they stand in it: each uploaded image's markdown, and each
 * line in `held` an upload on its way still holds. A web image's markdown is none of them.
 */
export function draftImages(text: string, held: readonly string[]): DraftImage[] {
  const found: DraftImage[] = [];
  for (const match of text.matchAll(KEPT_IMAGE)) {
    found.push({
      kind: "kept",
      start: match.index,
      text: match[0],
      id: match[2] ?? null,
      alt: match[1] ?? "",
    });
  }
  for (const line of held) {
    const start = text.indexOf(line);
    if (start !== -1) {
      found.push({ kind: "uploading", start, text: line, id: null, alt: "" });
    }
  }
  return found.toSorted((a, b) => a.start - b.start);
}

/**
 * The draft without `image`, and the caret where it was among the text around it, or where the
 * image stood when it was inside it; the draft as it is when the image no longer stands there.
 */
export function removeDraftImage(
  text: string,
  caret: number,
  image: DraftImage,
): { text: string; caret: number } {
  const end = image.start + image.text.length;
  if (text.slice(image.start, end) !== image.text) {
    return { text, caret };
  }
  return {
    text: text.slice(0, image.start) + text.slice(end),
    caret: caret <= image.start ? caret : caret >= end ? caret - image.text.length : image.start,
  };
}

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

export function listed(names: readonly string[]): string {
  return LIST.format(names);
}
