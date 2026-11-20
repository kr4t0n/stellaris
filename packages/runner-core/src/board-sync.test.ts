import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileVersion, type RunnerSyncReport } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncBoard } from "./board-sync.js";
import { TreeCopy, type RemoteTree, type TreeStream } from "./sync.js";

const SILENT = { info() {}, warn() {}, error() {} };

interface ServedFile {
  readonly path: string;
  readonly text: string;
}

function versionOf(text: string): string {
  return fileVersion(createHash("sha256").update(text).digest("hex"), false);
}

function line(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

/** A stream's records, uncompressed, as the board's route writes them, from after `after` on. */
function records(
  files: readonly ServedFile[],
  after: string | null,
  { end = true }: { end?: boolean } = {},
): Buffer {
  const sorted = files.toSorted((a, b) => (a.path < b.path ? -1 : 1));
  const skipped = sorted.filter((file) => after !== null && file.path <= after);
  const parts = [
    line({
      files: sorted.length,
      bytes: sorted.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0),
      skippedFiles: skipped.length,
      skippedBytes: skipped.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0),
    }),
  ];
  for (const file of sorted) {
    if (after === null || file.path > after) {
      parts.push(
        line({
          path: file.path,
          version: versionOf(file.text),
          size: Buffer.byteLength(file.text),
        }),
        Buffer.from(file.text),
      );
    }
  }
  if (end) {
    parts.push(line({ end: true }));
  }
  return Buffer.concat(parts);
}

function body(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

/**
 * A body that sends `bytes` in small pieces as they are read, then fails, as a connection the far
 * side closed partway through an answer does.
 */
function cutBody(bytes: Buffer): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    async pull(controller) {
      if (at >= bytes.length) {
        // The cut comes a moment after the last bytes, which the copy has taken by then.
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.error(new TypeError("terminated", { cause: new Error("other side closed") }));
        return;
      }
      controller.enqueue(new Uint8Array(bytes.subarray(at, at + 64)));
      at += 64;
    },
  });
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .toSorted();
}

