import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BoardEvent } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "./events.js";

const ids = (events: readonly BoardEvent[]): string[] => events.map((event) => event.id);

describe("EventLog", () => {
  let dir: string;
  let file: string;
  let count: number;
  let log: EventLog;

  const nextId = (): string => {
    count += 1;
    return `01M4Q0000000000000000${String(count).padStart(5, "0")}`;
  };
  // One at a time, as the board appends under its mutex.
  const append = async (n = 1): Promise<BoardEvent[]> => {
    const written: BoardEvent[] = [];
    for (let at = 0; at < n; at += 1) {
      written.push(await log.append("paused.changed", "user", { paused: at % 2 === 0 }));
    }
    return written;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-events-"));
    file = path.join(dir, "events", "events.jsonl");
    count = 0;
    log = new EventLog(file, nextId, () => new Date("2026-10-12T07:00:00Z"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads what follows a cursor, up to a limit, and names the newest", async () => {
    expect(await log.readSince(null)).toEqual([]);
    expect(await log.lastId()).toBeNull();
    const written = ids(await append(5));

    expect(ids(await log.readSince(null))).toEqual(written);
    expect(ids(await log.readSince(written[1] ?? null))).toEqual(written.slice(2));
    expect(ids(await log.readSince(written[1] ?? null, 2))).toEqual(written.slice(2, 4));
    expect(await log.readSince(written[4] ?? null)).toEqual([]);
    expect(await log.lastId()).toBe(written[4]);
  });

  it("finds appends after a read, its own and another writer's", async () => {
    const [first] = ids(await append());
    expect(ids(await log.readSince(null))).toEqual([first]);

    const [own] = ids(await append());
    const other = {
      id: nextId(),
      ts: "2026-10-12T07:00:01.000Z",
      type: "paused.changed",
      actor: "user",
      payload: { paused: false },
    };
    await appendFile(file, `${JSON.stringify(other)}\n`, "utf8");

    expect(ids(await log.readSince(first ?? null))).toEqual([own, other.id]);
    expect(await log.lastId()).toBe(other.id);
  });

  it("leaves a line still being written for a later read", async () => {
    const [first] = ids(await append());
    const line = JSON.stringify({
      id: nextId(),
      ts: "2026-10-12T07:00:01.000Z",
      type: "paused.changed",
      actor: "user",
      payload: { paused: true },
    });
    await appendFile(file, line.slice(0, 20), "utf8");
    expect(await log.readSince(first ?? null)).toEqual([]);

    await appendFile(file, `${line.slice(20)}\n`, "utf8");
    expect(await log.readSince(first ?? null)).toHaveLength(1);
  });

  it("starts over when the log is replaced", async () => {
    await append(3);
    expect(await log.readSince(null)).toHaveLength(3);

    await rm(file);
    expect(await log.readSince(null)).toEqual([]);
    const [fresh] = ids(await append());
    expect(ids(await log.readSince(null))).toEqual([fresh]);
  });

  it("reads a line that does not begin with its id", async () => {
    const [first] = ids(await append());
    const late = nextId();
    await appendFile(
      file,
      `${JSON.stringify({ ts: "2026-10-12T07:00:01.000Z", type: "paused.changed", actor: "user", payload: {}, id: late })}\n`,
      "utf8",
    );
    expect(ids(await log.readSince(first ?? null))).toEqual([late]);
    expect(await log.readSince(late)).toEqual([]);
  });

  it("tells each listener of every append until it stops listening", async () => {
    const heard: string[] = [];
    const stop = log.onAppend((event) => heard.push(event.id));
    const [first] = ids(await append());
    stop();
    await append();
    expect(heard).toEqual([first]);
  });
});
