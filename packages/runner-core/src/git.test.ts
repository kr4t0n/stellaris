import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecaGit, taskBranch } from "./git.js";

const project = { slug: "demo", origin: null, defaultBranch: "main" };

async function rev(repo: string, ref: string): Promise<string> {
  return (await execa("git", ["rev-parse", ref], { cwd: repo })).stdout.trim();
}

function committer(name: string): string[] {
  return ["-c", `user.name=${name}`, "-c", `user.email=${name}@x`];
}

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

  it("keeps a thread's worktree detached and as its turns left it, and hands a task branch back from it", async () => {
    const repoDir = await git.ensureRepo(project, path.join(dir, "repos", "demo"));
    await git.ensureWorktree(repoDir, path.join(dir, "wt", "eng-1", "demo"), "agent/eng-1", "main");
    const worktree = await git.ensureThreadWorktree(
      repoDir,
      path.join(dir, "wt", "eng-1", ".threads", "t1"),
      "agent/eng-1",
    );
    const head = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree });
    expect(head.stdout).toBe("HEAD");
    expect(await rev(worktree, "HEAD")).toBe(await rev(repoDir, "agent/eng-1"));

    // The next turn of the thread finds what the last one left, even after its branch moved on.
    await writeFile(path.join(worktree, "draft.md"), "draft\n", "utf8");
    await execa("git", [...committer("eng-1"), "commit", "--allow-empty", "-m", "moved"], {
      cwd: path.join(dir, "wt", "eng-1", "demo"),
    });
    expect(await git.ensureThreadWorktree(repoDir, worktree, "agent/eng-1")).toBe(worktree);
    expect(await readFile(path.join(worktree, "draft.md"), "utf8")).toBe("draft\n");
    expect(await rev(worktree, "HEAD")).not.toBe(await rev(repoDir, "agent/eng-1"));

    // Work for a task goes on its branch, which the hand-back commits and lets go by detaching.
    const branch = taskBranch("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await git.ensureBranch(repoDir, branch, "main");
    await execa("git", ["switch", branch], { cwd: worktree });
    const author = { name: "eng-1", email: "eng-1@stellaris.local" };
    expect(await git.handBack(worktree, null, author)).toEqual({ branch, committed: true });
    const after = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree });
    expect(after.stdout).toBe("HEAD");

    await git.removeWorktree(repoDir, worktree);
    const list = await execa("git", ["worktree", "list", "--porcelain"], { cwd: repoDir });
    expect(list.stdout).not.toContain(".threads");
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

  it("lists what a task's branch changed since it left main, before and after the board lands it", async () => {
    const repoDir = await git.ensureRepo(project, path.join(dir, "repos", "demo"));
    const commit = async (cwd: string, name: string, message: string) => {
      await execa("git", [...committer(name), "add", "-A"], { cwd });
      await execa("git", [...committer(name), "commit", "--quiet", "-m", message], { cwd });
    };
    await writeFile(path.join(repoDir, "README.md"), "demo\n");
    await writeFile(path.join(repoDir, "old.txt"), "gone soon\n");
    await commit(repoDir, "user", "docs: readme");
    const branch = taskBranch("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await git.ensureBranch(repoDir, branch, "main");
    const worktree = await git.ensureTaskWorktree(repoDir, path.join(dir, "wt", "task"), branch);
    expect(await git.branchChanges(repoDir, branch, "main", 10)).toMatchObject({
      files: [],
      total: 0,
    });

    await writeFile(path.join(worktree, "report.md"), "# Report\n\nfirst\n");
    await writeFile(path.join(worktree, "plot.png"), Buffer.from([0, 1, 2]));
    await commit(worktree, "sage", "feat: report");
    await writeFile(path.join(worktree, "report.md"), "# Report\n\nsecond\n");
    await writeFile(path.join(worktree, "README.md"), "demo, reviewed\n");
    await rm(path.join(worktree, "old.txt"));
    await commit(worktree, "ref", "fix: review");
    // Work that reached main meanwhile, merged into the task's branch, is not the task's change.
    await writeFile(path.join(repoDir, "elsewhere.md"), "another task\n");
    await commit(repoDir, "ada", "feat: elsewhere");
    await execa("git", [...committer("ref"), "merge", "--quiet", "--no-edit", "main"], {
      cwd: worktree,
    });

    const before = await git.branchChanges(repoDir, branch, "main", 10);
    expect(before?.head.id).toBe(await git.head(repoDir, branch));
    expect(before?.total).toBe(4);
    expect(
      before?.files.map((file) => [
        file.path,
        file.status,
        file.added,
        file.removed,
        file.lastChange?.author,
      ]),
    ).toEqual([
      ["README.md", "modified", 1, 1, "ref"],
      ["old.txt", "deleted", 0, 1, "ref"],
      ["plot.png", "added", null, null, "sage"],
      ["report.md", "added", 3, 0, "ref"],
    ]);
    // A short list says how many files there were.
    expect(await git.branchChanges(repoDir, branch, "main", 2)).toMatchObject({ total: 4 });
    expect((await git.branchChanges(repoDir, branch, "main", 2))?.files).toHaveLength(2);

    // Landed, the branch is all on main, and the list still counts from where it left.
    await git.handBack(worktree, null, { name: "ref", email: "ref@x" });
    await writeFile(path.join(repoDir, "later.md"), "after the task\n");
    await commit(repoDir, "ada", "feat: later");
    expect((await git.merge(repoDir, "main", branch)).ok).toBe(true);
    await writeFile(path.join(repoDir, "after.md"), "after landing\n");
    await commit(repoDir, "ada", "feat: after");
    expect(await git.branchChanges(repoDir, branch, "main", 10)).toEqual(before);
    expect(await git.branchChanges(repoDir, "task/none", "main", 10)).toBeNull();
  });

  it("makes sure of a project's new default branch: from the remote, else where the clone stands", async () => {
    // A local repository: the new branch starts where the clone stands, and is left alone after.
    const local = await git.ensureRepo(project, path.join(dir, "repos", "demo"));
    await git.ensureDefaultBranch(local, { ...project, defaultBranch: "trunk" });
    expect(await rev(local, "trunk")).toBe(await rev(local, "main"));
    await execa("git", [...committer("eng-1"), "commit", "--allow-empty", "-m", "more"], {
      cwd: local,
    });
    await git.ensureDefaultBranch(local, { ...project, defaultBranch: "trunk" });
    expect(await rev(local, "trunk")).not.toBe(await rev(local, "main"));

    // A clone of a remote that has the branch takes the remote's, with its own history.
    const origin = path.join(dir, "origin");
    await execa("git", ["init", "-b", "main", origin]);
    await execa("git", [...committer("u"), "commit", "--allow-empty", "-m", "root"], {
      cwd: origin,
    });
    await execa("git", ["switch", "-c", "release"], { cwd: origin });
    await execa("git", [...committer("u"), "commit", "--allow-empty", "-m", "cut"], {
      cwd: origin,
    });
    await execa("git", ["switch", "main"], { cwd: origin });
    const remote = { slug: "remote", origin, defaultBranch: "main" };
    const clone = await git.ensureRepo(remote, path.join(dir, "repos", "remote"));
    await git.ensureDefaultBranch(clone, { ...remote, defaultBranch: "release" });
    expect(await rev(clone, "release")).toBe(await rev(origin, "release"));
    // One the remote lacks starts where the clone stands, as for a local repository.
    await git.ensureDefaultBranch(clone, { ...remote, defaultBranch: "next" });
    expect(await rev(clone, "next")).toBe(await rev(clone, "HEAD"));
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
