import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { isSafeRelativePath, SKILL_FILES_LIMIT, type SkillFileContent } from "@stellaris/shared";

/** The most of a skill's file a view shows. */
export const SKILL_TEXT_LIMIT_CHARS = 100_000;
// A character takes at most four bytes in UTF-8, so this many bytes hold more than the text shown.
const SKILL_TEXT_LIMIT_BYTES = SKILL_TEXT_LIMIT_CHARS * 4;

/** A skill's file as a view shows it: its text cut at the limit, or null for a binary file. */
export function skillFileText(bytes: Buffer): Pick<SkillFileContent, "text" | "truncated"> {
  const text = bytes.includes(0) ? null : bytes.toString("utf8");
  return {
    text: text === null ? null : text.slice(0, SKILL_TEXT_LIMIT_CHARS),
    truncated: text !== null && text.length > SKILL_TEXT_LIMIT_CHARS,
  };
}

/** Whether a path is a folder or lies inside it, both with every link followed. */
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Whether an open file lies inside the folder, by the path the kernel gives its handle. A path
 * checked before the open cannot tell: `O_NOFOLLOW` guards only its last part, so a parent folder
 * swapped for a link in between leads the open outside. Only Linux names a handle's file
 * (`/proc/self/fd`, a file unlinked since keeping its path with ` (deleted)` after it); elsewhere
 * the check before the open stands alone.
 */
async function handleInside(root: string, handle: FileHandle): Promise<boolean> {
  if (process.platform !== "linux") {
    return true;
  }
  const file = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
  return file !== null && inside(root, file);
}

/** The relative paths of a folder's regular files, by name at each level, never through a link. */
async function walk(root: string, prefix: string, found: string[]): Promise<void> {
  const entries = await readdir(path.join(root, ...(prefix === "" ? [] : prefix.split("/"))), {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    if (found.length >= SKILL_FILES_LIMIT) {
      return;
    }
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (!isSafeRelativePath(relative)) {
      continue;
    }
    // A link is neither, whatever it points at. Atomic writes' temporary files are left out, as the
    // runners' copy of the projection leaves them out.
    if (entry.isDirectory()) {
      await walk(root, relative, found);
    } else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
      found.push(relative);
    }
  }
}

/** One file of the folder, or null when it is no longer a regular file inside it. */
async function readEntry(root: string, relative: string): Promise<SkillFileContent | null> {
  let real: string;
  try {
    real = await realpath(path.join(root, ...relative.split("/")));
  } catch {
    return null;
  }
  if (!inside(root, real)) {
    return null;
  }
  const handle = await open(
    real,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  if (handle === null) {
    return null;
  }
  try {
    if (!(await handleInside(root, handle))) {
      return null;
    }
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return null;
    }
    const buffer = Buffer.alloc(Math.min(stats.size, SKILL_TEXT_LIMIT_BYTES));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) {
        break;
      }
      size += bytesRead;
    }
    return {
      path: relative,
      size: stats.size,
      executable: (stats.mode & 0o111) !== 0,
      ...skillFileText(buffer.subarray(0, size)),
    };
  } finally {
    await handle.close();
  }
}

/**
 * A skill's folder on the board's disk with each file's text, or null when it is not a folder
 * holding a SKILL.md. Only regular files are read, at most `SKILL_FILES_LIMIT` of them and the
 * first bytes of each that hold the text shown: a link is never followed, the folder's own
 * included, and a file whose path leads out of the folder once every link is followed is left out.
 */
export async function readSkillFolder(dir: string): Promise<SkillFileContent[] | null> {
  const info = await lstat(dir).catch(() => null);
  if (info === null || !info.isDirectory()) {
    return null;
  }
  const root = await realpath(dir).catch(() => null);
  if (root === null) {
    return null;
  }
  const found: string[] = [];
  await walk(root, "", found);
  const files: SkillFileContent[] = [];
  for (const relative of found) {
    const file = await readEntry(root, relative);
    if (file !== null) {
      files.push(file);
    }
  }
  return files.some((file) => file.path === "SKILL.md") ? files : null;
}
