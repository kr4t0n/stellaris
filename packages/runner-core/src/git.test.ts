import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecaGit } from "./git.js";

const project = {
  slug: "demo",
  name: "Demo",
  repo: null,
  defaultBranch: "main",
  channels: ["general"],
  members: [],
  approvers: [],
  requiredCapabilities: [],
  createdAt: "2026-09-28T10:00:00.000Z",
};

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
