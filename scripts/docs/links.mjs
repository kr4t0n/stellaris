// Reads markdown the way GitHub renders it, as far as the link check needs: each file's relative
// links and the anchors it offers, its headings' made by GitHub's rule. A hand-written reader, not a
// markdown parser, so it knows only what the repository's docs write: ATX headings, also in lists
// and quotes, fences, code spans, escapes, inline links and images, reference definitions, and raw
// HTML's headings, `href`, `src`, `id`, and `name`. What it knows it can't read gives no anchor, so
// a link to it fails rather than passes: a setext heading; a heading or an `id` that holds a named
// character reference other than the six in `ENTITIES`, which GitHub reads by HTML's whole table;
// and a heading whose text leaves nothing for an anchor, which GitHub anchors as `""`, `-1`, and so
// on, or not at all, by the file's other headings. It doesn't know an indented code block or an
// HTML block, so a `#` line in one reads as a heading, nor a bare `www.` address GitHub links.
import { readFileSync } from "node:fs";
import path from "node:path";

const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/u;
const WHITESPACE = /^\s$/u;
// cmark-gfm takes ASCII punctuation and Unicode's, but not its other symbols, such as `€` or `→`,
// as punctuation beside an underscore, where CommonMark 0.31 takes all of them.
const PUNCTUATION = /^[\p{P}!-/:-@[-`{-~]$/u;
// GitHub keeps a heading's word characters (Unicode's `\w`, as Ruby's `\p{Word}` reads it), hyphens,
// and spaces, which become hyphens; it drops everything else, other numbers such as `½` and the
// non-breaking space among them.
const NOT_IN_ANCHOR = /[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control} -]/gu;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

/** The anchor GitHub makes from a heading's text, before telling repeated headings apart. */
export function slug(text) {
  // One code point at a time: a whole string lowercases a final sigma as `ς`, where GitHub keeps `σ`.
  const lower = Array.from(text, (character) => character.toLowerCase()).join("");
  return lower.replace(NOT_IN_ANCHOR, "").replaceAll(" ", "-");
}

/** Tells a file's repeated headings apart as GitHub does: `a`, `a-1`, `a-2`, never one taken. */
export class Slugger {
  #occurrences = new Map();

  slug(text) {
    const base = slug(text);
    let result = base;
    while (this.#occurrences.has(result)) {
      const count = this.#occurrences.get(base) + 1;
      this.#occurrences.set(base, count);
      result = `${base}-${count}`;
    }
    this.#occurrences.set(result, 0);
    return result;
  }
}

/** Splits inline markdown into plain text and what GitHub reads literally or as HTML. */
function tokenize(text) {
  const tokens = [];
  let at = 0;
  let textStart = 0;
  const push = (token) => {
    if (token.start > textStart) tokens.push({ kind: "text", start: textStart, end: token.start });
    tokens.push(token);
    at = token.end;
    textStart = at;
  };
  while (at < text.length) {
    const character = text[at];
    if (character === "\\" && ASCII_PUNCTUATION.test(text[at + 1] ?? "")) {
      push({ kind: "escape", start: at, end: at + 2, value: text[at + 1] });
    } else if (character === "`") {
      const open = text.slice(at).match(/^`+/u)[0].length;
      const close = closingBackticks(text, at + open, open);
      if (close === -1) at += open;
      else
        push({
          kind: "code",
          start: at,
          end: close + open,
          value: codeText(text.slice(at + open, close)),
        });
    } else if (character === "<") {
      const token = angleToken(text, at);
      if (token) push(token);
      else at += 1;
    } else {
      at += 1;
    }
  }
  if (text.length > textStart) tokens.push({ kind: "text", start: textStart, end: text.length });
  return tokens;
}

function closingBackticks(text, from, length) {
  const runs = /`+/gu;
  runs.lastIndex = from;
  for (let run = runs.exec(text); run; run = runs.exec(text)) {
    if (run[0].length === length) return run.index;
  }
  return -1;
}

function codeText(raw) {
  const value = raw.replaceAll("\n", " ");
  return /^ .*[^ ].* $/su.test(value) ? value.slice(1, -1) : value;
}

function angleToken(text, at) {
  const rest = text.slice(at);
  if (rest.startsWith("<!--")) {
    const end = text.indexOf("-->", at + 4);
    return end === -1 ? undefined : { kind: "comment", start: at, end: end + 3 };
  }
  const autolink = rest.match(/^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/u);
  if (autolink)
    return { kind: "autolink", start: at, end: at + autolink[0].length, value: autolink[1] };
  const tag = rest.match(
    /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/u,
  );
  return tag ? { kind: "html", start: at, end: at + tag[0].length, value: tag[0] } : undefined;
}

function attributes(tag) {
  const found = new Map();
  for (const [, name, double, single, bare] of tag.matchAll(
    /\s([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu,
  )) {
    found.set(name.toLowerCase(), double ?? single ?? bare);
  }
  return found;
}

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]*));/gu;

function decodeEntities(text) {
  return text.replace(ENTITY, decodeEntity);
}

/** Whether `text` holds a named character reference outside `ENTITIES`, which it can't decode. */
function unreadable(text) {
  return [...text.matchAll(ENTITY)].some(([, , , name]) => name && !Object.hasOwn(ENTITIES, name));
}

function decodeEntity(whole, dec, hex, name) {
  if (!dec && !hex) return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : whole;
  // As CommonMark reads one: no code point, a surrogate, or zero is the replacement character.
  const code = Number.parseInt(dec ?? hex, dec ? 10 : 16);
  const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return String.fromCodePoint(valid ? code : 0xfffd);
}

/**
 * The text GitHub reads from a heading's inline markdown: code spans and escapes as written, links'
 * text without their destinations, no images, no HTML tags or comments, entities decoded, and no
 * emphasis marks. Spaces next to what is dropped stay, as on GitHub. Undefined when the text holds
 * a named character reference outside `ENTITIES`. `defined` holds the file's reference labels, as
 * `labelOf` gives them; without it every reference counts as defined.
 */
export function headingText(markdown, defined) {
  // Each character keeps what it came from: only plain text's can be markup, and a flanking check
  // sees the source beside it, as CommonMark's does: a code span's backtick, an entity's `&` or `;`,
  // and the `<` or `)` of anything dropped, by an empty character in its place.
  const characters = [];
  const literal = (text, edge, unknown) => {
    for (const character of text) characters.push({ character, markup: false, edge, unknown });
  };
  for (const token of tokenize(markdown)) {
    if (token.kind === "text") {
      // What an entity spells is text, never markup.
      let at = token.start;
      for (const match of markdown.slice(token.start, token.end).matchAll(ENTITY)) {
        for (const character of markdown.slice(at, token.start + match.index)) {
          characters.push({ character, markup: true });
        }
        literal(decodeEntity(...match), ";", unreadable(match[0]));
        at = token.start + match.index + match[0].length;
      }
      for (const character of markdown.slice(at, token.end)) {
        characters.push({ character, markup: true });
      }
    } else if (token.kind === "code" || token.kind === "escape") {
      literal(token.value, token.kind === "code" ? "`" : undefined);
    } else if (token.kind === "autolink") {
      literal(token.value, "<");
    } else {
      const raw = markdown.slice(token.start, token.end);
      characters.push({ character: "", markup: false, edge: "<", raw });
    }
  }
  const kept = emphasisRemoved(destinationsRemoved(characters, defined));
  if (kept.some(({ unknown }) => unknown)) return undefined;
  return kept.map(({ character }) => character).join("");
}

// Drops each link's destination and each image whole, closing brackets as cmark's
// `handle_close_bracket` does. A `]` takes the nearest `[` still open, which is spent either way.
// It makes an inline link when a destination GitHub reads follows, else a reference: a full one by
// its label, or a collapsed or shortcut one by the text, unless another `[` opened inside it. A
// label counts only when the file defines it. Once a link forms, the `[` before it, but an image's,
// open nothing more, since a link holds no link. What makes no link stays text.
function destinationsRemoved(characters, defined) {
  const isDefined = (label) => defined === undefined || defined.has(labelOf(label));
  const text = (from, to) =>
    characters
      .slice(from, to)
      .map(({ character }) => character)
      .join("");
  const is = (at, character) =>
    characters[at]?.markup === true && characters[at].character === character;
  const result = [];
  for (let index = 0; index < characters.length; index += 1) {
    const entry = characters[index];
    if (is(index, "[")) {
      const below = lastOpenBracket(result);
      if (below !== -1) result[below].bracketAfter = true;
      const previous = result.at(-1);
      const image = previous?.markup === true && previous.character === "!";
      result.push({ ...entry, opener: true, image });
      continue;
    }
    const open = is(index, "]") ? lastOpenBracket(result) : -1;
    if (open === -1) {
      result.push(entry);
      continue;
    }
    const opener = result[open];
    result[open] = { ...opener, markup: false, spent: true };
    let end = -1;
    if (!opener.inactive) {
      end = is(index + 1, "(") ? inlineEnd(characters, index + 1) : -1;
      if (end === -1) {
        const close = is(index + 1, "[") ? labelEnd(characters, index + 1) : -1;
        const label = close === -1 ? "" : text(index + 2, close);
        const shown = result
          .slice(open + 1)
          .map(({ character }) => character)
          .join("");
        const byText = (close === -1 || label === "") && !opener.bracketAfter;
        if (label !== "" ? isDefined(label) : byText && isDefined(shown)) {
          end = close === -1 ? index : close;
        }
      }
    }
    if (end === -1) {
      result.push(entry);
      continue;
    }
    if (opener.image) {
      // An image's alt text is no part of the heading's text, as GitHub reads it.
      result.length = open - 1;
    } else {
      for (const earlier of result) if (earlier.opener && !earlier.image) earlier.inactive = true;
    }
    result.push({ character: "", markup: false, edge: characters[end].character });
    index = end;
  }
  return result;
}

function lastOpenBracket(characters) {
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    if (characters[index].opener && !characters[index].spent) return index;
  }
  return -1;
}