describe("syncBoard", () => {
  let dir: string;
  let local: string;
  let stateFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-board-sync-"));
    local = path.join(dir, "board");
    stateFile = path.join(dir, "sync", "board.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const tree: ServedFile[] = Array.from({ length: 12 }, (_, index) => ({
    path: `projects/lab/threads/t${String(index).padStart(2, "0")}.md`,
    text: `message ${index}\n`.repeat(index + 1),
  }));

  const remoteOf = (files: readonly ServedFile[], reads: string[][]): RemoteTree => ({
    manifest: async () =>
      Object.fromEntries(files.map((file) => [file.path, versionOf(file.text)])),
    read: async (paths) => {
      reads.push([...paths]);
      return Object.fromEntries(
        paths.flatMap((each) => {
          const file = files.find((served) => served.path === each);
          return file === undefined ? [] : [[each, Buffer.from(file.text).toString("base64")]];
        }),
      );
    },
  });

  it("copies the whole board from one stream, and asks a cut one again from the last file it wrote", async () => {
    const asked: (string | null)[] = [];
    // What the copy held as each stream was asked for.
    const held: string[][] = [];
    const cutAfter = 5;
    const stream: TreeStream = {
      open: async (after) => {
        asked.push(after);
        held.push(await listFiles(local).catch(() => []));
        const raw = records(tree, after);
        if (asked.length === 1) {
          // Cut inside the sixth file's content, so at most five files arrive whole.
          const sixth = raw.indexOf(Buffer.from(tree[cutAfter]?.text ?? "")) + 3;
          return cutBody(gzipSync(raw.subarray(0, sixth)));
        }
        return body(gzipSync(raw));
      },
    };
    const reports: RunnerSyncReport[] = [];
    const reads: string[][] = [];
    const copy = new TreeCopy(local, stateFile);
    expect(await copy.plan()).toEqual({ kind: "copy", after: null });

    const done = await syncBoard({
      copy,
      remote: remoteOf(tree, reads),
      stream,
      report: async (report) => {
        reports.push(report);
      },
      log: SILENT,
      retryMs: 5,
      reportEveryMs: 0,
      reportEndForMs: 1_000,
      signal: new AbortController().signal,
    });

    expect(done).toBe(true);
    // The first try wrote files before the cut, and the second asked from the last of them, so
    // none came twice and none was missed.
    const written = held[1] ?? [];
    expect(written.length).toBeGreaterThan(0);
    expect(written.length).toBeLessThanOrEqual(cutAfter);
    expect(written).toEqual(tree.slice(0, written.length).map((file) => file.path));
    expect(asked).toEqual([null, written.at(-1)]);
    expect(reads).toEqual([]);
    expect(await listFiles(local)).toEqual(tree.map((file) => file.path));
    for (const file of tree) {
      expect(await readFile(path.join(local, file.path), "utf8")).toBe(file.text);
    }
    const failed = reports.find((report) => report.error !== undefined);
    expect(failed).toMatchObject({
      phase: "copying",
      attempt: 1,
      files: written.length,
      totalFiles: 12,
    });
    expect(failed?.error).toContain("terminated");
    expect(failed?.retryInMs).toBe(5);
    expect(reports.at(-1)).toMatchObject({
      phase: "done",
      attempt: 2,
      files: 12,
      totalFiles: 12,
      bytes: tree.reduce((sum, file) => sum + file.text.length, 0),
    });
    // A whole copy is kept up to date by pulls from now on.
    expect(await copy.plan()).toEqual({ kind: "pull" });
  });

  it("asks a copy cut before a restart again from where the stream stopped", async () => {
    const copy = new TreeCopy(local, stateFile);
    const raw = records(tree, null, { end: false });
    // The stream ends cleanly at a record's edge, but with no end line: that is a cut too.
    await expect(
      copy.copy({ open: async () => body(gzipSync(raw)) }, new AbortController().signal),
    ).rejects.toThrow("the stream ended before its last record");
    expect(await copy.plan()).toEqual({ kind: "copy", after: tree.at(-1)?.path });

    const restarted = new TreeCopy(local, stateFile);
    const asked: (string | null)[] = [];
    await restarted.copy(
      {
        open: async (after) => {
          asked.push(after);
          return body(gzipSync(records(tree, after)));
        },
      },
      new AbortController().signal,
    );
    expect(asked).toEqual([tree.at(-1)?.path]);
    expect(await restarted.plan()).toEqual({ kind: "pull" });
  });

  it("writes no file a stream names outside the copy, and fails one with a record it does not know or a wrong hash", async () => {
    const outside = path.join(dir, "escaped.md");
    const unsafe = Buffer.concat([
      line({ files: 3, bytes: 3, skippedFiles: 0, skippedBytes: 0 }),
      line({ path: "../escaped.md", version: versionOf("x"), size: 1 }),
      Buffer.from("x"),
      line({ path: "/tmp/escaped.md", version: versionOf("y"), size: 1 }),
      Buffer.from("y"),
      line({ path: "society/ok.md", version: versionOf("z"), size: 1 }),
      Buffer.from("z"),
      line({ end: true }),
    ]);
    const copy = new TreeCopy(local, stateFile);
    await copy.copy({ open: async () => body(gzipSync(unsafe)) }, new AbortController().signal);
    expect(await listFiles(local)).toEqual(["society/ok.md"]);
    await expect(stat(outside)).rejects.toThrow("ENOENT");

    for (const [bad, message] of [
      [
        line({ path: "society/link.md", version: versionOf("x"), size: 1, link: "/etc/passwd" }),
        "link",
      ],
      [
        line({ path: "society/kind.md", version: versionOf("x"), size: 1, type: "symlink" }),
        "type",
      ],
      [
        Buffer.concat([
          line({ path: "society/x.md", version: versionOf("x"), size: 1 }),
          Buffer.from("w"),
        ]),
        "does not match its version",
      ],
    ] as const) {
      const fresh = new TreeCopy(
        path.join(dir, `bad-${message}`),
        path.join(dir, `bad-${message}.json`),
      );
      const stream = Buffer.concat([
        line({ files: 1, bytes: 1, skippedFiles: 0, skippedBytes: 0 }),
        bad,
      ]);
      await expect(
        fresh.copy({ open: async () => body(gzipSync(stream)) }, new AbortController().signal),
      ).rejects.toThrow(message);
    }
  });

  it("pulls an existing copy, and a pull cut partway fetches on its next try only what it had not written", async () => {
    const copy = new TreeCopy(local, stateFile);
    const reads: string[][] = [];
    await copy.pull(remoteOf(tree.slice(0, 2), reads));
    expect(await copy.plan()).toEqual({ kind: "pull" });

    // 300 new files, two batches: the second fails once.
    const grown = [
      ...tree.slice(0, 2),
      ...Array.from({ length: 300 }, (_, index) => ({
        path: `society/threads/n${String(index).padStart(3, "0")}.md`,
        text: `new ${index}\n`,
      })),
    ];
    reads.length = 0;
    const remote = remoteOf(grown, reads);
    let failed = false;
    const flaky: RemoteTree = {
      manifest: () => remote.manifest(),
      read: async (paths) => {
        if (reads.length === 1 && !failed) {
          failed = true;
          throw new TypeError("fetch failed", { cause: new Error("other side closed") });
        }
        return remote.read(paths);
      },
    };
    const reports: RunnerSyncReport[] = [];
    const done = await syncBoard({
      copy,
      remote: flaky,
      stream: {
        open: async () => {
          throw new Error("a copy that has synced pulls");
        },
      },
      report: async (report) => {
        reports.push(report);
      },
      log: SILENT,
      retryMs: 5,
      reportEveryMs: 0,
      reportEndForMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(done).toBe(true);
    const fetched = reads.flat();
    expect(fetched).toHaveLength(300);
    expect(new Set(fetched).size).toBe(300);
    expect(reports.find((report) => report.error !== undefined)).toMatchObject({
      phase: "fetching",
      attempt: 1,
      files: 200,
      totalFiles: 300,
    });
    expect(reports.at(-1)).toMatchObject({
      phase: "done",
      attempt: 2,
      files: 100,
      totalFiles: 100,
    });
    expect(await listFiles(local)).toEqual(grown.map((file) => file.path).toSorted());
  });

  it("stops trying once the runner stops, and reports no end", async () => {
    const stopping = new AbortController();
    const reports: RunnerSyncReport[] = [];
    // The runner stops while the next try waits, a minute away. A try writes the copy's state on
    // disk before it asks for the stream and again as it fails, before the failure is reported,
    // and a loaded machine's disk can hold either past any fixed time, so the test stops the sync
    // once the failure is reported.
    const failed = Promise.withResolvers<void>();
    const run = syncBoard({
      copy: new TreeCopy(local, stateFile),
      remote: remoteOf(tree, []),
      stream: {
        open: async () => {
          throw new TypeError("fetch failed");
        },
      },
      report: async (report) => {
        reports.push(report);
        if (report.retryInMs !== undefined) {
          failed.resolve();
        }
      },
      log: SILENT,
      retryMs: 60_000,
      reportEveryMs: 0,
      reportEndForMs: 1_000,
      signal: stopping.signal,
    });
    await failed.promise;
    stopping.abort();
    expect(await run).toBe(false);
    expect(reports.some((report) => report.phase === "done")).toBe(false);
    expect(reports.at(-1)).toMatchObject({ attempt: 1, retryInMs: 60_000 });
  });
});
