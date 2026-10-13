// An entry of its own, `@stellaris/shared/mentions`, so importing the schemas never brings the
// markdown parser along.
import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";
import type { Name } from "./ids.js";

/**
 * `@name` not inside a word or an address. Global, so use it with `matchAll`, `replaceAll`, or
 * `search`, which leave its `lastIndex` alone.
 */
export const MENTION_PATTERN = /(^|[^\w@])@([a-z0-9][a-z0-9-]{0,31})(?![\w-])/g;

/** The tokens that show text as written: a code span, a fenced code block, an indented one. */
const CODE = new Set(["codeText", "codeFenced", "codeIndented"]);

/**
 * GFM constructs left out because each makes the parse superlinear on ordinary text and tells no
 * code apart: an autolink literal is tried at every character, and a footnote call walks back over
 * its paragraph at every `]`. Without literals, a backtick right after a bare URL opens a code span,
 * as on GitHub, where the interface keeps it in the link.
 */
const SLOW = {
  disable: {
    null: [
      "wwwAutolink",
      "protocolAutolink",
      "emailAutolink",
      "gfmFootnoteCall",
      "gfmPotentialFootnoteCall",
    ],
  },
};

/**
 * Where a post's code is, as start and end offsets in document order. Parsed by micromark with
 * GFM, as the interface renders posts, so a name the interface shows as code never counts.
 */
function codeRanges(markdown: string): [number, number][] {
  // micromark drops a leading byte order mark before it counts offsets.
  const shift = markdown.startsWith("﻿") ? 1 : 0;
  const events = postprocess(
    parse({ extensions: [gfm(), SLOW] })
      .document()
      .write(preprocess()(markdown, undefined, true)),
  );
  return events.flatMap(([kind, token]): [number, number][] =>
    kind === "enter" && CODE.has(token.type)
      ? [[token.start.offset + shift, token.end.offset + shift]]
      : [],
  );
}

function addMentions(found: Set<Name>, text: string): void {
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[2];
    if (name !== undefined) {
      found.add(name);
    }
  }
}

/** The names a post mentions, sorted: every `@name` outside code, which decides whom it wakes. */
export function mentionsIn(markdown: string): Name[] {
  if (markdown.search(MENTION_PATTERN) === -1) {
    return [];
  }
  const found = new Set<Name>();
  let from = 0;
  for (const [start, end] of codeRanges(markdown)) {
    addMentions(found, markdown.slice(from, start));
    from = end;
  }
  addMentions(found, markdown.slice(from));
  return [...found].toSorted();
}

/** Every `@name` in a text, code included, sorted: the count for a post too slow to parse. */
export function mentionsAnywhere(text: string): Name[] {
  const found = new Set<Name>();
  addMentions(found, text);
  return [...found].toSorted();
}