/** Where a reference's label, opened by the `[` at `at`, ends: its `]`, or -1 when it has none. */
function labelEnd(characters, at) {
  for (let index = at + 1; index < characters.length && index - at <= 1000; index += 1) {
    const { character, markup } = characters[index];
    if (markup && character === "[") return -1;
    if (markup && character === "]") return index;
  }
  return -1;
}

/**
 * Where an inline link's destination and title, opened by the `(` at `at`, end: the `)`, or -1
 * when GitHub would read none there. A bare destination ends at a space or an unmatched `)`,
 * and its parentheses need not balance before a space, as GitHub's cmark-gfm reads them.
 */
function inlineEnd(characters, at) {
  const is = (index, set) =>
    characters[index]?.markup === true && set.includes(characters[index].character);
  const spaces = (from) => {
    let index = from;
    while (is(index, " \t\n")) index += 1;
    return index;
  };
  let index = spaces(at + 1);
  if (characters[index]?.raw !== undefined) {
    // An HTML tag or comment where the destination starts is one in angle brackets.
    index += 1;
  } else if (is(index, "<")) {
    index += 1;
    while (index < characters.length && !is(index, "<>\n")) index += 1;
    if (!is(index, ">")) return -1;
    index += 1;
  } else {
    let depth = 0;
    for (; index < characters.length && !is(index, " \t\n"); index += 1) {
      // A tag's space ends the destination too, and an attribute, not a title or `)`, follows it.
      if (/\s/u.test(characters[index].raw ?? "")) return -1;
      if (is(index, "(") && ++depth > 32) return -1;
      if (is(index, ")") && depth-- === 0) break;
    }
    if (index === characters.length) return -1;
  }
  const title = spaces(index);
  if (title > index && is(title, `"'(`)) {
    const close = characters[title].character === "(" ? ")" : characters[title].character;
    index = title + 1;
    while (index < characters.length && !is(index, close)) index += 1;
    if (index === characters.length) return -1;
    index += 1;
  }
  index = spaces(index);
  return is(index, ")") ? index : -1;
}

