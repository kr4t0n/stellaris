import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerHttpError } from "./client.js";
import { EventSender, persist } from "./daemon.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");

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
