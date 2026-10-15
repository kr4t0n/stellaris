import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecaGit, taskBranch } from "./git.js";

const project = { slug: "demo", origin: null, defaultBranch: "main", boardLands: false };

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
    // A project's commit hook, as `pre-commit install` in any worktree writes it into the clone,
    // is for the citizens' own commits: on a branch without its configuration it fails them all.
    await writeFile(
      path.join(repoDir, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\necho 'No .pre-commit-config.yaml file was found' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    const own = await execa(
      "git",
      [...committer("eng-1"), "commit", "--allow-empty", "-m", "own"],
      { cwd: worktree, reject: false },
    );
    expect(own.stderr).toContain("No .pre-commit-config.yaml");
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

  it("leaves a task's branch to the turn that takes it, and moves it on to commits made beside it", async () => {
    const repoDir = await git.ensureRepo(project, path.join(dir, "repos", "demo"));
    const taskId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const branch = taskBranch(taskId);
    await git.ensureBranch(repoDir, branch, "main");
    const tip = await rev(repoDir, branch);
    const place = (agent: string) => path.join(dir, "wt", agent, ".tasks", taskId);
    const onBranch = async (worktree: string) => (await git.worktreeState(worktree)).branch;
    const commit = async (worktree: string, agent: string, message: string) => {
      await writeFile(path.join(worktree, `${message}.md`), `${message}\n`, "utf8");
      await execa("git", ["add", "-A"], { cwd: worktree });
      await execa("git", [...committer(agent), "commit", "--quiet", "-m", message], {
        cwd: worktree,
      });
      return rev(worktree, "HEAD");
    };
    const handBack = (worktree: string, agent: string) =>
      git.handBack(worktree, null, { name: agent, email: `${agent}@x` });
    const settle = () => git.settleTaskBranch(repoDir, branch, [place("ref"), place("eng-1")]);

    // A turn that leaves the branch to the stage's holder works detached even while it is free.
    const ref = await git.ensureTaskWorktree(repoDir, place("ref"), branch, false);
    expect(await onBranch(ref)).toBeNull();
    expect(await rev(ref, "HEAD")).toBe(tip);
    // A participant's turn took the branch first, so the holder's works detached at its tip.
    expect(await git.ensureTaskWorktree(repoDir, ref, branch)).toBe(ref);
    expect(await onBranch(ref)).toBe(branch);
    const eng = await git.ensureTaskWorktree(repoDir, place("eng-1"), branch);
    expect(await onBranch(eng)).toBeNull();
    const reviewed = await commit(eng, "eng-1", "review");
    // The holder's turn ends first: the hand-back has no branch to give up, and the branch, still
    // checked out, cannot move yet; the commits build on its tip, so they wait rather than stick.
    expect(await handBack(eng, "eng-1")).toBeNull();
    expect(await settle()).toEqual({ moved: null, stuck: [] });
    expect(await rev(repoDir, branch)).toBe(tip);
    // The participant's hand-back frees the branch, which moves on to the holder's commits.
    await handBack(ref, "ref");
    expect(await settle()).toEqual({ moved: reviewed, stuck: [] });
    expect(await rev(repoDir, branch)).toBe(reviewed);
    expect((await git.worktreeState(eng)).onNoBranch.total).toBe(0);
    expect(await settle()).toEqual({ moved: null, stuck: [] });

    // In the other order, the holder's own hand-back moves it, once the branch is free.
    await git.ensureTaskWorktree(repoDir, ref, branch);
    await git.ensureTaskWorktree(repoDir, eng, branch, false);
    const second = await commit(eng, "eng-1", "second");
    await handBack(ref, "ref");
    expect(await settle()).toEqual({ moved: second, stuck: [] });

    // Mid-turn, as its workspace note says, a detached turn fast-forwards the branch itself with a
    // push into the clone, which git refuses while another worktree has the branch, past the
    // default branch's guard.
    expect(await git.guardDefaultBranch(repoDir, "main")).toMatchObject({ ok: true });
    await git.ensureTaskWorktree(repoDir, ref, branch);
    await git.ensureTaskWorktree(repoDir, eng, branch, false);
    const third = await commit(eng, "eng-1", "third");
    const push = () =>
      execa("git", ["push", "--quiet", ".", `HEAD:${branch}`], { cwd: eng, reject: false });
    expect((await push()).stderr).toContain("branch is currently checked out");
    await handBack(ref, "ref");
    expect((await push()).exitCode).toBe(0);
    expect(await rev(repoDir, branch)).toBe(third);

    // Commits on one line from the tip, one worktree's built on another's, move it to the furthest.
    await git.ensureTaskWorktree(repoDir, ref, branch, false);
    const first = await commit(ref, "ref", "first");
    await execa("git", ["switch", "--quiet", "--detach", first], { cwd: eng });
    const further = await commit(eng, "eng-1", "further");
    expect(await settle()).toEqual({ moved: further, stuck: [] });
    expect(await rev(repoDir, branch)).toBe(further);
  });

  it("leaves commits beside a task's branch that no fast-forward takes where they are, and says so", async () => {
    const repoDir = await git.ensureRepo(project, path.join(dir, "repos", "demo"));
    const taskId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const branch = taskBranch(taskId);
    await git.ensureBranch(repoDir, branch, "main");
    const tip = await rev(repoDir, branch);
    const place = (agent: string) => path.join(dir, "wt", agent, ".tasks", taskId);
    const commit = async (worktree: string, agent: string, message: string) => {
      await writeFile(path.join(worktree, `${message}.md`), `${message}\n`, "utf8");
      await execa("git", ["add", "-A"], { cwd: worktree });
      await execa("git", [...committer(agent), "commit", "--quiet", "-m", message], {
        cwd: worktree,
      });
      return rev(worktree, "HEAD");
    };
    const settle = () => git.settleTaskBranch(repoDir, branch, [place("ref"), place("eng-1")]);

    // Two worktrees' commits each build on the tip: only a merge takes both, so neither moves it.
    const ref = await git.ensureTaskWorktree(repoDir, place("ref"), branch, false);
    const eng = await git.ensureTaskWorktree(repoDir, place("eng-1"), branch, false);
    const refHead = await commit(ref, "ref", "ref-work");
    const engHead = await commit(eng, "eng-1", "eng-work");
    expect(await settle()).toEqual({
      moved: null,
      stuck: [
        {
          worktree: ref,
          head: refHead,
          commits: { items: [expect.stringContaining("ref-work")], total: 1 },
        },
        {
          worktree: eng,
          head: engHead,
          commits: { items: [expect.stringContaining("eng-work")], total: 1 },
        },
      ],
    });
    expect(await rev(repoDir, branch)).toBe(tip);

    // Once the branch takes one of them, the other has left its line, checked out or not, while
    // a third's commits that build on the tip of the checked-out branch wait for its hand-back.
    await execa("git", ["update-ref", `refs/heads/${branch}`, refHead], { cwd: repoDir });
    await execa("git", ["switch", "--quiet", branch], { cwd: ref });
    const other = await git.ensureTaskWorktree(repoDir, place("eng-2"), branch, false);
    await commit(other, "eng-2", "other-work");
    expect(await git.settleTaskBranch(repoDir, branch, [ref, eng, other])).toEqual({
      moved: null,
      stuck: [
        {
          worktree: eng,
          head: engHead,
          commits: { items: [expect.stringContaining("eng-work")], total: 1 },
        },
      ],
    });
    await git.removeWorktree(repoDir, other);
    await execa("git", ["switch", "--quiet", "--detach"], { cwd: ref });
    expect((await settle()).stuck.map((each) => each.worktree)).toEqual([eng]);
    // Work that builds on the tip still moves the branch, while the other stays stuck beside it.
    const refMore = await commit(ref, "ref", "ref-more");
    expect(await settle()).toEqual({
      moved: refMore,
      stuck: [
        {
          worktree: eng,
          head: engHead,
          commits: { items: [expect.stringContaining("eng-work")], total: 1 },
        },
      ],
    });
    // A worktree left where it is keeps them, and is not switched to the branch.
    expect(await git.ensureTaskWorktree(repoDir, eng, branch)).toBe(eng);
    expect(await rev(eng, "HEAD")).toBe(engHead);
    expect(await rev(repoDir, branch)).toBe(refMore);
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

    // Each file's patch covers the same range, so main's work merged in is no file's change.
    const diff = (file: string, limit = 1000) =>
      git.branchDiff(repoDir, branch, "main", file, limit);
    const readme = await diff("README.md");
    expect(readme).toEqual({
      head: before?.head,
      path: "README.md",
      status: "modified",
      patch: "@@ -1 +1 @@\n-demo\n+demo, reviewed",
      truncated: false,
    });
    expect(await diff("report.md")).toMatchObject({
      status: "added",
      patch: "@@ -0,0 +1,3 @@\n+# Report\n+\n+second",
    });
    expect(await diff("old.txt")).toMatchObject({
      status: "deleted",
      patch: "@@ -1 +0,0 @@\n-gone soon",
    });
    expect(await diff("plot.png")).toMatchObject({ status: "added", patch: null });
    expect(await diff("elsewhere.md")).toBeNull();
    // A path is taken literally, never as a pattern.
    expect(await diff("*.md")).toBeNull();
    // A long patch is cut at a line's end.
    expect(await diff("report.md", 20)).toMatchObject({
      patch: "@@ -0,0 +1,3 @@",
      truncated: true,
    });

    // Landed, the branch is all on main, and the list still counts from where it left.
    await git.handBack(worktree, null, { name: "ref", email: "ref@x" });
    await writeFile(path.join(repoDir, "later.md"), "after the task\n");
    await commit(repoDir, "ada", "feat: later");
    expect((await git.merge(repoDir, "main", branch)).ok).toBe(true);
    await writeFile(path.join(repoDir, "after.md"), "after landing\n");
    await commit(repoDir, "ada", "feat: after");
    expect(await git.branchChanges(repoDir, branch, "main", 10)).toEqual(before);
    expect(await diff("README.md")).toEqual(readme);
    expect(await git.branchChanges(repoDir, "task/none", "main", 10)).toBeNull();
    expect(await git.branchDiff(repoDir, "task/none", "main", "README.md", 1000)).toBeNull();
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
    const remote = { slug: "remote", origin, defaultBranch: "main", boardLands: false };
    const clone = await git.ensureRepo(remote, path.join(dir, "repos", "remote"));
    await git.ensureDefaultBranch(clone, { ...remote, defaultBranch: "release" });
    expect(await rev(clone, "release")).toBe(await rev(origin, "release"));
    // One the remote lacks starts where the clone stands, as for a local repository.
    await git.ensureDefaultBranch(clone, { ...remote, defaultBranch: "next" });
    expect(await rev(clone, "next")).toBe(await rev(clone, "HEAD"));
  });

  it("restores a default branch deleted from the clone, with the landings only the clone has", async () => {
    // A merge project's clone of a remote: the board lands on main there and never pushes.
    const seed = path.join(dir, "seed");
    await execa("git", ["init", "-b", "main", seed]);
    await execa("git", [...committer("u"), "commit", "--allow-empty", "-m", "root"], {
      cwd: seed,
    });
    const origin = path.join(dir, "origin.git");
    await execa("git", ["clone", "--bare", seed, origin]);
    const repo = { slug: "lost", origin, defaultBranch: "main", boardLands: true };
    const clone = await git.ensureRepo(repo, path.join(dir, "repos", "lost"));
    expect(await git.guardDefaultBranch(clone, "main")).toMatchObject({ ok: true });
    const branch = taskBranch("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await git.ensureBranch(clone, branch, "main");
    const worktree = await git.ensureTaskWorktree(clone, path.join(dir, "wt", "t"), branch);
    await writeFile(path.join(worktree, "b.txt"), "b\n", "utf8");
    await execa("git", ["add", "b.txt"], { cwd: worktree });
    await execa("git", [...committer("eng-1"), "commit", "-m", "work"], { cwd: worktree });
    await git.handBack(worktree, null, { name: "eng-1", email: "eng-1@x" });
    expect((await git.merge(clone, "main", branch)).ok).toBe(true);
    const landed = await rev(clone, "main");
    expect(await git.ensureDefaultBranch(clone, repo)).toBeNull();

    // The guard lets a deletion through, since git's own housekeeping deletes loose refs.
    const remove = async () => {
      await execa("git", ["update-ref", "-d", "refs/heads/main"], { cwd: worktree });
      expect(await git.branchExists(clone, "main")).toBe(false);
    };
    await remove();
    expect(await git.ensureDefaultBranch(clone, repo)).toBe(
      `restored main, deleted from the clone, at ${landed.slice(0, 7)} from the clone's history`,
    );
    expect(await rev(clone, "main")).toBe(landed);
    expect((await execa("git", ["status", "--porcelain"], { cwd: clone })).stdout).toBe("");

    // Without the clone's history, the remote's main is what is left.
    await remove();
    await rm(path.join(clone, ".git", "logs", "HEAD"));
    expect(await git.ensureDefaultBranch(clone, repo)).toBe(
      "restored main, deleted from the clone, from the remote",
    );
    expect(await rev(clone, "main")).toBe(await rev(origin, "main"));

    // With neither, the runner says so rather than starting main anywhere.
    await remove();
    await rm(path.join(clone, ".git", "logs", "HEAD"));
    await expect(git.ensureDefaultBranch(clone, { ...repo, origin: null })).rejects.toThrow(
      "main was deleted from the clone, and neither the clone's history nor a remote has it",
    );
  });

  it("guards a merge project's default branch from everything but the runner", async () => {
    const seed = path.join(dir, "seed");
    await execa("git", ["init", "-b", "main", seed]);
    await writeFile(path.join(seed, "a.txt"), "a\n", "utf8");
    await execa("git", ["add", "a.txt"], { cwd: seed });
    await execa("git", [...committer("u"), "commit", "-m", "root"], { cwd: seed });
    const origin = path.join(dir, "origin.git");
    await execa("git", ["clone", "--bare", seed, origin]);
    const repo = { slug: "guarded", origin, defaultBranch: "main", boardLands: true };
    const clone = await git.ensureRepo(repo, path.join(dir, "repos", "guarded"));
    expect(await git.guardDefaultBranch(clone, "main")).toMatchObject({ ok: true });
    // Installing again rewrites nothing and keeps the guard.
    expect(await git.guardDefaultBranch(clone, "main")).toMatchObject({ ok: true });
    const branch = taskBranch("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await git.ensureBranch(clone, branch, "main");
    const worktree = await git.ensureTaskWorktree(clone, path.join(dir, "wt", "t"), branch);
    // An agent's own work on its task's branch passes.
    await writeFile(path.join(worktree, "b.txt"), "b\n", "utf8");
    await execa("git", ["add", "b.txt"], { cwd: worktree });
    await execa("git", [...committer("eng-1"), "commit", "-m", "work"], { cwd: worktree });
    const before = await rev(clone, "main");

    // Every way an agent could move main, here or on the remote, is refused with the reason.
    for (const [cwd, args] of [
      [clone, ["merge", "--no-edit", branch]],
      [clone, ["merge", "--no-ff", "--no-edit", branch]],
      [worktree, ["update-ref", "refs/heads/main", branch]],
      [worktree, ["push", "origin", `${branch}:main`]],
    ] as const) {
      const refused = await execa("git", [...committer("eng-1"), ...args], { cwd, reject: false });
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("only the runner moves it");
      // A refused merge leaves its result in the clone's tree, which the runner puts away.
      await git.tidyClone(clone);
    }
    expect(await rev(clone, "main")).toBe(before);
    expect(await rev(origin, "main")).toBe(before);
    const status = await execa("git", ["status", "--porcelain"], { cwd: clone });
    expect(status.stdout).toBe("");
    expect((await execa("git", ["stash", "list"], { cwd: clone })).stdout).toContain(
      "left in the runner's clone",
    );

    // The board's landing passes, an agent may publish main as it stands, and git gc still packs.
    expect((await git.merge(clone, "main", branch)).ok).toBe(true);
    const landed = await rev(clone, "main");
    expect(landed).not.toBe(before);
    await execa("git", ["push", "origin", "main"], { cwd: worktree });
    expect(await rev(origin, "main")).toBe(landed);
    await execa("git", ["gc", "--quiet"], { cwd: clone });
    expect(await git.tidyClone(clone)).toBe(false);

    // Lifted, as for a project whose agents land their own work, main moves for anyone.
    expect(await git.guardDefaultBranch(clone, null)).toMatchObject({ ok: true });
    await execa("git", ["update-ref", "refs/heads/main", before], { cwd: worktree });
    expect(await rev(clone, "main")).toBe(before);
  });

  it("takes the clone's hooks back from husky's hooks path and from hooks not the runner's", async () => {
    const seed = path.join(dir, "seed");
    await execa("git", ["init", "-b", "main", seed]);
    await execa("git", [...committer("u"), "commit", "--allow-empty", "-m", "root"], {
      cwd: seed,
    });
    const origin = path.join(dir, "origin.git");
    await execa("git", ["clone", "--bare", seed, origin]);
    const repo = { slug: "taken", origin, defaultBranch: "main", boardLands: true };
    const clone = await git.ensureRepo(repo, path.join(dir, "repos", "taken"));
    const branch = taskBranch("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await git.ensureBranch(clone, branch, "main");
    const worktree = await git.ensureTaskWorktree(clone, path.join(dir, "wt", "t"), branch);
    await execa("git", [...committer("eng-1"), "commit", "--allow-empty", "-m", "work"], {
      cwd: worktree,
    });
    const main = await rev(clone, "main");
    const agent = (args: readonly string[]) =>
      execa("git", [...committer("eng-1"), ...args], { cwd: worktree, reject: false });
    const hooksPath = async () =>
      (await execa("git", ["config", "--get", "core.hooksPath"], { cwd: clone, reject: false }))
        .stdout;
    expect(await git.guardDefaultBranch(clone, "main")).toEqual({
      ok: true,
      clearedHooksPath: null,
      movedHooks: [],
    });

    // husky's install, which a project's `prepare` runs on `pnpm install` in any worktree, points
    // the clone at that worktree's `.husky/_`, and git then runs none of the clone's hooks.
    await execa("git", ["config", "core.hooksPath", ".husky/_"], { cwd: worktree });
    expect((await agent(["update-ref", "refs/heads/main", branch])).exitCode).toBe(0);
    await agent(["update-ref", "refs/heads/main", main]);
    expect(await git.guardDefaultBranch(clone, "main")).toEqual({
      ok: true,
      clearedHooksPath: ".husky/_",
      movedHooks: [],
    });
    expect(await hooksPath()).toBe("");
    const moved = await agent(["update-ref", "refs/heads/main", branch]);
    expect(moved.stderr).toContain("only the runner moves it");
    expect(await rev(clone, "main")).toBe(main);
    // Several values in `.git/config`, as `git config --add` leaves them, are cleared together.
    await execa("git", ["config", "core.hooksPath", ".husky/_"], { cwd: clone });
    await execa("git", ["config", "--add", "core.hooksPath", ".githooks"], { cwd: clone });
    expect(await git.guardDefaultBranch(clone, "main")).toEqual({
      ok: true,
      clearedHooksPath: ".husky/_, .githooks",
      movedHooks: [],
    });
    expect(await hooksPath()).toBe("");

    // A hook of the guard's name that is not the runner's, as `pre-commit install --hook-type
    // pre-push` leaves it, would let any push through; it is kept aside under a name git never runs.
    const prePush = path.join(clone, ".git", "hooks", "pre-push");
    const theirs = "#!/bin/sh\nexit 0\n";
    await writeFile(prePush, theirs, { mode: 0o755 });
    expect((await agent(["push", "--dry-run", "origin", `${branch}:main`])).exitCode).toBe(0);
    expect(await git.guardDefaultBranch(clone, "main")).toEqual({
      ok: true,
      clearedHooksPath: null,
      movedHooks: ["pre-push"],
    });
    expect(await readFile(`${prePush}.replaced`, "utf8")).toBe(theirs);
    const pushed = await agent(["push", "origin", `${branch}:main`]);
    expect(pushed.stderr).toContain("only the runner moves it");
    expect(await rev(origin, "main")).toBe(main);
    // A later one is kept beside the first, not over it.
    const later = "#!/bin/sh\n# a later one\nexit 0\n";
    await writeFile(prePush, later, { mode: 0o755 });
    expect(await git.guardDefaultBranch(clone, "main")).toEqual({
      ok: true,
      clearedHooksPath: null,
      movedHooks: ["pre-push"],
    });
    expect(await readFile(`${prePush}.replaced`, "utf8")).toBe(theirs);
    expect(await readFile(`${prePush}.replaced-2`, "utf8")).toBe(later);
  });

  it("leaves a hooks path from anywhere but the clone's own .git/config, says why, and never throws", async () => {
    const repoDir = await git.ensureRepo(project, path.join(dir, "repos", "demo"));
    const own = async () =>
      (
        await execa("git", ["config", "--file", ".git/config", "--get-all", "core.hooksPath"], {
          cwd: repoDir,
        })
      ).stdout;
    const leftAlone = async (value: string, origin: string, scope: string) => {
      expect(await git.guardDefaultBranch(repoDir, "main")).toEqual({
        ok: false,
        reason: `core.hooksPath is ${value} from ${origin} in the ${scope} configuration, which the runner leaves alone`,
      });
      // Clearing the clone's own value would only hand git the other one.
      expect(await own()).toBe(".husky/_");
    };
    await execa("git", ["config", "core.hooksPath", ".husky/_"], { cwd: repoDir });

    // A file `.git/config` includes reads as the clone's own scope, but `--local` cannot edit it.
    await writeFile(
      path.join(repoDir, ".git", "extra.cfg"),
      "[core]\n\thooksPath = .githooks\n",
      "utf8",
    );
    await execa("git", ["config", "include.path", "extra.cfg"], { cwd: repoDir });
    await leftAlone(".githooks", "file:.git/extra.cfg", "local");
    await execa("git", ["config", "--unset", "include.path"], { cwd: repoDir });

    // The account's and the machine's configuration are theirs to change.
    const other = path.join(dir, "gitconfig");
    await writeFile(other, "[core]\n\thooksPath = /elsewhere/hooks\n", "utf8");
    try {
      vi.stubEnv("GIT_CONFIG_GLOBAL", other);
      await leftAlone("/elsewhere/hooks", `file:${other}`, "global");
      vi.unstubAllEnvs();
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", undefined);
      vi.stubEnv("GIT_CONFIG_SYSTEM", other);
      await leftAlone("/elsewhere/hooks", `file:${other}`, "system");
    } finally {
      vi.unstubAllEnvs();
    }

    // So is one worktree's own configuration.
    await execa("git", ["config", "extensions.worktreeConfig", "true"], { cwd: repoDir });
    await execa("git", ["config", "--worktree", "core.hooksPath", ".wt-hooks"], { cwd: repoDir });
    await leftAlone(".wt-hooks", "file:.git/config.worktree", "worktree");
    await execa("git", ["config", "--worktree", "--unset", "core.hooksPath"], { cwd: repoDir });

    // A value the runner may clear but cannot is a reason too, never a failed turn.
    await writeFile(path.join(repoDir, ".git", "config.lock"), "", "utf8");
    const locked = await git.guardDefaultBranch(repoDir, "main");
    expect(locked).toMatchObject({ ok: false });
    expect(locked.ok ? "" : locked.reason).toContain(
      "could not clear core.hooksPath from .git/config",
    );
    await rm(path.join(repoDir, ".git", "config.lock"));
    expect(await git.guardDefaultBranch(repoDir, "main")).toEqual({
      ok: true,
      clearedHooksPath: ".husky/_",
      movedHooks: [],
    });
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