// `*` and `~` leave no trace in an anchor, but `_` is a word character: an underscore that marks
// emphasis is dropped, and one inside a word or between a pair of `*` is kept. So the runs of both
// go through CommonMark's delimiter algorithm (`process_emphasis` in its spec), which pairs them.
function emphasisRemoved(characters) {
  const runs = [];
  for (let index = 0; index < characters.length;) {
    const { character, markup } = characters[index];
    if (!(markup && (character === "_" || character === "*"))) {
      index += 1;
      continue;
    }
    let end = index;
    while (characters[end]?.markup && characters[end].character === character) end += 1;
    const before =
      besideTilde(characters, index - 1, -1) ?? neighbour(characters[index - 1], "end");
    const after = besideTilde(characters, end, 1) ?? neighbour(characters[end], "start");
    const left =
      !isSpace(after) && (!isPunctuation(after) || isSpace(before) || isPunctuation(before));
    const right =
      !isSpace(before) && (!isPunctuation(before) || isSpace(after) || isPunctuation(after));
    const underscore = character === "_";
    // A run spends its characters from the inside: a closer from its left end, an opener from
    // its right, so `low` and `high` bound what it has left.
    runs.push({
      character,
      low: index,
      high: end,
      length: end - index,
      opens: underscore ? left && (!right || isPunctuation(before)) : left,
      closes: underscore ? right && (!left || isPunctuation(after)) : right,
      active: true,
    });
    index = end;
  }
  const dropped = new Set();
  const bottoms = new Map();
  for (let current = 0; current < runs.length;) {
    const closer = runs[current];
    if (!closer.active || !closer.closes) {
      current += 1;
      continue;
    }
    const key = `${closer.character}${closer.opens}${closer.length % 3}`;
    let found = -1;
    for (let at = current - 1; at > (bottoms.get(key) ?? -1); at -= 1) {
      const opener = runs[at];
      if (!opener.active || !opener.opens || opener.character !== closer.character) continue;
      // The rule of 3: where either run could both open and close, their lengths may not sum to a
      // multiple of 3 unless both are one.
      const both = opener.closes || closer.opens;
      const sum = opener.length + closer.length;
      if (both && sum % 3 === 0 && !(opener.length % 3 === 0 && closer.length % 3 === 0)) continue;
      found = at;
      break;
    }
    if (found === -1) {
      bottoms.set(key, current - 1);
      if (!closer.opens) closer.active = false;
      current += 1;
      continue;
    }
    const opener = runs[found];
    const used = opener.high - opener.low >= 2 && closer.high - closer.low >= 2 ? 2 : 1;
    for (let k = 0; k < used; k += 1) {
      opener.high -= 1;
      dropped.add(opener.high);
      dropped.add(closer.low);
      closer.low += 1;
    }
    // Whatever runs sit between a pair are text from then on.
    for (let at = found + 1; at < current; at += 1) runs[at].active = false;
    if (opener.high === opener.low) opener.active = false;
    if (closer.high === closer.low) {
      closer.active = false;
      current += 1;
    }
  }
  return characters.filter((_, index) => !dropped.has(index));
}

