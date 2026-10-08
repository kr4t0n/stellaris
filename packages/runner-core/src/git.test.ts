import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecaGit, taskBranch } from "./git.js";

const project = { slug: "demo", origin: null, defaultBranch: "main" };

describe("ExecaGit", () => {
  let dir: string;
  const git = new ExecaGit();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-git-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("initializes a local repo, adds a worktree, and lands the branch on main", async () => {
    const repoDir = await git.ensureRepo(project, path.join(dir, "repos", "demo"));
    expect(await git.ensureRepo(project, repoDir)).toBe(repoDir);

    const worktree = await git.ensureWorktree(
      repoDir,
      path.join(dir, "wt", "eng-1", "demo"),
      "agent/eng-1",
      "main",
    );
    await writeFile(path.join(worktree, "hello.txt"), "hello\n", "utf8");
    await execa(
      "git",
      ["-c", "user.name=eng-1", "-c", "user.email=eng-1@stellaris.local", "add", "hello.txt"],
      { cwd: worktree },
    );
    await execa(
      "git",
      [
        "-c",
        "user.name=eng-1",
        "-c",
        "user.email=eng-1@stellaris.local",
        "commit",
        "-m",
        "feat: hello",
      ],
      { cwd: worktree },
    );

    const merged = await git.merge(repoDir, "main", "agent/eng-1");
    expect(merged.ok).toBe(true);
    const log = await execa("git", ["log", "--oneline", "main"], { cwd: repoDir });
    expect(log.stdout).toContain("feat: hello");
    expect(log.stdout).toContain("merge: land agent/eng-1 on main");

    // Re-adding the worktree for an existing branch is idempotent.
    expect(await git.ensureWorktree(repoDir, worktree, "agent/eng-1", "main")).toBe(worktree);
  });

  it("places a worktree given by a relative path next to the server, never inside the clone", async () => {
    const repoDir = await git.ensureRepo(project, path.join(dir, "repos", "demo"));
    // Relative to the process, as the documented default data directory `./data` is.
    const relative = path.relative(process.cwd(), path.join(dir, "wt", "rel", "demo"));
    expect(path.isAbsolute(relative)).toBe(false);
    const worktree = await git.ensureWorktree(repoDir, relative, "agent/rel", "main");
    expect(worktree).toBe(path.join(dir, "wt", "rel", "demo"));
    const list = await execa("git", ["worktree", "list", "--porcelain"], { cwd: repoDir });
    expect(list.stdout).toContain(`worktree ${path.join(dir, "wt", "rel", "demo")}`);
    expect(list.stdout).not.toContain(path.join(repoDir, "tmp"));
    expect(await git.ensureWorktree(repoDir, relative, "agent/rel", "main")).toBe(worktree);
  });

  it("hands a task branch back: commits what a turn left and returns to the agent's own branch", async () => {
    const repoDir = await git.ensureRepo(project, path.join(dir, "repos", "demo"));
    const worktree = await git.ensureWorktree(
      repoDir,
      path.join(dir, "wt", "eng-1", "demo"),
      "agent/eng-1",
      "main",
    );
    const branch = taskBranch("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await git.ensureBranch(repoDir, branch, "main");
    await git.ensureBranch(repoDir, branch, "main");
    const author = { name: "eng-1", email: "eng-1@stellaris.local" };
    expect(await git.handBack(worktree, "agent/eng-1", author)).toBeNull();

    await execa("git", ["switch", branch], { cwd: worktree });
    await writeFile(path.join(worktree, "notes.md"), "half done\n", "utf8");
    expect(await git.handBack(worktree, "agent/eng-1", author)).toEqual({
      branch,
      committed: true,
    });
    const head = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree });
    expect(head.stdout).toBe("agent/eng-1");
    const log = await execa("git", ["log", "-1", "--format=%an %s", branch], { cwd: repoDir });
    expect(log.stdout).toBe("eng-1 wip: left uncommitted by eng-1 at the end of a turn");
    const tip = await execa("git", ["rev-parse", branch], { cwd: repoDir });
    expect(await git.head(repoDir, branch)).toBe(tip.stdout.trim());
    expect(await git.head(repoDir, "task/none")).toBeNull();

    // The next holder, in another worktree, can check the branch out and finds the work.
    const other = await git.ensureWorktree(
      repoDir,
      path.join(dir, "wt", "eng-2", "demo"),
      "agent/eng-2",
      "main",
    );
    await execa("git", ["switch", branch], { cwd: other });
    expect(await readFile(path.join(other, "notes.md"), "utf8")).toBe("half done\n");
    expect((await git.merge(repoDir, "main", branch)).ok).toBe(true);
  });

  it("reads a file or a folder on a branch as its newest commit has it, byte for byte", async () => {
    const repoDir = await git.ensureRepo(project, path.join(dir, "repos", "demo"));
    const branch = taskBranch("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await git.ensureBranch(repoDir, branch, "main");
    const worktree = await git.ensureTaskWorktree(repoDir, path.join(dir, "wt", "task"), branch);
    const text = "# Report\n\n![](evidence/plot.png)\n";
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0a]);
    await mkdir(path.join(worktree, "evidence", "nested"), { recursive: true });
    await writeFile(path.join(worktree, "report.md"), text);
    await writeFile(path.join(worktree, "evidence", "plot.png"), png);
    await writeFile(path.join(worktree, "evidence", "nested", "raw.csv"), "a,b\n1,2\n");
    await writeFile(path.join(worktree, "big.bin"), Buffer.alloc(64));
    const author = { name: "sage", email: "sage@stellaris.local" };
    await git.handBack(worktree, null, author);
    // Left uncommitted after the hand-back, so not on the branch.
    await writeFile(path.join(worktree, "draft.md"), "not yet\n");

    const report = await git.readBranch(repoDir, branch, "report.md", 1024);
    expect(report).toMatchObject({ kind: "file", path: "report.md", size: text.length });
    expect(report?.commit.author).toBe("sage");
    expect(report?.commit.id).toBe(await git.head(repoDir, branch));
    const content = report?.kind === "file" ? (report.content ?? "") : "";
    expect(Buffer.from(content, "base64").toString()).toBe(text);
    const plot = await git.readBranch(repoDir, branch, "evidence/plot.png", 1024);
    expect(plot?.kind === "file" ? Buffer.from(plot.content ?? "", "base64") : null).toEqual(png);
    expect(await git.readBranch(repoDir, branch, "big.bin", 32)).toMatchObject({
      kind: "file",
      size: 64,
      content: null,
    });
    expect(await git.readBranch(repoDir, branch, "evidence", 1024)).toMatchObject({
      kind: "dir",
      entries: [
        { name: "nested", kind: "dir", size: null },
        { name: "plot.png", kind: "file", size: png.length },
      ],
    });
    const root = await git.readBranch(repoDir, branch, "", 1024);
    expect(root?.kind === "dir" ? root.entries.map((entry) => entry.name) : null).toEqual([
      "big.bin",
      "evidence",
      "report.md",
    ]);
    expect(await git.readBranch(repoDir, branch, "draft.md", 1024)).toBeNull();
    expect(await git.readBranch(repoDir, "task/none", "report.md", 1024)).toBeNull();
  });

  it("reports missing branches and aborts conflicting merges cleanly", async () => {
    const repoDir = await git.ensureRepo(project, path.join(dir, "repos", "demo"));
    expect(await git.merge(repoDir, "main", "agent/nobody")).toMatchObject({ ok: false });

    const identity = ["-c", "user.name=t", "-c", "user.email=t@t"];
    await writeFile(path.join(repoDir, "f.txt"), "main\n", "utf8");
    await execa("git", [...identity, "add", "f.txt"], { cwd: repoDir });
    await execa("git", [...identity, "commit", "-m", "main change"], { cwd: repoDir });
    const worktree = await git.ensureWorktree(
      repoDir,
      path.join(dir, "wt", "a"),
      "agent/a",
      "main~1",
    );
    await writeFile(path.join(worktree, "f.txt"), "branch\n", "utf8");
    await execa("git", [...identity, "add", "f.txt"], { cwd: worktree });
    await execa("git", [...identity, "commit", "-m", "branch change"], { cwd: worktree });

    const outcome = await git.merge(repoDir, "main", "agent/a");
    expect(outcome.ok).toBe(false);
    const status = await execa("git", ["status", "--porcelain"], { cwd: repoDir });
    expect(status.stdout).toBe("");
  });
});
