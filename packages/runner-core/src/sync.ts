import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BOARD_STREAM_LINE_LIMIT,
  BoardStreamEndSchema,
  BoardStreamFileSchema,
  BoardStreamStartSchema,
  fileVersion,
  isExecutableVersion,
  isSafeRelativePath,
  MAX_SYNCED_FILE_BYTES,
  type BoardStreamStart,
} from "@stellaris/shared";
import { z } from "zod";

/** A tree on the server, as the runner protocol's file API serves it. */
export interface RemoteTree {
  manifest(): Promise<Record<string, string>>;
  /** Contents by relative path, base64. */
  read(paths: readonly string[]): Promise<Record<string, string>>;
}

/** The whole tree on the server in one answer, from the path after `after` on (`BoardStreamStartSchema`). */
export interface TreeStream {
  open(after: string | null, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

/** How far a copy or a pull has come: files and bytes written of the totals, null while unknown. */
export interface TreeProgress {
  readonly phase: "copying" | "listing" | "fetching";
  readonly files: number;
  readonly totalFiles: number | null;
  readonly bytes: number;
  readonly totalBytes: number | null;
}

/** What brings a copy up to date: a pull, or the whole tree's stream from after a path. */
export type TreeCopyPlan =
  | { readonly kind: "pull" }
  | { readonly kind: "copy"; readonly after: string | null };

const SyncStateSchema = z.object({
  files: z.record(z.string(), z.string()),
  /** A first copy under way: the last path its stream wrote, null before any. */
  copying: z.object({ after: z.string().nullable() }).optional(),
});
type SyncState = z.infer<typeof SyncStateSchema>;
const READ_BATCH = 200;
/** Files past this size are not hashed or sent; the server leaves them out of its manifests too. */
const MAX_FILE_BYTES = MAX_SYNCED_FILE_BYTES;
/** How long a stream may stay silent before the copy takes it for dead and asks again. */
const STREAM_SILENT_MS = 60_000;
/** How often a first copy saves where its stream has come to, for a copy after a restart. */
const SAVE_EVERY_MS = 1_000;

/** A stream's record, read: its totals, a file with its content, or its end. */
type StreamRecord =
  | ({ readonly kind: "start" } & BoardStreamStart)
  | {
      readonly kind: "file";
      readonly path: string;
      readonly version: string;
      readonly content: Buffer;
    }
  | { readonly kind: "end" };

/**
 * Reads lines and runs of bytes off a stream, holding its pieces apart until one is taken, so a
 * file as large as the limit arriving in small pieces is copied once.
 */
class ByteReader {
  private readonly pieces: Buffer[] = [];
  private length = 0;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** The next line without its newline, or null where the stream ended cleanly before one. */
  async line(limit: number): Promise<string | null> {
    for (;;) {
      let seen = 0;
      for (const piece of this.pieces) {
        const at = piece.indexOf(0x0a);
        if (at !== -1) {
          const text = this.take(seen + at + 1).subarray(0, seen + at);
          return text.toString("utf8");
        }
        seen += piece.length;
      }
      if (this.length > limit) {
        throw new Error(`a record line ran past ${limit} bytes`);
      }
      if (!(await this.fill())) {
        if (this.length === 0) {
          return null;
        }
        throw new Error("the stream ended inside a record line");
      }
    }
  }

  /** The next `size` bytes, failing when the stream ends before them. */
  async bytes(size: number): Promise<Buffer> {
    while (this.length < size) {
      if (!(await this.fill())) {
        throw new Error(`the stream ended ${size - this.length} bytes short of a file`);
      }
    }
    return this.take(size);
  }

  private async fill(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done) {
      return false;
    }
    this.pieces.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    this.length += value.byteLength;
    return true;
  }

  private take(size: number): Buffer {
    const out = Buffer.allocUnsafe(size);
    let filled = 0;
    while (filled < size) {
      const piece = this.pieces[0];
      if (piece === undefined) {
        throw new Error("took more than was read");
      }
      const part = Math.min(piece.length, size - filled);
      piece.copy(out, filled, 0, part);
      filled += part;
      if (part === piece.length) {
        this.pieces.shift();
      } else {
        this.pieces[0] = piece.subarray(part);
      }
    }
    this.length -= size;
    return out;
  }
}

/**
 * The records of the board's stream, gunzipped and checked: the totals first, then each file with
 * its content, whose hash must match its version, then the end. A stream that stops anywhere short
 * of its end line fails, so a cut at a record's edge is no clean end; what came before it stands.
 */
export async function* readTreeStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamRecord> {
  const reader = new ByteReader(body.pipeThrough(new DecompressionStream("gzip")).getReader());
  const record = async (): Promise<unknown> => {
    const text = await reader.line(BOARD_STREAM_LINE_LIMIT);
    if (text === null) {
      throw new Error("the stream ended before its last record");
    }
    return JSON.parse(text);
  };
  yield { kind: "start", ...BoardStreamStartSchema.parse(await record()) };
  for (;;) {
    const next = await record();
    if (BoardStreamEndSchema.safeParse(next).success) {
      yield { kind: "end" };
      return;
    }
    const file = BoardStreamFileSchema.parse(next);
    const content = await reader.bytes(file.size);
    const sha = createHash("sha256").update(content).digest("hex");
    if (fileVersion(sha, isExecutableVersion(file.version)) !== file.version) {
      throw new Error(`${file.path} arrived with content that does not match its version`);
    }
    yield { kind: "file", path: file.path, version: file.version, content };
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * A runner's read-only mirror of a tree on the server, the board's projection: a pull fetches
 * every file whose version, its hash and whether it is executable, differs from the server's, and
 * removes what the server no longer has. Nothing here is written back, so the server's version
 * always wins. Pulls run one at a time.
 */
export class TreeCopy {
  private readonly hashes = new Map<string, { mtimeMs: number; size: number; sha: string }>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly stateFile: string,
  ) {}

  pull(remote: RemoteTree, onProgress?: (progress: TreeProgress) => void): Promise<void> {
    return this.next(() => this.pullNow(remote, onProgress));
  }

  /**
   * What brings this copy up to date: the whole tree's stream while it has never had one, from
   * where a first copy's stream was cut, and a pull once it has.
   */
  async plan(): Promise<TreeCopyPlan> {
    const state = await this.readStateFile();
    if (state === null) {
      return { kind: "copy", after: null };
    }
    return state.copying === undefined
      ? { kind: "pull" }
      : { kind: "copy", after: state.copying.after };
  }

  /**
   * Copies the whole tree from one stream, from the path after the last one a cut stream wrote,
   * writing each file as it arrives. Where it has come to is saved as it goes, so a copy after a
   * restart asks from there too. Once the stream's end arrives, the copy is a whole one, and pulls
   * keep it current from then on; a file that changed on the server while it streamed is fetched by
   * the next pull, which each turn makes.
   */
  copy(
    stream: TreeStream,
    signal: AbortSignal,
    onProgress?: (progress: TreeProgress) => void,
  ): Promise<void> {
    return this.next(() => this.copyNow(stream, signal, onProgress));
  }

  private next(work: () => Promise<void>): Promise<void> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async copyNow(
    stream: TreeStream,
    signal: AbortSignal,
    onProgress?: (progress: TreeProgress) => void,
  ): Promise<void> {
    const state = await this.readStateFile();
    let after = state?.copying?.after ?? null;
    await this.writeState({}, { after });
    // A path that drops everything without closing the connection leaves a read waiting for good.
    const silent = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heard = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => silent.abort(), STREAM_SILENT_MS);
    };
    let ended = false;
    let progress: TreeProgress = {
      phase: "copying",
      files: 0,
      totalFiles: null,
      bytes: 0,
      totalBytes: null,
    };
    let saved = Date.now();
    const dirs = new Set<string>();
    try {
      heard();
      const body = await stream.open(after, AbortSignal.any([signal, silent.signal]));
      for await (const record of readTreeStream(body)) {
        heard();
        if (record.kind === "start") {
          progress = {
            phase: "copying",
            files: record.skippedFiles,
            totalFiles: record.files,
            bytes: record.skippedBytes,
            totalBytes: record.bytes,
          };
        } else if (record.kind === "end") {
          ended = true;
        } else {
          // Each path comes after the last, so where the stream was cut says what it still owes.
          if (after !== null && record.path <= after) {
            throw new Error(`the stream sent ${record.path} after ${after}`);
          }
          // A path that would leave the copy is not written, nor asked from again.
          if (isSafeRelativePath(record.path)) {
            await this.writeAtomic(
              record.path,
              record.content,
              isExecutableVersion(record.version),
              dirs,
            );
            after = record.path;
          }
          progress = {
            ...progress,
            files: progress.files + 1,
            bytes: progress.bytes + record.content.length,
          };
          if (Date.now() - saved >= SAVE_EVERY_MS) {
            await this.writeState({}, { after });
            saved = Date.now();
          }
        }
        onProgress?.(progress);
      }
    } catch (error) {
      if (silent.signal.aborted && !signal.aborted) {
        throw new Error(`the board's stream was silent for ${STREAM_SILENT_MS / 1000}s`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (!ended) {
        await this.writeState({}, { after });
      }
    }
    await this.writeState(await this.manifest());
  }

  private async pullNow(
    remote: RemoteTree,
    onProgress?: (progress: TreeProgress) => void,
  ): Promise<void> {
    const known = (await this.readStateFile())?.files ?? {};
    onProgress?.({ phase: "listing", files: 0, totalFiles: null, bytes: 0, totalBytes: null });
    const theirs = await remote.manifest();
    const ours = await this.manifest();
    const fetch = Object.entries(theirs)
      .filter(([file, version]) => isSafeRelativePath(file) && ours[file] !== version)
      .map(([file]) => file);
    let progress: TreeProgress = {
      phase: "fetching",
      files: 0,
      totalFiles: fetch.length,
      bytes: 0,
      totalBytes: null,
    };
    onProgress?.(progress);
    for (let index = 0; index < fetch.length; index += READ_BATCH) {
      const batch = fetch.slice(index, index + READ_BATCH);
      const contents = await remote.read(batch);
      for (const [file, content] of Object.entries(contents)) {
        const version = theirs[file];
        if (batch.includes(file) && version !== undefined) {
          const bytes = Buffer.from(content, "base64");
          await this.writeAtomic(file, bytes, isExecutableVersion(version));
          progress = {
            ...progress,
            files: progress.files + 1,
            bytes: progress.bytes + bytes.length,
          };
        }
      }
      onProgress?.(progress);
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

  /**
   * Writes a file whole or not at all. A copy passes the folders it has made, so a stream of
   * thousands of files makes each folder once; the hash is kept, so the copy's own listing at the
   * end reads nothing again.
   */
  private async writeAtomic(
    file: string,
    bytes: Buffer,
    executable: boolean,
    dirs?: Set<string>,
  ): Promise<void> {
    const target = this.absolute(file);
    const dir = path.dirname(target);
    if (dirs === undefined || !dirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      dirs?.add(dir);
    }
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes);
    await chmod(tmp, executable ? 0o755 : 0o644);
    await rename(tmp, target);
    if (dirs !== undefined) {
      const info = await stat(target);
      this.hashes.set(target, {
        mtimeMs: info.mtimeMs,
        size: info.size,
        sha: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }

  /** The state a pull or a copy left, or null where neither ever ran. */
  private async readStateFile(): Promise<SyncState | null> {
    try {
      return SyncStateSchema.parse(JSON.parse(await readFile(this.stateFile, "utf8")));
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  private async writeState(
    files: Record<string, string>,
    copying?: { after: string | null },
  ): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    const state: SyncState = { files, ...(copying === undefined ? {} : { copying }) };
    await writeFile(tmp, `${JSON.stringify(state)}\n`, "utf8");
    await rename(tmp, this.stateFile);
  }

  /** The files of the local copy with their versions; symbolic links are skipped. */
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
