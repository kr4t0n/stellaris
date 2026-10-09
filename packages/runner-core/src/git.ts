import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  BranchChanges,
  BranchFile,
  BranchFileChange,
  MergeOutcome,
  ProjectRepo,
} from "@stellaris/shared";
import { execa } from "execa";

/** The git operations a runner needs. */
export interface GitOps {
  /** The project's canonical clone on this runner, created from its remote or initialized empty. */
  ensureRepo(project: ProjectRepo, dir: string): Promise<string>;
  /** One persistent worktree for an agent-project pair on the agent's own branch. */
  ensureWorktree(
    repoDir: string,
    worktreeDir: string,
    branch: string,
    base: string,
  ): Promise<string>;
  /** Lands a branch on the default branch in the canonical clone. Aborts cleanly on conflict. */
  merge(repoDir: string, into: string, branch: string): Promise<MergeOutcome>;
  branchExists(repoDir: string, branch: string): Promise<boolean>;
  /** The commit a branch points at, or null when it does not exist. */
  head(repoDir: string, branch: string): Promise<string | null>;
  /** Creates `branch` from `base` in the clone unless it exists. */
  ensureBranch(repoDir: string, branch: string, base: string): Promise<void>;
  /**
   * Makes sure the project's default branch is in the clone, as after the board moved the project
   * to another: fetched from the project's remote when it has one there, else started where the
   * clone stands.
   */
  ensureDefaultBranch(repoDir: string, project: ProjectRepo): Promise<void>;
  /**
   * A task conversation's worktree, on the task's branch when no other worktree has it checked
   * out, else detached at the branch's tip, where the turn can read the work but not commit to it.
   */
  ensureTaskWorktree(repoDir: string, worktreeDir: string, branch: string): Promise<string>;
  /** Removes a worktree and its checkout, once its task has ended. */
  removeWorktree(repoDir: string, worktreeDir: string): Promise<void>;
  /**
   * When the worktree is on a task branch: commits whatever was left uncommitted as `author`,
   * then switches back to `home`, or with `home` null detaches, which frees the branch for the
   * next holder. Returns the task branch, or null when there was nothing to hand back.
   */
  handBack(
    worktree: string,
    home: string | null,
    author: GitAuthor,
  ): Promise<{ branch: string; committed: boolean } | null>;
  /**
   * One path on a branch as its newest commit has it, read from git's objects rather than a
   * worktree: a file's bytes when it is no larger than `limit`, or a folder's entries. Null when
   * the branch or the path does not exist.
   */
  readBranch(
    repoDir: string,
    branch: string,
    file: string,
    limit: number,
  ): Promise<BranchFile | null>;
  /**
   * The files a branch changed since it left `defaultBranch`, the first `limit` of them, or null
   * when the branch does not exist. A branch the board landed counts from the default branch as
   * it stood before the landing merge, so landing does not empty the list.
   */
  branchChanges(
    repoDir: string,
    branch: string,
    defaultBranch: string,
    limit: number,
  ): Promise<BranchChanges | null>;
}

type BranchEntry = Extract<BranchFile, { kind: "dir" }>["entries"][number];

export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

/** The branch a task's work lives on, shared by whoever holds its stages. */
export function taskBranch(taskId: string): string {
  return `task/${taskId}`;
}

