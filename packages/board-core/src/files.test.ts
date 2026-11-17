import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BoardStreamStart } from "@stellaris/shared";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTree, type StreamedFile } from "./files.js";

async function collect(
  records: AsyncGenerator<BoardStreamStart | StreamedFile>,
): Promise<{ start: BoardStreamStart | null; files: StreamedFile[] }> {
  let start: BoardStreamStart | null = null;
  const files: StreamedFile[] = [];
  for await (const record of records) {
    if ("content" in record) {
      files.push(record);
    } else {
      start = record;
    }
  }
  return { start, files };
}

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

  it("streams regular files in path order from after a path, with the totals of all and of those left out", async () => {
    await mkdir(path.join(dir, "projects", "lab", "threads"), { recursive: true });
    await writeFile(path.join(dir, "society.md"), "# society\n");
    await writeFile(path.join(dir, "projects", "lab", "project.md"), "lab\n");
    await writeFile(path.join(dir, "projects", "lab", "threads", "a.md"), "first\n");
    await writeFile(path.join(dir, "projects", "lab", "threads", "b.md"), "second\n");
    await writeFile(path.join(dir, "projects", "lab", "threads", "c.md.123.tmp"), "half");
    await writeFile(path.join(dir, "run.sh"), "#!/bin/sh\n");
    await chmod(path.join(dir, "run.sh"), 0o755);
    const tree = new FileTree();

    const whole = await collect(tree.stream(dir, null, () => true));
    expect(whole.files.map((file) => file.path)).toEqual([
      "projects/lab/project.md",
      "projects/lab/threads/a.md",
      "projects/lab/threads/b.md",
      "run.sh",
      "society.md",
    ]);
    expect(whole.start).toEqual({ files: 5, bytes: 37, skippedFiles: 0, skippedBytes: 0 });
    const manifest = await tree.manifest(dir, () => true);
    for (const file of whole.files) {
      expect(file.version).toBe(manifest[file.path]);
      expect(createHash("sha256").update(file.content).digest("hex")).toBe(
        file.version.replace(/\+x$/, ""),
      );
    }
    expect(whole.files.find((file) => file.path === "run.sh")?.version).toMatch(/\+x$/);

    const rest = await collect(tree.stream(dir, "projects/lab/threads/a.md", () => true));
    expect(rest.files.map((file) => file.path)).toEqual([
      "projects/lab/threads/b.md",
      "run.sh",
      "society.md",
    ]);
    expect(rest.start).toEqual({ files: 5, bytes: 37, skippedFiles: 2, skippedBytes: 10 });
  });

  it("streams no link, folder's or file's, and no FIFO, and never waits on one", async () => {
    const root = path.join(dir, "board");
    const outside = path.join(dir, "outside");
    await mkdir(path.join(root, "society"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "not the board's\n");
    await writeFile(path.join(root, "society", "society.md"), "# society\n");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "society", "secret.md"));
    await symlink(outside, path.join(root, "linked"));
    await execa("mkfifo", [path.join(root, "society", "pipe.md")]);
    const tree = new FileTree();

    const { start, files } = await collect(tree.stream(root, null, () => true));
    expect(files.map((file) => file.path)).toEqual(["society/society.md"]);
    expect(start).toEqual({ files: 1, bytes: 10, skippedFiles: 0, skippedBytes: 0 });

    // Files that turn into a link or a FIFO once listed are skipped when their turn comes.
    await writeFile(path.join(root, "society", "a.md"), "a\n");
    await writeFile(path.join(root, "society", "b.md"), "b\n");
    const records = tree.stream(root, null, () => true);
    expect((await records.next()).value).toEqual({
      files: 3,
      bytes: 14,
      skippedFiles: 0,
      skippedBytes: 0,
    });
    await rm(path.join(root, "society", "a.md"));
    await symlink(path.join(outside, "secret.txt"), path.join(root, "society", "a.md"));
    await rm(path.join(root, "society", "b.md"));
    await execa("mkfifo", [path.join(root, "society", "b.md")]);
    const rest = await collect(records);
    expect(rest.files.map((file) => file.path)).toEqual(["society/society.md"]);
  });
});