// GitHub's cmark-gfm judges a run beside a run of `~` by what is on the tildes' other side, as if
// they weren't there: `~~d~~_u_` keeps its underscores, `~_x_` doesn't, and in `_a ~_` the second
// underscore can't close.
function besideTilde(characters, from, step) {
  let at = from;
  while (characters[at]?.markup && characters[at].character === "~") at += step;
  if (at === from) return undefined;
  return neighbour(characters[at], step < 0 ? "end" : "start");
}

function neighbour(entry, side) {
  if (!entry) return " ";
  return entry.edge ?? (side === "end" ? entry.character.at(-1) : entry.character[0]);
}

function isSpace(character) {
  return WHITESPACE.test(character);
}

function isPunctuation(character) {
  return PUNCTUATION.test(character);
}

/** A reference label as CommonMark matches one: case folded, its whitespace collapsed. */
function labelOf(label) {
  return label.trim().replace(/\s+/gu, " ").toUpperCase().toLowerCase();
}

/** A line's container marks, a quote's `>` or a list item's marker, before what it holds. */
const CONTAINER = String.raw`^[ \t]*(?:>[ \t]?)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?`;
const FENCE = new RegExp(`${CONTAINER}(\`{3,}|~{3,})(.*)$`, "u");
const HEADING = new RegExp(`${CONTAINER}(#{1,6})(?:[ \\t]+(.*))?$`, "u");
const DEFINITION = new RegExp(`${CONTAINER}\\[((?:[^\\]\\\\]|\\\\.)+)\\]:`, "u");

