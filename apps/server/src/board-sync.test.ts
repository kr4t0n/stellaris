import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { Scheduler } from "@stellaris/scheduler";
import { readTreeStream, ZERO_USAGE, type AgentBackend } from "@stellaris/runner-core";
import {
  heldOn,
  RUNNER_PROTOCOL,
  RunnerHelloSchema,
  runnerSyncing,
  TurnDispatchSchema,
  type CliKind,
  type TurnDispatch,
} from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestSociety, type TestSociety } from "./testing/harness.js";
import { addWorkRoles, USER } from "./testing/scripted-backend.js";

/** A backend whose every turn says who ran it and where. */
function recording(ran: string[]): (kind: CliKind) => AgentBackend {
  return (kind) => ({
    kind,
    newSession: () => Promise.resolve(`session-${ran.length}`),
    runTurn: async (request) => {
      ran.push(`${request.spec.agent}@${request.spec.runner}`);
      return {
        events: [],
        finalText: "done",
        usage: ZERO_USAGE,
        costUsd: 0,
        status: {
          summary: "done",
          claimsHeld: [],
          blockedOn: [],
          needsUserDecision: false,
          memoryUpdated: false,
        },
        exitReason: "completed",
      };
    },
  });
}

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

/** A turn the user asks of `agent` in `project`. */
function dispatch(agent: string, project: string): TurnDispatch {
  return TurnDispatchSchema.parse({
    agent,
    project,
    trigger: { kind: "manual", fromUser: false, reason: "work" },
    priority: 1,
  });
}

