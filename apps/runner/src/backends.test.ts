import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliKindSchema, loadRunnerConfig } from "@stellaris/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { antigravityOptions, buildBackends } from "./backends.js";

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

  it("points agy at the folder STELLARIS_GEMINI_DIR names, made absolute, and only one called .gemini", () => {
    expect(antigravityOptions({})).toEqual({});
    expect(antigravityOptions({ STELLARIS_GEMINI_DIR: " " })).toEqual({});
    expect(antigravityOptions({ STELLARIS_GEMINI_DIR: "/srv/agy/.gemini" })).toEqual({
      geminiDir: "/srv/agy/.gemini",
    });
    expect(antigravityOptions({ STELLARIS_GEMINI_DIR: "agy/.gemini/" })).toEqual({
      geminiDir: path.resolve("agy/.gemini"),
    });
    expect(() => antigravityOptions({ STELLARIS_GEMINI_DIR: "/srv/agy" })).toThrow(
      "STELLARIS_GEMINI_DIR must name a folder called .gemini, not /srv/agy",
    );
    expect(() =>
      buildBackends(["antigravity"], { ...settings, env: { STELLARIS_GEMINI_DIR: "/srv/agy" } }),
    ).toThrow("STELLARIS_GEMINI_DIR");
    // A runner without Antigravity never reads the setting.
    expect(
      Object.keys(buildBackends(["claude"], { ...settings, env: { STELLARIS_GEMINI_DIR: "x" } })),
    ).toEqual(["claude"]);
  });

  it("starts the agy on the PATH, with telemetry off and the folder STELLARIS_GEMINI_DIR names", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-backends-"));
    try {
      const args = path.join(dir, "args");
      await writeFile(path.join(dir, "agy"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\n`, {
        mode: 0o755,
      });
      vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env["PATH"] ?? ""}`);
      const geminiDir = path.join(dir, ".gemini");
      const backends = buildBackends(["antigravity"], {
        ...settings,
        env: { STELLARIS_GEMINI_DIR: geminiDir },
      });
      // The stand-in exits at once, so the question fails once agy has been started.
      await expect(backends.antigravity?.listModels?.()).rejects.toThrow("agy acp exited");
      const given = (await readFile(args, "utf8")).trimEnd().split("\n");
      expect(given[0]).toBe("acp");
      expect(given).toContain("--disable-telemetry");
      expect(given.slice(given.indexOf("--gemini-dir"))).toEqual(["--gemini-dir", geminiDir]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