/**
 * A markdown file's anchors (its headings', raw HTML's among them, told apart as GitHub does, and
 * raw HTML's `id` and `name`) and the destinations of its links and images, each with its line.
 */
export function readMarkdown(source) {
  const found = { anchors: new Set(), links: [], slugger: new Slugger() };
  const lines = source.split(/\r?\n/u);
  // A heading's reference links are links only when the file defines their labels, anywhere in it.
  const defined = new Set();
  let inFence;
  for (const line of lines) {
    if (inFence) {
      if (new RegExp(`${CONTAINER}${inFence}`, "u").test(line)) inFence = undefined;
      continue;
    }
    const open = line.match(FENCE);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      inFence = `${open[1][0]}{${open[1].length},}[ \\t]*$`;
      continue;
    }
    const definition = line.match(DEFINITION);
    if (definition) defined.add(labelOf(definition[1]));
  }
  let fence;
  let block = [];
  let blockStart = 0;
  const flush = () => {
    if (block.length > 0) readBlock(block.join("\n"), blockStart, found);
    block = [];
  };
  lines.forEach((line, index) => {
    if (fence) {
      const close = line.match(
        new RegExp(`${CONTAINER}${fence.marker}{${fence.length},}[ \\t]*$`, "u"),
      );
      if (close) fence = undefined;
      return;
    }
    const open = line.match(FENCE);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      flush();
      fence = { marker: open[1][0], length: open[1].length };
      return;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      // CommonMark strips spaces and tabs from a heading's ends, before the closing hashes too.
      const content = (heading[2] ?? "")
        .replace(/(?:^|[ \t]+)#+[ \t]*$/u, "")
        .replace(/[ \t]+$/u, "");
      addHeading(found, headingText(content, defined));
      readBlock(line, index, found);
      return;
    }
    if (line.trim() === "") {
      flush();
      return;
    }
    if (block.length === 0) blockStart = index;
    block.push(line);
  });
  flush();
  return { anchors: found.anchors, links: found.links };
}

/** Anchors a heading, unless its text was unreadable or leaves nothing for an anchor. */
function addHeading({ anchors, slugger }, text) {
  if (text === undefined) return;
  const anchor = slugger.slug(text);
  if (slug(text) !== "") anchors.add(anchor);
}

/** Reads one block's links and HTML anchors, leaving code, escapes, and comments alone. */
function readBlock(text, firstLine, found) {
  const { anchors, links } = found;
  const lineOf = (offset) => firstLine + 1 + (text.slice(0, offset).match(/\n/gu)?.length ?? 0);
  let masked = "";
  for (const token of tokenize(text)) {
    const raw = text.slice(token.start, token.end);
    masked += token.kind === "text" || token.kind === "html" ? raw : raw.replace(/[^\n]/gu, " ");
    if (token.kind !== "html") continue;
    const values = attributes(token.value);
    for (const name of ["href", "src"]) {
      if (values.has(name)) {
        links.push({ line: lineOf(token.start), target: decodeEntities(values.get(name)) });
      }
    }
    for (const name of ["id", "name"]) {
      if (values.has(name) && !unreadable(values.get(name))) {
        anchors.add(decodeEntities(values.get(name)));
      }
    }
    // GitHub makes an anchor for a heading written in HTML too, from its text, ends and all.
    const level = token.value.match(/^<h([1-6])[\s>]/iu)?.[1];
    const close = level ? text.slice(token.end).search(new RegExp(`</h${level}\\s*>`, "iu")) : -1;
    if (close !== -1) {
      const inner = text.slice(token.end, token.end + close).replace(/<!--.*?-->|<[^>]*>/gsu, "");
      addHeading(found, unreadable(inner) ? undefined : decodeEntities(inner));
    }
  }
  for (const match of masked.matchAll(/\]\([ \t]*\n?[ \t]*/gu)) {
    if (!opened(masked, match.index)) continue;
    const target = destination(text, match.index + match[0].length);
    if (target !== undefined) links.push({ line: lineOf(match.index), target });
  }
  // A definition may sit in a list item or a quote too.
  const definition = new RegExp(
    `${CONTAINER}\\[(?!\\^)(?:[^\\]\\\\\\n]|\\\\.)+\\]:[ \\t]*\\n?[ \\t]*`,
    "gmu",
  );
  for (const match of masked.matchAll(definition)) {
    const target = destination(text, match.index + match[0].length);
    if (target !== undefined) links.push({ line: lineOf(match.index), target });
  }
}

