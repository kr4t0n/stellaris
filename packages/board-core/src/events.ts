import { appendFile, open, stat } from "node:fs/promises";
import path from "node:path";
import {
  BoardEventSchema,
  type BoardEvent,
  type BoardEventType,
  type Name,
  type Ulid,
} from "@stellaris/shared";
import { ensureDir } from "./fs.js";

/** Every line starts with the event's id, which `append` writes first; old lines skip unparsed. */
const LEADING_ID = /^\{"id":"([0-9A-HJKMNP-TV-Z]{26})"/;

/** Long enough to hold `{"id":"<26 characters>"`, which is all `LEADING_ID` looks at. */
const ID_PREFIX_BYTES = 64;

const NEWLINE = 0x0a;

/** One complete line of the log: its event's id and the bytes it spans, newline excluded. */
interface LogLine {
  readonly id: Ulid;
  readonly start: number;
  readonly end: number;
}

/**
 * Append-only JSONL log of every board change. Reads go through an index of the complete lines
 * seen so far, extended by the bytes appended since, so a read decodes only the lines it returns:
 * the scheduler and every board-event stream read it every second or less.
 */
export class EventLog {
  private lines: LogLine[] = [];
  /** Bytes the index covers: always the end of a complete line. */
  private indexed = 0;
  /** The indexed file, to tell a replaced log from a grown one. */
  private inode: number | null = null;
  private scanning: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(event: BoardEvent) => void>();

  constructor(
    private readonly file: string,
    private readonly newId: () => Ulid,
    private readonly now: () => Date,
  ) {}

  async append(
    type: BoardEventType,
    actor: Name,
    payload: Record<string, unknown>,
  ): Promise<BoardEvent> {
    const event: BoardEvent = {
      id: this.newId(),
      ts: this.now().toISOString(),
      type,
      actor,
      payload,
    };
    await ensureDir(path.dirname(this.file));
    await appendFile(this.file, `${JSON.stringify(event)}\n`, "utf8");
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // The event is written; a listener's failure is its own.
      }
    }
    return event;
  }

  /**
   * Calls `listener` after each event this process appends, until the returned function is
   * called. Another process's appends, such as the admin CLI's, are seen only by the next read.
   */
  onAppend(listener: (event: BoardEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Events with an id greater than `since`, oldest first. `null` reads from the beginning. */
  async readSince(since: Ulid | null, limit = 1000): Promise<BoardEvent[]> {
    await this.refresh();
    const chosen: LogLine[] = [];
    for (const line of this.lines) {
      if (since !== null && line.id <= since) {
        continue;
      }
      chosen.push(line);
      if (chosen.length >= limit) {
        break;
      }
    }
    const first = chosen[0];
    const last = chosen.at(-1);
    if (first === undefined || last === undefined) {
      return [];
    }
    const span = await this.readBytes(first.start, last.end);
    return chosen.map((line) =>
      BoardEventSchema.parse(
        JSON.parse(span.toString("utf8", line.start - first.start, line.end - first.start)),
      ),
    );
  }

  /** The id of the newest event, or null for an empty log. */
  async lastId(): Promise<Ulid | null> {
    await this.refresh();
    return this.lines.at(-1)?.id ?? null;
  }

  /** Brings the index up to the file's end, one scan at a time. */
  private refresh(): Promise<void> {
    this.scanning = this.scanning.then(
      () => this.scan(),
      () => this.scan(),
    );
    return this.scanning;
  }

  private async scan(): Promise<void> {
    const info = await stat(this.file).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (info === null || info.ino !== this.inode || info.size < this.indexed) {
      this.lines = [];
      this.indexed = 0;
      this.inode = info?.ino ?? null;
    }
    if (info === null || info.size === this.indexed) {
      return;
    }
    const added = await this.readBytes(this.indexed, info.size);
    let start = 0;
    for (let at = added.indexOf(NEWLINE); at >= 0; at = added.indexOf(NEWLINE, start)) {
      const prefix = added.toString("utf8", start, Math.min(at, start + ID_PREFIX_BYTES));
      if (prefix.trim().length > 0) {
        const id =
          LEADING_ID.exec(prefix)?.[1] ??
          BoardEventSchema.parse(JSON.parse(added.toString("utf8", start, at))).id;
        this.lines.push({ id, start: this.indexed + start, end: this.indexed + at });
      }
      start = at + 1;
    }
    // A line still being written waits for its newline, and the next scan.
    this.indexed += start;
  }

  private async readBytes(from: number, to: number): Promise<Buffer> {
    const handle = await open(this.file, "r");
    try {
      const buffer = Buffer.alloc(to - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}
