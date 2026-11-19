import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerHttpError } from "./client.js";
import { EventSender, createRunner, persist } from "./daemon.js";
import { GitIdentityCheck } from "./git-identity.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * A server for one runner, as one sees it once the user removed the runner: it welcomes the first
 * hello, opens a stream that carries `frames` and ends, and refuses every later hello with a 401.
 * Each hello's status is kept in order.
 */
function removingServer(frames: readonly string[]): { fetch: typeof fetch; hellos: number[] } {
  const hellos: number[] = [];
  const serve: typeof fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/runner/hello") {
      hellos.push(hellos.length === 0 ? 200 : 401);
      return Promise.resolve(
        hellos.length === 1
          ? Response.json({ name: "pod", version: "test" })
          : Response.json({ error: "UNAUTHORIZED" }, { status: 401 }),
      );
    }
    if (url.pathname === "/runner/stream") {
      return Promise.resolve(new Response(frames.join(""), { status: 200 }));
    }
    return Promise.resolve(Response.json({ ok: true }));
  };
  return { fetch: serve, hellos };
}

/** A runner on `serve` that tries again after 20 ms, doubling, and keeps what it warns of. */
function runnerOn(dir: string, serve: typeof fetch) {
  const warnings: string[] = [];
  const log = {
    info() {},
    warn(_context: object, message: string) {
      warnings.push(message);
    },
    error(_context: object, message: string) {
      warnings.push(message);
    },
  };
  const runner = createRunner({
    serverUrl: "http://server",
    token: "test",
    dataDir: dir,
    backends: {},
    version: "test",
    slots: 1,
    retryMs: 20,
    fetch: serve,
    log,
    gitIdentity: new GitIdentityCheck(log, () => Promise.resolve([])),
  });
  return { runner, warnings };
}

describe("RunnerDaemon", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-daemon-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("posts a turn's steps again while the server is out of reach, in order, and stops when refused", async () => {
    const posted: string[][] = [];
    let failures = 2;
    const warnings: string[] = [];
    const log = {
      info() {},
      warn(_context: object, message: string) {
        warnings.push(message);
      },
      error(_context: object, message: string) {
        warnings.push(message);
      },
    };
    const sender = new EventSender(
      (entries) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new TypeError("fetch failed"));
        }
        posted.push(entries.map((entry) => (entry.event.type === "text" ? entry.event.delta : "")));
        return Promise.resolve();
      },
      log,
      { retryMs: 5, forMs: 1_000 },
    );
    sender.push({ type: "text", delta: "one" });
    await sender.flush();
    sender.push({ type: "text", delta: "two" });
    await sender.flush();
    expect(posted).toEqual([["one"], ["two"]]);
    expect(warnings).toEqual(["could not post a turn's steps", "could not post a turn's steps"]);

    // A refusal, as for a turn the server has already ended, is not tried again.
    let calls = 0;
    const refused = await persist(
      () => {
        calls += 1;
        return Promise.reject(new RunnerHttpError(404, "no such turn"));
      },
      { retryMs: 5, forMs: 1_000 },
      () => undefined,
    );
    expect(refused).toBeNull();
    expect(calls).toBe(1);
  });

  it("stops when the server says the user removed it, and asks no more", async () => {
    const server = removingServer([
      ": attached\n\n",
      `event: removed\ndata: ${JSON.stringify({ type: "removed" })}\n\n`,
    ]);
    const { runner, warnings } = runnerOn(dir, server.fetch);
    await runner.start();
    await runner.removed;
    // Asking again would have come after 20 ms, then 40 and 80.
    await wait(300);
    expect(server.hellos).toEqual([200]);
    expect(warnings).toEqual(["the board removed this runner; stopping"]);
    await runner.stop();
  });

  it("keeps asking after a 401 once its stream had opened, with no word that it was removed", async () => {
    const server = removingServer([": attached\n\n"]);
    const { runner, warnings } = runnerOn(dir, server.fetch);
    await runner.start();
    // As from a server restored from an older copy, which may know the token again.
    await expect.poll(() => server.hellos.length).toBeGreaterThanOrEqual(4);
    expect(server.hellos.slice(0, 4)).toEqual([200, 401, 401, 401]);
    expect(warnings.slice(0, 3)).toEqual(Array(3).fill("runner connection failed"));
    expect(await Promise.race([runner.removed.then(() => true), wait(0, false)])).toBe(false);
    await runner.stop();
  });

  // Inside the test process something always holds the event loop, so only a process of its own
  // shows whether the runner stays up between attempts.
  it("stays up and keeps trying while the server is unreachable", async () => {
    const script = [
      `import { createRunner } from ${JSON.stringify(path.join(import.meta.dirname, "daemon.ts"))};`,
      "const runner = createRunner({",
      '  serverUrl: "http://127.0.0.1:9",',
      '  token: "test",',
      `  dataDir: ${JSON.stringify(dir)},`,
      "  backends: {},",
      '  version: "test",',
      "  slots: 1,",
      "  retryMs: 20,",
      "});",
      "void runner.start();",
    ].join("\n");
    const child = execa(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: ROOT, reject: false },
    );
    const exited = await Promise.race([child.then((result) => result), wait(1_500, null)]);
    child.kill();
    await child;
    expect(exited?.stderr ?? "").toBe("");
    expect(exited).toBeNull();
  });
});