/** Whether the `]` at `close` ends a link's text: an unescaped `[` before it opened one. */
function opened(masked, close) {
  let depth = 0;
  for (let at = close - 1; at >= 0; at -= 1) {
    if (masked[at] === "]") depth += 1;
    else if (masked[at] === "[" && depth-- === 0) return true;
  }
  return false;
}

/** A link destination starting at `at`: `<…>`, or up to whitespace or an unbalanced `)`. */
function destination(text, at) {
  if (text[at] === "<") {
    const end = text.slice(at + 1).search(/[<>\n]/u);
    return end === -1 || text[at + 1 + end] !== ">"
      ? undefined
      : unescape(text.slice(at + 1, at + 1 + end));
  }
  let depth = 0;
  let end = at;
  for (; end < text.length; end += 1) {
    const character = text[end];
    if (character === "\\" && ASCII_PUNCTUATION.test(text[end + 1] ?? "")) end += 1;
    else if (/\s/u.test(character)) break;
    else if (character === "(") depth += 1;
    else if (character === ")" && depth-- === 0) break;
  }
  return unescape(text.slice(at, end));
}

function unescape(raw) {
  return decodeEntities(raw.replace(/\\([!-/:-@[-`{-~])/gu, "$1"));
}

/**
 * Checks every relative link in `markdown` against `files`, the repository's files by their paths
 * from `root` with `/`: each must name a file or folder there, and its `#anchor`, when it names a
 * markdown file or a folder with a README, one of that file's anchors. Web addresses and other
 * schemes are left alone. Returns what failed, and the counts of what was checked.
 */
export function checkLinks(root, files, markdown) {
  const present = new Set(files);
  const folders = new Set([""]);
  for (const file of files) {
    for (
      let folder = path.posix.dirname(file);
      folder !== ".";
      folder = path.posix.dirname(folder)
    ) {
      folders.add(folder);
    }
  }
  const read = new Map();
  const anchorsOf = (file) => {
    if (!read.has(file)) read.set(file, readMarkdown(readFileSync(path.join(root, file), "utf8")));
    return read.get(file).anchors;
  };
  const problems = [];
  let links = 0;
  let anchors = 0;
  for (const file of markdown) {
    anchorsOf(file);
    for (const { line, target } of read.get(file).links) {
      if (target === "" || target.startsWith("//") || SCHEME.test(target)) continue;
      links += 1;
      const report = (problem) => problems.push({ file, line, target, problem });
      const hash = target.indexOf("#");
      const address = (hash === -1 ? target : target.slice(0, hash)).replace(/\?.*$/su, "");
      let named;
      let fragment;
      try {
        named = decodeURIComponent(address);
        fragment = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
      } catch {
        report("is not a valid address");
        continue;
      }
      const resolved =
        named === ""
          ? file
          : path.posix.normalize(
              named.startsWith("/")
                ? named.slice(1)
                : path.posix.join(path.posix.dirname(file), named),
            );
      const where = resolved.replace(/\/+$/u, "").replace(/^\.$/u, "");
      if (where === ".." || where.startsWith("../")) {
        report("leaves the repository");
        continue;
      }
      const isFile = present.has(where);
      if (!isFile && !folders.has(where)) {
        report(`names ${where}, which does not exist`);
        continue;
      }
      if (fragment === undefined || fragment === "") continue;
      const page = isFile ? where : path.posix.join(where, "README.md");
      if (!/\.md$/iu.test(page) || !present.has(page)) continue;
      anchors += 1;
      if (!anchorsOf(page).has(fragment)) report(`names no heading or anchor in ${page}`);
    }
  }
  return { problems, links, anchors };
}
