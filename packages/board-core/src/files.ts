import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSafeRelativePath } from "@stellaris/shared";

/** Which relative paths of a tree the file API serves. */
export type FileFilter = (relative: string) => boolean;

/** Files past this size are left out of a manifest: homes and the projection are markdown. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

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
 * forward slashes, and their SHA-256. Hashes are kept per file until its size or modification time
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
      const known = this.hashes.get(absolute);
      if (known !== undefined && known.mtimeMs === info.mtimeMs && known.size === info.size) {
        return known.sha;
      }
      const sha = createHash("sha256")
        .update(await readFile(absolute))
        .digest("hex");
      this.hashes.set(absolute, { mtimeMs: info.mtimeMs, size: info.size, sha });
      return sha;
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }
}