const BOARD_IDENTITY = [
  "-c",
  "user.name=stellaris-board",
  "-c",
  "user.email=board@stellaris.local",
];

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function git(
  args: readonly string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa("git", [...BOARD_IDENTITY, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    reject: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
}

async function must(args: readonly string[], cwd?: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

export class ExecaGit implements GitOps {
  async ensureRepo(project: ProjectRepo, requestedDir: string): Promise<string> {
    const dir = path.resolve(requestedDir);
    if (await exists(path.join(dir, ".git"))) {
      return dir;
    }
    await mkdir(path.dirname(dir), { recursive: true });
    if (project.origin !== null) {
      await must(["clone", "--branch", project.defaultBranch, project.origin, dir]);
      return dir;
    }
    await must(["init", "-b", project.defaultBranch, dir]);
    await must(["commit", "--allow-empty", "-m", `chore: initialize ${project.slug}`], dir);
    return dir;
  }

  /**
   * The worktree path is made absolute before git sees it: `git worktree add` runs inside the
   * clone, where a relative path would create the worktree inside the repository.
   */
  async ensureWorktree(
    repoDir: string,
    requestedDir: string,
    branch: string,
    base: string,
  ): Promise<string> {
    const worktreeDir = path.resolve(requestedDir);
    if (await exists(path.join(worktreeDir, ".git"))) {
      return worktreeDir;
    }
    await mkdir(path.dirname(worktreeDir), { recursive: true });
    if (await this.branchExists(repoDir, branch)) {
      await must(["worktree", "add", worktreeDir, branch], repoDir);
    } else {
      await must(["worktree", "add", "-b", branch, worktreeDir, base], repoDir);
    }
    return worktreeDir;
  }

  async branchExists(repoDir: string, branch: string): Promise<boolean> {
    const result = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoDir);
    return result.exitCode === 0;
  }

  async head(repoDir: string, branch: string): Promise<string | null> {
    const result = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoDir);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async ensureBranch(repoDir: string, branch: string, base: string): Promise<void> {
    if (!(await this.branchExists(repoDir, branch))) {
      await must(["branch", branch, base], repoDir);
    }
  }

  async ensureDefaultBranch(repoDir: string, project: ProjectRepo): Promise<void> {
    const branch = project.defaultBranch;
    if (await this.branchExists(repoDir, branch)) {
      return;
    }
    if (project.origin !== null) {
      const fetched = await git(
        ["fetch", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`],
        repoDir,
      );
      if (fetched.exitCode === 0) {
        return;
      }
    }
    await must(["branch", branch, "HEAD"], repoDir);
  }

  async ensureTaskWorktree(repoDir: string, requestedDir: string, branch: string): Promise<string> {
    const worktreeDir = path.resolve(requestedDir);
    if (!(await exists(path.join(worktreeDir, ".git")))) {
      await mkdir(path.dirname(worktreeDir), { recursive: true });
      await must(["worktree", "add", "--detach", worktreeDir, branch], repoDir);
    }
    // A branch is checked out in one worktree at a time: another holder's turn may have it.
    const switched = await git(["switch", "--quiet", branch], worktreeDir);
    if (switched.exitCode !== 0) {
      await must(["switch", "--quiet", "--detach", branch], worktreeDir);
    }
    return worktreeDir;
  }

  async removeWorktree(repoDir: string, requestedDir: string): Promise<void> {
    const worktreeDir = path.resolve(requestedDir);
    if (await exists(worktreeDir)) {
      await must(["worktree", "remove", "--force", worktreeDir], repoDir);
    }
  }

  async handBack(
    worktree: string,
    home: string | null,
    author: GitAuthor,
  ): Promise<{ branch: string; committed: boolean } | null> {
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], worktree);
    const branch = head.stdout.trim();
    if (head.exitCode !== 0 || !branch.startsWith("task/")) {
      return null;
    }
    const dirty = (await must(["status", "--porcelain"], worktree)).trim().length > 0;
    if (dirty) {
      await must(["add", "-A"], worktree);
      // Later -c options win over the board identity every git call starts with.
      await must(
        [
          "-c",
          `user.name=${author.name}`,
          "-c",
          `user.email=${author.email}`,
          "commit",
          "--quiet",
          "-m",
          `wip: left uncommitted by ${author.name} at the end of a turn`,
        ],
        worktree,
      );
    }
    await must(
      home === null ? ["switch", "--quiet", "--detach"] : ["switch", "--quiet", home],
      worktree,
    );
    return { branch, committed: dirty };
  }

  async merge(repoDir: string, into: string, branch: string): Promise<MergeOutcome> {
    if (!(await this.branchExists(repoDir, branch))) {
      return { ok: false, detail: `branch ${branch} does not exist` };
    }
    const checkout = await git(["checkout", "--quiet", into], repoDir);
    if (checkout.exitCode !== 0) {
      return { ok: false, detail: `cannot check out ${into}: ${checkout.stderr.trim()}` };
    }
    const merge = await git(
      ["merge", "--no-ff", "--no-edit", "-m", `merge: land ${branch} on ${into}`, branch],
      repoDir,
    );
    if (merge.exitCode === 0) {
      const head = (await must(["rev-parse", "--short", "HEAD"], repoDir)).trim();
      // The outcome is posted under the task's own name, so it need not spell out the branch.
      return { ok: true, detail: `merged into ${into} at ${head}` };
    }
    await git(["merge", "--abort"], repoDir);
    return { ok: false, detail: merge.stderr.trim() || merge.stdout.trim() || "merge failed" };
  }

  async readBranch(
    repoDir: string,
    branch: string,
    file: string,
    limit: number,
  ): Promise<BranchFile | null> {
    const log = await git(
      ["log", "-1", "--format=%H%x00%ct%x00%an", `refs/heads/${branch}`, "--"],
      repoDir,
    );
    const [id, seconds, author] = log.stdout.trim().split("\0");
    if (log.exitCode !== 0 || id === undefined || id === "") {
      return null;
    }
    const commit = {
      id,
      at: new Date(Number(seconds) * 1000).toISOString(),
      author: author ?? "",
    };
    // The commit's id leads the object name, so the path can never be read as an option.
    const object = `${id}:${file}`;
    const type = await git(["cat-file", "-t", object], repoDir);
    if (type.exitCode !== 0) {
      return null;
    }
    if (type.stdout.trim() === "tree") {
      const listing = await must(["ls-tree", "-l", "-z", object], repoDir);
      const entries = listing.split("\0").flatMap((line): BranchEntry[] => {
        const tab = line.indexOf("\t");
        const [, kind, , size] = line.slice(0, tab).split(/\s+/);
        const name = line.slice(tab + 1);
        if (tab === -1 || name === "") {
          return [];
        }
        if (kind === "blob") {
          return [{ name, kind: "file", size: Number(size) }];
        }
        // A submodule's entry is a commit, whose files this repository does not hold.
        return kind === "tree" ? [{ name, kind: "dir", size: null }] : [];
      });
      return { kind: "dir", path: file, commit, entries };
    }
    if (type.stdout.trim() !== "blob") {
      return null;
    }
    const size = Number((await must(["cat-file", "-s", object], repoDir)).trim());
    if (size > limit) {
      return { kind: "file", path: file, commit, size, content: null };
    }
    const blob = await execa("git", ["cat-file", "blob", object], {
      cwd: repoDir,
      encoding: "buffer",
      stripFinalNewline: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return {
      kind: "file",
      path: file,
      commit,
      size,
      content: Buffer.from(blob.stdout).toString("base64"),
    };
  }

  async branchChanges(
    repoDir: string,
    branch: string,
    defaultBranch: string,
    limit: number,
  ): Promise<BranchChanges | null> {
    const log = await git(
      ["log", "-1", "--format=%H%x00%ct%x00%an", `refs/heads/${branch}`, "--"],
      repoDir,
    );
    const [tip, seconds, author] = log.stdout.trim().split("\0");
    if (log.exitCode !== 0 || tip === undefined || tip === "") {
      return null;
    }
    const head = {
      id: tip,
      at: new Date(Number(seconds) * 1000).toISOString(),
      author: author ?? "",
    };
    const base = await this.forkPoint(repoDir, defaultBranch, tip);
    // Without a common commit, everything on the branch is its change.
    const from = base ?? (await must(["hash-object", "-t", "tree", "/dev/null"], repoDir)).trim();
    const diff = ["diff", "--no-renames", "-z", from, tip];
    const listed = (await must([...diff, "--name-status"], repoDir)).split("\0");
    const counts = new Map<string, { added: number | null; removed: number | null }>();
    for (const line of (await must([...diff, "--numstat"], repoDir)).split("\0")) {
      const counted = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (counted?.[3] !== undefined) {
        counts.set(counted[3], { added: lineCount(counted[1]), removed: lineCount(counted[2]) });
      }
    }
    const touched = await this.lastChanges(repoDir, base === null ? tip : `${base}..${tip}`);
    const files: BranchFileChange[] = [];
    let total = 0;
    for (let index = 0; index + 1 < listed.length; index += 2) {
      total += 1;
      if (files.length >= limit) {
        continue;
      }
      const changed = listed[index + 1] ?? "";
      const letter = listed[index] ?? "";
      const last = touched.get(changed);
      files.push({
        path: changed,
        status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified",
        ...(counts.get(changed) ?? { added: null, removed: null }),
        ...(last === undefined ? {} : { lastChange: last }),
      });
    }
    return { head, files, total };
  }

  /**
   * Where a branch left the default branch. Once the board has landed it, the default branch
   * holds the whole branch, so the fork point is taken against the default branch as it stood
   * before the landing merge: the merge on its first-parent line whose second parent is the tip.
   * Null when the two share no commit.
   */
  private async forkPoint(
    repoDir: string,
    defaultBranch: string,
    tip: string,
  ): Promise<string | null> {
    const merges = await git(
      ["rev-list", "--first-parent", "--merges", "--parents", `refs/heads/${defaultBranch}`, "--"],
      repoDir,
    );
    const landing = merges.stdout
      .split("\n")
      .map((line) => line.split(" "))
      .find((parents) => parents[2] === tip);
    const base = await git(
      ["merge-base", landing?.[1] ?? `refs/heads/${defaultBranch}`, tip],
      repoDir,
    );
    return base.exitCode === 0 ? base.stdout.trim() : null;
  }

  /** The newest commit in a range that touched each path, by its author and time. */
  private async lastChanges(
    repoDir: string,
    range: string,
  ): Promise<Map<string, { author: string; at: string }>> {
    const log = await must(
      ["log", "--no-renames", "--format=%x01%an%x00%ct", "--name-only", "-z", range, "--"],
      repoDir,
    );
    const touched = new Map<string, { author: string; at: string }>();
    for (const record of log.split("\x01")) {
      const [author, seconds, ...paths] = record.split("\0");
      if (author === undefined || seconds === undefined) {
        continue;
      }
      const at = new Date(Number(seconds) * 1000).toISOString();
      for (const each of paths) {
        // The first path follows the header on a line of its own.
        const changed = each.replace(/^\n/, "");
        if (changed !== "" && !touched.has(changed)) {
          touched.set(changed, { author, at });
        }
      }
    }
    return touched;
  }
}

/** A `--numstat` count, null where git counts a binary file as `-`. */
function lineCount(value: string | undefined): number | null {
  return value === undefined || value === "-" ? null : Number.parseInt(value, 10);
}
