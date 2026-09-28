import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  BoardEventSchema,
  type BoardEvent,
  type BoardEventType,
  type Name,
  type Ulid,
} from "@stellaris/shared";
import { ensureDir, exists } from "./fs.js";

/** Append-only JSONL log. Every board change lands here; the scheduler and the UI read from it. */
export class EventLog {
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
    return event;
  }

  /** Events with an id greater than `since`, oldest first. `null` reads from the beginning. */
  async readSince(since: Ulid | null, limit = 1000): Promise<BoardEvent[]> {
    if (!(await exists(this.file))) {
      return [];
    }
    const raw = await readFile(this.file, "utf8");
    const events: BoardEvent[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      const event = BoardEventSchema.parse(JSON.parse(line));
      if (since !== null && event.id <= since) {
        continue;
      }
      events.push(event);
      if (events.length >= limit) {
        break;
      }
    }
    return events;
  }
}
