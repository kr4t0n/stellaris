import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliKindSchema, loadRunnerConfig } from "@stellaris/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBackends } from "./backends.js";

const settings = { env: {}, stderr: () => undefined };

describe("the runner's backends", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a backend for every CLI it is configured with, and for no other", () => {
    for (const cli of CliKindSchema.options) {
      const backends = buildBackends([cli], settings);
      expect(Object.keys(backends)).toEqual([cli]);
      expect(backends[cli]?.kind).toBe(cli);
    }
    const all = buildBackends(CliKindSchema.options, settings);
    expect(Object.values(all).map((backend) => backend.kind)).toEqual(CliKindSchema.options);
  });

  it("runs Antigravity only where STELLARIS_CLIS names it", () => {
    const unset = loadRunnerConfig({});
    expect(Object.keys(buildBackends(unset.clis, settings))).toEqual(["claude", "codex"]);
    const named = loadRunnerConfig({ STELLARIS_CLIS: "antigravity" });
    expect(buildBackends(named.clis, settings).antigravity?.kind).toBe("antigravity");
    expect(() => loadRunnerConfig({ STELLARIS_CLIS: "gemini" })).toThrow('"invalid_value"');
  });

  it("starts the agy on the PATH, with telemetry off and its own state folder", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-backends-"));
    try {
      const args = path.join(dir, "args");
      await writeFile(path.join(dir, "agy"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\n`, {
        mode: 0o755,
      });
      vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env["PATH"] ?? ""}`);
      const backends = buildBackends(["antigravity"], settings);
      // The stand-in exits at once, so the question fails once agy has been started.
      await expect(backends.antigravity?.listModels?.()).rejects.toThrow("agy acp exited");
      const given = (await readFile(args, "utf8")).trimEnd().split("\n");
      expect(given[0]).toBe("acp");
      expect(given).toContain("--disable-telemetry");
      // agy keeps its state in ~/.gemini, where its quota read, which takes no flag, looks too.
      expect(given).not.toContain("--gemini-dir");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
