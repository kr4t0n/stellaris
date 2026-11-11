import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("reads events by id from their own lines, in the order asked, wherever they lie", async () => {
    // Lines near one another, a gap wider than a piece's, and more than a piece's size in all.
    const sizes = [10, 10, 20_000, 10, 300_000, 300_000, 300_000, 300_000, 10, 40_000, 10];
    const written: BoardEvent[] = [];
    for (const size of sizes) {
      written.push(await log.append("message.posted", "eng-1", { body: "x".repeat(size) }));
    }
    // Another writer's line, whose id sorts before every line above it.
    const other = {
      id: "01M4P000000000000000000001",
      ts: "2026-10-12T07:00:01.000Z",
      type: "paused.changed",
      actor: "user",
      payload: { paused: false },
    };
    await appendFile(file, `${JSON.stringify(other)}\n`, "utf8");
    // A line still being written.
    const late = nextId();
    await appendFile(file, `{"id":"${late}","ts":"2026-10-12T07:00:02.000Z"`, "utf8");
    const all = await log.readSince(null, Number.MAX_SAFE_INTEGER);
    expect(ids(all)).toEqual([...ids(written), other.id]);
    const asked = [
      ...ids(written).toReversed(),
      other.id,
      written[3]?.id ?? "",
      "01M4Q000000000000000099999",
      late,
    ];
    const read = await log.readIds(asked);
    const byId = new Map(all.map((event) => [event.id, event]));
    expect(read).toEqual(asked.map((id) => byId.get(id) ?? null));
    expect(read.slice(-2)).toEqual([null, null]);
    expect(await log.readIds([])).toEqual([]);
  });

  it("reads as none a line that no longer holds the event asked for", async () => {
    const written = ids(await append(3));
    expect(ids((await log.readIds(written)).filter((event) => event !== null))).toEqual(written);
    // The same bytes in place, but the middle line now another event's.
    const text = await readFile(file, "utf8");
    const swapped = text.replace(written[1] ?? "", "01M4Q000000000000000077777");
    expect(swapped.length).toBe(text.length);
    await writeFile(file, swapped, { flag: "r+" });
    const read = await log.readIds(written);
    expect(read.map((event) => event?.id ?? null)).toEqual([written[0], null, written[2]]);
    // A log cut short, then replaced.
    await writeFile(file, text.slice(0, text.indexOf("\n") + 1), { flag: "w" });
    expect((await log.readIds(written)).map((event) => event?.id ?? null)).toEqual([
      written[0],
      null,
      null,
    ]);
    await rm(file);
    expect(await log.readIds(written)).toEqual([null, null, null]);
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
