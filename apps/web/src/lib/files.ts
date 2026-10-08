/** Where relative links in a task's file resolve: the file's folder on the task's branch. */
export interface FileBase {
  readonly taskId: string;
  readonly dir: string;
}

/**
 * What a link or an image in the board's text points at: a file on a task's branch, some other
 * place on a machine that nothing on the board can open, or, as null, an address the browser opens.
 */
export type LinkTarget =
  | { readonly kind: "task-file"; readonly taskId: string; readonly path: string }
  | { readonly kind: "local" };

const LOCAL: LinkTarget = { kind: "local" };

/**
 * A path through a task conversation's worktree on any runner, `<data>/worktrees/<agent>/.tasks/
 * <task id>/<path>`. Only the part from `worktrees/` on is read, so no runner has to say where its
 * data lives, and every holder's worktree names the same branch.
 */
const TASK_WORKTREE = /(?:^|\/)worktrees\/[^/]+\/\.tasks\/([0-9A-HJKMNP-TV-Z]{26})(?:\/(.*))?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A path's segments with `.` and `..` resolved, or null when `..` climbs out of the root. */
export function normalizePath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.pop() === undefined) {
        return null;
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** The folder a path on a branch sits in, empty at the root. */
export function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

function decoded(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/**
 * Where a link goes. Agents name their work by the paths their tools used, on a runner's disk; one
 * through a task's worktree is that task's file, and so is a relative one in a task's file, beside
 * it. Any other path names a place the board cannot open. An address with a scheme, `//`, or only
 * a fragment is the browser's.
 */
export function linkTarget(href: string | undefined, base?: FileBase): LinkTarget | null {
  // react-markdown turns an unsafe URL, such as a script's, into an empty one.
  if (href === undefined || href === "") {
    return LOCAL;
  }
  if (href.startsWith("#") || href.startsWith("//") || SCHEME.test(href)) {
    return null;
  }
  const path = decoded(href.replace(/[?#].*$/, ""));
  const worktree = TASK_WORKTREE.exec(path);
  if (worktree?.[1] !== undefined) {
    const inside = normalizePath(worktree[2] ?? "");
    return inside === null ? LOCAL : { kind: "task-file", taskId: worktree[1], path: inside };
  }
  if (base !== undefined && !path.startsWith("/")) {
    const inside = normalizePath(`${base.dir}/${path}`);
    return inside === null ? LOCAL : { kind: "task-file", taskId: base.taskId, path: inside };
  }
  return LOCAL;
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The media type an image file is shown with, or null for a file that is not an image. */
export function imageType(path: string): string | null {
  return IMAGE_TYPES[extensionOf(path)] ?? null;
}

/** A file's bytes from the base64 a branch read carries them in. */
export function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.charCodeAt(at);
  }
  return bytes;
}

/** The bytes as text, or null when they are not UTF-8 or hold a NUL, as binary files do. */
export function textOf(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

/**
 * Rows of a CSV or TSV file. Quoted fields may hold separators, line breaks, and doubled quotes;
 * rows may differ in length.
 */
export function parseDelimited(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text.charAt(at + 1) === '"') {
        field += '"';
        at += 1;
      } else {
        quoted = false;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === separator) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text.charAt(at + 1) === "\n") {
        at += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** How a file's content is shown, chosen by its name and then by whether it reads as text. */
export type FileView =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "image"; readonly type: string }
  | { readonly kind: "table"; readonly rows: string[][] }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary" };

export function viewOf(path: string, bytes: Uint8Array): FileView {
  const type = imageType(path);
  if (type !== null) {
    return { kind: "image", type };
  }
  const text = textOf(bytes);
  if (text === null) {
    return { kind: "binary" };
  }
  const extension = extensionOf(path);
  if (extension === "md" || extension === "markdown") {
    return { kind: "markdown", text };
  }
  if (extension === "csv" || extension === "tsv") {
    return { kind: "table", rows: parseDelimited(text, extension === "csv" ? "," : "\t") };
  }
  return { kind: "text", text };
}

/** A size as "812 B", "4.2 KB", or "3.1 MB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kilobytes = bytes / 1024;
  return kilobytes < 1024 ? `${kilobytes.toFixed(1)} KB` : `${(kilobytes / 1024).toFixed(1)} MB`;
}
