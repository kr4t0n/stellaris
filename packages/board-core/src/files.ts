import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  fileVersion,
  isSafeRelativePath,
  MAX_SYNCED_FILE_BYTES,
  type BoardStreamStart,
} from "@stellaris/shared";

/** Which relative paths of a tree the file API serves. */
export type FileFilter = (relative: string) => boolean;

/** Files past this size are left out of a manifest: homes and the projection are markdown. */
const MAX_FILE_BYTES = MAX_SYNCED_FILE_BYTES;

/** A file as the board's stream carries it: its path, its version, and its content. */
export interface StreamedFile {
  readonly path: string;
  readonly version: string;
  readonly content: Buffer;
}

/** Opens only a regular file itself: a link in its place fails to open, and a FIFO opens at once. */
const READ_FILE_ONLY = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

interface Hashed {
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha: string;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * A directory as the runner protocol's file API sees it: regular files by relative path with
 * forward slashes, and their versions, the SHA-256 marked when the file is executable. Hashes are kept per file until its size or modification time
 * changes, so listing a tree again reads only what changed. Symbolic links are never followed, and
 * the temporary files of atomic writes are never listed.
 */
export class FileTree {
  private readonly hashes = new Map<string, Hashed>();

  async manifest(root: string, include: FileFilter): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    await this.walk(root, "", include, files);
    return files;
  }

  /** The contents of the listed files, base64, leaving out any that is missing or not served. */
  async read(
    root: string,
    paths: readonly string[],
    include: FileFilter,
  ): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const relative of paths) {
      if (!isSafeRelativePath(relative) || !include(relative)) {
        continue;
      }
      try {
        const absolute = path.join(root, ...relative.split("/"));
        const info = await stat(absolute);
        if (info.isFile() && info.size <= MAX_FILE_BYTES) {
          files[relative] = (await readFile(absolute)).toString("base64");
        }
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }
    }
    return files;
  }

  /**
   * The tree's regular files whose paths sort after `after`, in the order of their UTF-16 code
   * units, each read as it is reached, after a first record with the totals of the whole tree and
   * of what `after` left out. As the manifest does, it never follows a link, a folder's or a
   * file's, and skips what is not a regular file, a FIFO included, which it never waits on; a file
   * that changed into one, or went, after the listing is skipped too.
   */
  async *stream(
    root: string,
    after: string | null,
    include: FileFilter,
  ): AsyncGenerator<BoardStreamStart | StreamedFile> {
    const sizes: { relative: string; size: number }[] = [];
    await this.walkSizes(root, "", include, sizes);
    sizes.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    const start: BoardStreamStart = { files: 0, bytes: 0, skippedFiles: 0, skippedBytes: 0 };
    for (const { relative, size } of sizes) {
      start.files += 1;
      start.bytes += size;
      if (after !== null && relative <= after) {
        start.skippedFiles += 1;
        start.skippedBytes += size;
      }
    }
    yield start;
    for (const { relative } of sizes) {
      if (after !== null && relative <= after) {
        continue;
      }
      const file = await this.readRegular(path.join(root, ...relative.split("/")));
      if (file !== null) {
        yield {
          path: relative,
          version: fileVersion(
            createHash("sha256").update(file.content).digest("hex"),
            file.executable,
          ),
          content: file.content,
        };
      }
    }
  }

  /** A regular file's content and whether it is executable, or null for anything else. */
  private async readRegular(
    absolute: string,
  ): Promise<{ content: Buffer; executable: boolean } | null> {
    let handle;
    try {
      handle = await open(absolute, READ_FILE_ONLY);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ELOOP")
      ) {
        return null;
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        return null;
      }
      const content = await handle.readFile();
      return content.length > MAX_FILE_BYTES
        ? null
        : { content, executable: (info.mode & 0o111) !== 0 };
    } finally {
      await handle.close();
    }
  }

  private async walkSizes(
    root: string,
    prefix: string,
    include: FileFilter,
    files: { relative: string; size: number }[],
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(path.join(root, ...(prefix === "" ? [] : prefix.split("/"))), {
        withFileTypes: true,
      });
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await this.walkSizes(root, relative, include, files);
      } else if (
        entry.isFile() &&
        !entry.name.endsWith(".tmp") &&
        isSafeRelativePath(relative) &&
        include(relative)
      ) {
        try {
          const info = await stat(path.join(root, ...relative.split("/")));
          if (info.size <= MAX_FILE_BYTES) {
            files.push({ relative, size: info.size });
          }
        } catch (error) {
          if (!isMissing(error)) {
            throw error;
          }
        }
      }
    }
  }

  /**
   * Writes and deletes files under `root`. Every path must be safe and accepted by `include`, or
   * nothing is written; the caller holds the board's mutex.
   */
  async write(
    root: string,
    put: Readonly<Record<string, string>>,
    remove: readonly string[],
    include: FileFilter,
  ): Promise<void> {
    const refused = [...Object.keys(put), ...remove].filter(
      (relative) => !isSafeRelativePath(relative) || !include(relative),
    );
    if (refused.length > 0) {
      throw new Error(`refused to write ${refused.join(", ")}`);
    }
    for (const [relative, content] of Object.entries(put)) {
      const absolute = path.join(root, ...relative.split("/"));
      await mkdir(path.dirname(absolute), { recursive: true });
      const tmp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, Buffer.from(content, "base64"));
      await rename(tmp, absolute);
    }
    for (const relative of remove) {
      await rm(path.join(root, ...relative.split("/")), { force: true });
    }
  }

  private async walk(
    root: string,
    prefix: string,
    include: FileFilter,
    files: Record<string, string>,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(path.join(root, ...(prefix === "" ? [] : prefix.split("/"))), {
        withFileTypes: true,
      });
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await this.walk(root, relative, include, files);
      } else if (entry.isFile() && !entry.name.endsWith(".tmp") && include(relative)) {
        const sha = await this.hash(path.join(root, ...relative.split("/")));
        if (sha !== null) {
          files[relative] = sha;
        }
      }
    }
  }

  private async hash(absolute: string): Promise<string | null> {
    try {
      const info = await stat(absolute);
      if (info.size > MAX_FILE_BYTES) {
        return null;
      }
      const executable = (info.mode & 0o111) !== 0;
      const known = this.hashes.get(absolute);
      if (known !== undefined && known.mtimeMs === info.mtimeMs && known.size === info.size) {
        return fileVersion(known.sha, executable);
      }
      const sha = createHash("sha256")
        .update(await readFile(absolute))
        .digest("hex");
      this.hashes.set(absolute, { mtimeMs: info.mtimeMs, size: info.size, sha });
      return fileVersion(sha, executable);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }
}
