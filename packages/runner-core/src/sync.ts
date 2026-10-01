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
  write?(put: Record<string, string>, remove: readonly string[]): Promise<void>;
}

/** How a file travels: both ways, down only, or not at all. */
export type Travels = (file: string) => "both" | "down" | null;

const SyncStateSchema = z.object({ files: z.record(z.string(), z.string()) });
const READ_BATCH = 200;
/** Files past this size are not hashed or sent; the server leaves them out of its manifests too. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * A runner's copy of a tree on the server: an agent's home, or the board's projection. It keeps
 * the hashes both sides last agreed on, so a pull knows what changed on each side since: a file
 * the server changed is taken from it, and a file changed only here, by a turn that has not pushed
 * yet, is kept. A push sends what changed here. The server is the source of truth, so where both
 * changed a file, the server's wins.
 */
export class TreeCopy {
  private readonly hashes = new Map<string, { mtimeMs: number; size: number; sha: string }>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly stateFile: string,
    private readonly travels: Travels,
  ) {}

  /** Brings the copy up to the server's tree. Pulls and pushes of one copy run one at a time. */
  pull(remote: RemoteTree): Promise<void> {
    return this.serial(() => this.pullNow(remote));
  }

  /** Sends what changed here since the last agreement, of the files that travel both ways. */
  push(remote: RemoteTree): Promise<void> {
    return this.serial(() => this.pushNow(remote));
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async pullNow(remote: RemoteTree): Promise<void> {
    const agreed = await this.readState();
    const theirs = await remote.manifest();
    const ours = await this.manifest((file) => this.travels(file) !== null);
    const fetch: string[] = [];
    for (const [file, sha] of Object.entries(theirs)) {
      if (!isSafeRelativePath(file) || this.travels(file) === null) {
        continue;
      }
      if (ours[file] === sha) {
        agreed[file] = sha;
        continue;
      }
      const changedHere = ours[file] !== undefined && ours[file] !== agreed[file];
      const changedThere = agreed[file] !== sha;
      if (changedHere && !changedThere) {
        continue;
      }
      fetch.push(file);
    }
    for (let index = 0; index < fetch.length; index += READ_BATCH) {
      const batch = fetch.slice(index, index + READ_BATCH);
      const contents = await remote.read(batch);
      for (const [file, content] of Object.entries(contents)) {
        if (!batch.includes(file)) {
          continue;
        }
        const bytes = Buffer.from(content, "base64");
        await this.writeAtomic(file, bytes);
        agreed[file] = createHash("sha256").update(bytes).digest("hex");
      }
    }
    // Gone from the server since the last agreement, and untouched here: gone here too.
    for (const [file, sha] of Object.entries(agreed)) {
      if (theirs[file] === undefined) {
        if (ours[file] === sha || ours[file] === undefined) {
          await rm(this.absolute(file), { force: true });
        }
        delete agreed[file];
      }
    }
    await this.writeState(agreed);
  }

  private async pushNow(remote: RemoteTree): Promise<void> {
    if (remote.write === undefined) {
      return;
    }
    const agreed = await this.readState();
    const ours = await this.manifest((file) => this.travels(file) === "both");
    const put: Record<string, string> = {};
    for (const [file, sha] of Object.entries(ours)) {
      if (agreed[file] !== sha) {
        put[file] = (await readFile(this.absolute(file))).toString("base64");
      }
    }
    const remove = Object.keys(agreed).filter(
      (file) => this.travels(file) === "both" && ours[file] === undefined,
    );
    if (Object.keys(put).length === 0 && remove.length === 0) {
      return;
    }
    await remote.write(put, remove);
    for (const [file, sha] of Object.entries(ours)) {
      agreed[file] = sha;
    }
    for (const file of remove) {
      delete agreed[file];
    }
    await this.writeState(agreed);
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

  /** The files of the local copy that pass `include`, with their hashes; symbolic links are skipped. */
  private async manifest(include: (file: string) => boolean): Promise<Record<string, string>> {
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
        } else if (entry.isFile() && !entry.name.endsWith(".tmp") && include(file)) {
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
