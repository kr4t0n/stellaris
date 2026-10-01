import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSafeRelativePath } from "@stellaris/shared";
import { z } from "zod";

/** A tree on the server, as the runner protocol's file API serves it. */
export interface RemoteTree {
  manifest(): Promise<Record<string, string>>;
  /** Contents by relative path, base64. */
  read(paths: readonly string[]): Promise<Record<string, string>>;
}

const SyncStateSchema = z.object({ files: z.record(z.string(), z.string()) });
const READ_BATCH = 200;
/** Files past this size are not hashed or sent; the server leaves them out of its manifests too. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * A runner's read-only mirror of a tree on the server, the board's projection: a pull fetches
 * every file whose hash differs from the server's and removes what the server no longer has.
 * Nothing here is written back, so the server's version always wins. Pulls run one at a time.
 */
export class TreeCopy {
  private readonly hashes = new Map<string, { mtimeMs: number; size: number; sha: string }>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly stateFile: string,
  ) {}

  pull(remote: RemoteTree): Promise<void> {
    const run = this.chain.then(
      () => this.pullNow(remote),
      () => this.pullNow(remote),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async pullNow(remote: RemoteTree): Promise<void> {
    const known = await this.readState();
    const theirs = await remote.manifest();
    const ours = await this.manifest();
    const fetch = Object.entries(theirs)
      .filter(([file, sha]) => isSafeRelativePath(file) && ours[file] !== sha)
      .map(([file]) => file);
    for (let index = 0; index < fetch.length; index += READ_BATCH) {
      const batch = fetch.slice(index, index + READ_BATCH);
      const contents = await remote.read(batch);
      for (const [file, content] of Object.entries(contents)) {
        if (batch.includes(file)) {
          await this.writeAtomic(file, Buffer.from(content, "base64"));
        }
      }
    }
    for (const file of new Set([...Object.keys(ours), ...Object.keys(known)])) {
      if (theirs[file] === undefined) {
        await rm(this.absolute(file), { force: true });
      }
    }
    await this.writeState(theirs);
  }

  private absolute(file: string): string {
    return path.join(this.root, ...file.split("/"));
  }

  private async writeAtomic(file: string, bytes: Buffer): Promise<void> {
    const target = this.absolute(file);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }

  private async readState(): Promise<Record<string, string>> {
    try {
      return SyncStateSchema.parse(JSON.parse(await readFile(this.stateFile, "utf8"))).files;
    } catch (error) {
      if (isMissing(error)) {
        return {};
      }
      throw error;
    }
  }

  private async writeState(files: Record<string, string>): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ files })}\n`, "utf8");
    await rename(tmp, this.stateFile);
  }

  /** The files of the local copy with their hashes; symbolic links are skipped. */
  private async manifest(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const walk = async (prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(prefix === "" ? this.root : this.absolute(prefix), {
          withFileTypes: true,
        });
      } catch (error) {
        if (isMissing(error)) {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const file = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(file);
        } else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
          const sha = await this.hash(file);
          if (sha !== null) {
            files[file] = sha;
          }
        }
      }
    };
    await walk("");
    return files;
  }

  private async hash(file: string): Promise<string | null> {
    const absolute = this.absolute(file);
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
