import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");

describe("RunnerDaemon", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-daemon-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
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
