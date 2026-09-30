import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Project } from "@stellaris/shared";
import { execa } from "execa";

export interface MergeOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

/** The git operations a runner needs. */
export interface GitOps {
  /** The project's canonical clone on this runner, created from its remote or initialized empty. */
  ensureRepo(project: Project, dir: string): Promise<string>;
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
  /** Creates `branch` from `base` in the clone unless it exists. */
  ensureBranch(repoDir: string, branch: string, base: string): Promise<void>;
  /**
   * When the worktree is on a task branch: commits whatever was left uncommitted as `author`,
   * then switches back to `home`. Returns the task branch, or null when there was nothing to hand back.
   */
  handBack(
    worktree: string,
    home: string,
    author: GitAuthor,
  ): Promise<{ branch: string; committed: boolean } | null>;
}

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
  async ensureRepo(project: Project, requestedDir: string): Promise<string> {
    const dir = path.resolve(requestedDir);
    if (await exists(path.join(dir, ".git"))) {
      return dir;
    }
    await mkdir(path.dirname(dir), { recursive: true });
    if (project.repo !== null) {
      await must(["clone", "--branch", project.defaultBranch, project.repo, dir]);
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

  async ensureBranch(repoDir: string, branch: string, base: string): Promise<void> {
    if (!(await this.branchExists(repoDir, branch))) {
      await must(["branch", branch, base], repoDir);
    }
  }

  async handBack(
    worktree: string,
    home: string,
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
    await must(["switch", "--quiet", home], worktree);
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
}
