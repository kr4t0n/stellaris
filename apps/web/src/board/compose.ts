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

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

export function listed(names: readonly string[]): string {
  return LIST.format(names);
}
