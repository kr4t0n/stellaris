import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTree } from "./files.js";

describe("FileTree", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-files-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists an executable file's version marked, and a mode change as a new version", async () => {
    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "# skill\n");
    await writeFile(path.join(dir, "scripts", "run.sh"), "#!/bin/sh\n");
    await chmod(path.join(dir, "scripts", "run.sh"), 0o755);
    const tree = new FileTree();
    const before = await tree.manifest(dir, () => true);
    expect(before["SKILL.md"]).toMatch(/^[0-9a-f]{64}$/);
    expect(before["scripts/run.sh"]).toMatch(/^[0-9a-f]{64}\+x$/);

    await chmod(path.join(dir, "scripts", "run.sh"), 0o644);
    const after = await tree.manifest(dir, () => true);
    expect(after["scripts/run.sh"]).toBe(before["scripts/run.sh"]?.replace(/\+x$/, ""));
  });
});