/** The relative paths of the regular files under `root`. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".tmp"))
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("a runner's board sync as it connects", () => {
  let dir: string;
  let society: TestSociety | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-board-sync-"));
  });

  afterEach(async () => {
    await society?.stop();
    society = null;
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(): Promise<{ board: Board; userToken: string }> {
    const seeded = await Board.init(path.join(dir, "data"), { name: "syncs" });
    await addWorkRoles(seeded.board);
    await seeded.board.addProject(USER, { slug: "lab" });
    await seeded.board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["lab"],
    });
    return seeded;
  }

  it("holds a runner with no copy from its hello until its copy is synced, then runs the turn queued meanwhile", async () => {
    const { board } = await seed();
    const ran: string[] = [];
    // The first copy's stream answers only once the test lets it.
    const release = Promise.withResolvers<void>();
    const gated: typeof fetch = async (input, init) => {
      if (urlOf(input).pathname === "/runner/board/stream") {
        await release.promise;
      }
      return fetch(input, init);
    };
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({ claude: recording(ran)("claude") }),
      fetch: gated,
      waitForSync: false,
    });
    await board.placeProject("lab", "pod");
    const scheduler = new Scheduler({
      board,
      runner: society.hub,
      timings: { debounceMs: 0, userDebounceMs: 0, heartbeatMs: 3_600_000 },
    });

    // The runner says it is copying, and everything that reads its record sees it held.
    await expect
      .poll(async () => (await board.readRunner("pod")).sync?.phase, { timeout: 10_000 })
      .toBe("copying");
    const syncing = await board.readRunner("pod");
    expect(runnerSyncing(syncing)).toBeDefined();
    expect(heldOn([syncing], "pod", "claude", new Date())).toBe(true);
    expect(syncing.paused).toBeUndefined();

    await board.requestWake(USER, { agent: "eng-1", project: "lab", reason: "work" });
    for (let i = 0; i < 3; i += 1) {
      await scheduler.tick();
    }
    expect(ran).toEqual([]);

    release.resolve();
    await expect
      .poll(async () => (await board.readRunner("pod")).sync?.phase, { timeout: 10_000 })
      .toBe("done");
    // The copy holds every file the board serves, before any turn's own pull.
    const copiedAtDone = await filesUnder(society.runner.paths.board);
    const servedAtDone = Object.keys(await board.boardManifest()).toSorted((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    expect(ran).toEqual([]);
    await expect
      .poll(
        async () => {
          await scheduler.tick();
          return ran;
        },
        { timeout: 10_000 },
      )
      .toContain("eng-1@pod");
    await scheduler.drain();

    const synced = await board.readRunner("pod");
    expect(heldOn([synced], "pod", "claude", new Date())).toBe(false);
    expect(synced.sync).toMatchObject({ phase: "done", attempt: 1 });
    expect(synced.sync?.files).toBe(synced.sync?.totalFiles);
    expect(copiedAtDone).toEqual(servedAtDone);
    expect(copiedAtDone.length).toBe(synced.sync?.totalFiles);
    const events = await board.readEvents(null, 10_000);
    expect(events.filter((event) => event.type === "runner.synced")).toHaveLength(1);
  });

  it("finishes a first copy whose stream is cut on its next try, asking only for what it lacks, and fails no turn", async () => {
    const { board } = await seed();
    // A board large enough that a cut lands partway: 300 files of 2 KB that do not compress.
    const bulk = path.join(board.paths.board, "society", "bulk");
    await mkdir(bulk, { recursive: true });
    for (let i = 0; i < 300; i += 1) {
      await writeFile(
        path.join(bulk, `f${String(i).padStart(3, "0")}.md`),
        randomBytes(1024).toString("hex"),
      );
    }
    const ran: string[] = [];
    const asked: (string | null)[] = [];
    // What the copy held as each stream was asked for, once the test knows where it is.
    const held: string[][] = [];
    const started = Promise.withResolvers<string>();
    const cutting: typeof fetch = async (input, init) => {
      const url = urlOf(input);
      if (url.pathname !== "/runner/board/stream") {
        return fetch(input, init);
      }
      asked.push(url.searchParams.get("after"));
      if (asked.length > 1) {
        held.push(await filesUnder(await started.promise));
      }
      const response = await fetch(input, init);
      if (asked.length > 1 || response.body === null) {
        return response;
      }
      // The first answer is cut after 200 KB, as a proxy that drops a long answer does.
      const reader = response.body.getReader();
      let sent = 0;
      const cut = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await reader.read();
          if (done || sent >= 200_000) {
            await reader.cancel();
            // The cut comes a moment after the last bytes, which the copy has taken by then.
            await new Promise((resolve) => setTimeout(resolve, 100));
            controller.error(
              new TypeError("terminated", { cause: new Error("other side closed") }),
            );
            return;
          }
          sent += value.byteLength;
          controller.enqueue(value);
        },
      });
      return new Response(cut, { status: response.status, headers: response.headers });
    };
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({ claude: recording(ran)("claude") }),
      fetch: cutting,
      waitForSync: false,
    });
    started.resolve(society.runner.paths.board);
    await board.placeProject("lab", "pod");
    const scheduler = new Scheduler({
      board,
      runner: society.hub,
      timings: { debounceMs: 0, userDebounceMs: 0, heartbeatMs: 3_600_000 },
    });
    await board.requestWake(USER, { agent: "eng-1", project: "lab", reason: "work" });

    await expect
      .poll(async () => (await board.readRunner("pod")).sync?.phase, { timeout: 20_000 })
      .toBe("done");
    // The first try wrote part of the board; the second asked from the last file it wrote, which
    // the copy held with every file before it.
    expect(asked).toHaveLength(2);
    expect(asked[0]).toBeNull();
    const before = held[0] ?? [];
    expect(before.length).toBeGreaterThan(0);
    expect(before.filter((file) => file.startsWith("society/bulk/")).length).toBeLessThan(300);
    expect(asked[1]).toBe(before.at(-1));
    const record = await board.readRunner("pod");
    expect(record.sync).toMatchObject({ phase: "done", attempt: 2 });

    await expect
      .poll(
        async () => {
          await scheduler.tick();
          return ran;
        },
        { timeout: 10_000 },
      )
      .toContain("eng-1@pod");
    await scheduler.drain();
    const events = await board.readEvents(null, 10_000);
    expect(events.filter((event) => event.type === "turn.failed")).toEqual([]);
    expect(await filesUnder(path.join(society.runner.paths.board, "society", "bulk"))).toHaveLength(
      300,
    );
  });

  it("never holds a runner from before connecting synced, and holds one that says it syncs until it reports done", async () => {
    const { board } = await seed();
    await board.addProject(USER, { slug: "yard" });
    await board.addAgent(USER, {
      name: "eng-2",
      role: "engineer",
      cli: "claude",
      memberships: ["yard"],
    });
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({ claude: recording([])("claude") }),
    });
    const { hub } = society;
    for (const [name, boardSync] of [
      ["old", false],
      ["new", true],
    ] as const) {
      await board.addRunner(USER, name);
      await hub.register(
        name,
        RunnerHelloSchema.parse({
          protocol: RUNNER_PROTOCOL,
          version: "test",
          os: "linux",
          clis: ["claude"],
          slots: null,
          ...(boardSync ? { boardSync } : {}),
        }),
      );
      await hub.attach(name, () => true);
    }
    expect((await board.readRunner("old")).sync).toBeUndefined();
    await board.placeProject("lab", "old");
    expect(await hub.assign(dispatch("eng-1", "lab"))).toEqual({ runner: "old" });

    expect((await board.readRunner("new")).sync).toMatchObject({ phase: "starting" });
    await board.placeProject("yard", "new");
    expect(await hub.assign(dispatch("eng-2", "yard"))).toBeNull();
    await hub.boardSync("new", {
      phase: "copying",
      files: 6_200,
      totalFiles: 15_152,
      bytes: 1,
      totalBytes: 2,
      attempt: 3,
      error: "fetch failed, caused by SocketError: other side closed",
      retryInMs: 4_000,
    });
    expect(await hub.assign(dispatch("eng-2", "yard"))).toBeNull();
    expect((await board.readRunner("new")).sync).toMatchObject({
      phase: "copying",
      files: 6_200,
      totalFiles: 15_152,
      attempt: 3,
      error: "fetch failed, caused by SocketError: other side closed",
    });
    await hub.boardSync("new", {
      phase: "done",
      files: 15_152,
      totalFiles: 15_152,
      bytes: 2,
      totalBytes: 2,
      attempt: 4,
    });
    expect(await hub.assign(dispatch("eng-2", "yard"))).toEqual({ runner: "new" });
  });

  it("streams the board only to a runner's token, from a relative path, as the runner reads it", async () => {
    const { board, userToken } = await seed();
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({ claude: recording([])("claude") }),
    });
    const { token } = await board.addRunner(USER, "reader");
    const stream = (query: string, bearer: string): Promise<Response> =>
      fetch(`${society?.url}/runner/board/stream${query}`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
    expect((await stream("", userToken)).status).toBe(401);
    for (const after of ["../x", "/etc/passwd", "a//b", "a/./b"]) {
      expect((await stream(`?after=${encodeURIComponent(after)}`, token)).status).toBe(400);
    }

    const response = await stream("", token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    const files: Record<string, string> = {};
    let start: unknown = null;
    let ended = false;
    for await (const record of readTreeStream(response.body ?? new ReadableStream())) {
      if (record.kind === "file") {
        files[record.path] = record.version;
      } else if (record.kind === "start") {
        start = record;
      } else {
        ended = true;
      }
    }
    expect(ended).toBe(true);
    const manifest = await board.boardManifest();
    expect(files).toEqual(manifest);
    expect(start).toMatchObject({ files: Object.keys(manifest).length, skippedFiles: 0 });
  });
});
