import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  patchHunks,
  type BranchChanges,
  type BranchCommit,
  type BranchFile,
  type BranchFileChange,
  type BranchFileDiff,
  type MergeOutcome,
  type ProjectRepo,
  type RepoRefs,
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
   * clone stands. One the clone has checked out and lost is restored instead, at its last tip when
   * the clone's history keeps it, which is said in the answer; null when nothing was lost.
   */
  ensureDefaultBranch(repoDir: string, project: ProjectRepo): Promise<string | null>;
  /**
   * A task conversation's worktree, on the task's branch when `take` is set and no other worktree
   * has it checked out, else detached at the branch's tip, where commits wait until
   * `settleTaskBranch` moves the branch on to them. A worktree holding commits the branch lacks,
   * as `beyondBranch` counts them, is left where it is.
   */
  ensureTaskWorktree(
    repoDir: string,
    worktreeDir: string,
    branch: string,
    base: string,
    take?: boolean,
  ): Promise<string>;
  /**
   * Moves a task's branch on to the commits its worktrees, those given, hold beyond it, as a turn
   * leaves them when it worked detached at the branch's tip: only while no worktree has the
   * branch checked out, and only by a fast-forward, to the furthest of those commits when every
   * other one is on its way there.
   */
  settleTaskBranch(
    repoDir: string,
    branch: string,
    base: string,
    worktrees: readonly string[],
  ): Promise<TaskBranchSettled>;
  /**
   * The commits a worktree's HEAD holds that `branch` lacks, leaving out `base`'s, which a branch
   * takes by merging it: the work done there that has not reached the branch, whether or not
   * another ref holds it too, as a pull request's branch it was pushed to does.
   */
  beyondBranch(worktree: string, branch: string, base: string): Promise<Listed>;
  /**
   * A proposal's, a topic's, or a channel's conversation's worktree, made detached at the tip of
   * `from` and kept as its turns left it.
   */
  ensureThreadWorktree(repoDir: string, worktreeDir: string, from: string): Promise<string>;
  /**
   * Fetches the project's remote when `fetch` is set, dropping remote branches it no longer has,
   * then fast-forwards every local branch that has a namesake there, but task and agent branches,
   * which are their holders'. Never merges: reports a fetch that failed, and a default branch
   * that has diverged from the remote's.
   */
  syncRemote(repoDir: string, defaultBranch: string, fetch: boolean): Promise<RemoteSync>;
  /**
   * Moves a branch with no commits of its own up to `base`, unless a worktree has it checked out,
   * since then a turn is using it. True when it moved.
   */
  followBase(repoDir: string, branch: string, base: string): Promise<boolean>;
  /**
   * Fast-forwards the branch checked out in `worktree` to `to` when the worktree is clean and the
   * branch has nothing `to` lacks. True when it moved.
   */
  fastForwardWorktree(worktree: string, to: string): Promise<boolean>;
  /** Detaches a clean worktree whose work is all on some branch at `to`. True when it moved. */
  refreshDetached(worktree: string, to: string): Promise<boolean>;
  /** What a worktree holds that no branch does, and the branch it is on, if any. */
  worktreeState(worktree: string): Promise<WorktreeState>;
  /** The commits `to` has that `from` lacks, counted, and the files they changed since they forked. */
  ahead(repoDir: string, from: string, to: string, limit: number): Promise<Ahead>;
  /** Removes a worktree and its checkout, once its task or thread has ended. */
  removeWorktree(repoDir: string, worktreeDir: string): Promise<void>;
  /**
   * Makes the clone's hooks, which every worktree of it shares, refuse any move of `branch` but
   * the runner's own, and any push of other work to it on the remote; null lifts the guard. Git
   * runs the guard only from the clone's own hooks folder, so a `core.hooksPath` in the clone's
   * `.git/config`, as husky's install sets it, is cleared, and a hook of the guard's names that is
   * not the runner's is moved aside. Not guarded when `core.hooksPath` comes from anywhere else,
   * such as a file `.git/config` includes or the account's configuration, which the runner leaves
   * alone; never throws for it.
   */
  guardDefaultBranch(repoDir: string, branch: string | null): Promise<GuardOutcome>;
  /**
   * Puts away what the clone's own tree holds, which only the runner works in: a rebase left in
   * progress is aborted, and changes are stashed, merge state included, as a guarded move of the
   * default branch leaves them when refused. True when there was anything.
   */
  tidyClone(repoDir: string): Promise<boolean>;
  /**
   * Fetches a pull request's head from the project's remote, GitHub's `refs/pull/<n>/head`, into
   * no ref of the clone's: the landing reads it at once, and nothing is left behind.
   */
  fetchPullHead(repoDir: string, number: number): Promise<string>;
  /** Whether two commits hold the same files. */
  sameTree(repoDir: string, a: string, b: string): Promise<boolean>;
  /** Every branch and tag of a repository, at its object. */
  refs(repoDir: string): Promise<RepoRefs>;
  /** What a repository's objects take, packed and loose, in bytes: at most what a push of them carries. */
  objectBytes(repoDir: string): Promise<number>;
  /** Pushes every branch and tag to `url`, the move's repository on the server, skipping the clone's hooks. */
  pushEverything(repoDir: string, url: string, auth: GitAuth | null): Promise<void>;
  /**
   * Makes `dir` a repository of every branch and tag at `url`, each a local branch or tag, with the
   * project's remote as `origin`, which must answer a fetch, and the default branch checked out:
   * the clone `ensureRepo` makes, with the branches the old runner had.
   */
  cloneEverything(
    url: string,
    auth: GitAuth | null,
    dir: string,
    project: ProjectRepo,
  ): Promise<void>;
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
  /**
   * What a branch did to one file, over the range `branchChanges` counts, with the patch cut at
   * `limit` characters; null when the branch does not exist or left the file alone.
   */
  branchDiff(
    repoDir: string,
    branch: string,
    defaultBranch: string,
    file: string,
    limit: number,
  ): Promise<BranchFileDiff | null>;
}

type BranchEntry = Extract<BranchFile, { kind: "dir" }>["entries"][number];

/** What fetching the remote and following it found. */
export interface RemoteSync {
  /** Why the fetch failed, when it did. */
  readonly fetchError?: string;
  /** Commits only on this runner's default branch and only on the remote's, when they diverged. */
  readonly diverged?: { readonly here: number; readonly there: number };
}

/** Some of a list, and how long the whole list is. */
export interface Listed {
  readonly items: readonly string[];
  readonly total: number;
}

/** A worktree's branch, or null when detached, and what it holds that no branch does. */
export interface WorktreeState {
  readonly branch: string | null;
  /** `git status --porcelain` lines: changes and untracked files, but not ignored ones. */
  readonly uncommitted: Listed;
  /** Commits reachable from the worktree's HEAD and from no local or remote branch. */
  readonly onNoBranch: Listed;
}

/** A worktree's commits its task's branch lacks, and the commit its HEAD is at. */
export interface StrandedWork {
  readonly worktree: string;
  readonly head: string;
  readonly commits: Listed;
}

/** Where settling a task's branch moved it, and the commits it could not take. */
export interface TaskBranchSettled {
  /** The commit the branch moved on to, or null when it stayed. */
  readonly moved: string | null;
  /**
   * Worktrees whose commits no fast-forward of the branch can take: they left its line, or two
   * worktrees' commits each build on its tip and only a merge takes both. Those that build on
   * the tip of a branch another worktree has checked out wait for that worktree's hand-back.
   */
  readonly stuck: readonly StrandedWork[];
}

/** What guarding a clone's default branch took, or why the guard does not hold. */
export type GuardOutcome =
  | {
      readonly ok: true;
      /** The clone's own `core.hooksPath`, cleared so that git runs the guard, when it had one. */
      readonly clearedHooksPath: string | null;
      /**
       * Hooks of the guard's names that were not the runner's, moved aside as `<name>.replaced`,
       * or `<name>.replaced-2` and on when an earlier one holds that name.
       */
      readonly movedHooks: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/** Commits one side has that the other lacks, and the files they changed. */
export interface Ahead {
  readonly commits: Listed;
  readonly files: Listed;
}

/** How long a fetch of a project's remote may take before the turn goes ahead without it. */
const FETCH_TIMEOUT_MS = 60_000;
/** The most entries a list in a workspace report shows. */
const LISTED = 10;

export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

/**
 * The header that lets the runner reach one address on the board server, which git sends to that
 * address alone: it travels in git's environment, so no command line, error, or kept config holds it.
 */
export interface GitAuth {
  readonly url: string;
  readonly header: string;
}

/** A carried repository is a few MiB on the pods measured; past a 256 MiB pack on a slow line, minutes. */
const MOVE_TIMEOUT_MS = 10 * 60_000;

/** `http.<url>.extraHeader` for one address, added to whatever configuration the environment gives git. */
function authEnv(auth: GitAuth | null): Record<string, string> {
  if (auth === null) {
    return {};
  }
  const given = Number.parseInt(process.env["GIT_CONFIG_COUNT"] ?? "0", 10);
  const index = Number.isInteger(given) && given > 0 ? given : 0;
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: `http.${auth.url}.extraHeader`,
    [`GIT_CONFIG_VALUE_${index}`]: auth.header,
  };
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

/**
 * Set on every git command the runner runs and on none an agent runs, since the CLIs inherit the
 * runner's own environment and this lives only on each command's.
 */
const RUNNER_GIT = "STELLARIS_RUNNER_GIT";

/**
 * Set in every CLI's environment for a turn. With `HUSKY=0`, husky's install, which a project's
 * `prepare` script runs on every `pnpm install`, leaves the clone's `core.hooksPath` alone, and
 * its hooks do nothing: pointed at a worktree's `.husky/_`, git would run no hook of the clone's,
 * the default branch's guard included.
 */
export const CLI_ENV: Readonly<Record<string, string>> = { HUSKY: "0" };

const GUARD_KEY = "stellaris.guardBranch";
const GUARD_MARK = "# stellaris-guard";
const GUARD_REFUSAL =
  "stellaris: $guarded is where the board lands this project's finished tasks, so only the runner moves it. Commit to your task's branch and finish your stage with advance_task; the board merges the branch when the task completes.";

/**
 * The hooks guarding a merge project's default branch. Git 2.39 runs reference-transaction for
 * packing refs too, as a creation at the value a ref already has and a deletion, so only a new
 * value other than the branch's current one is refused, which leaves `git gc` working. A push may
 * publish the branch as it stands here, which holds the board's landings, and nothing else.
 */
const GUARD_HOOKS: Readonly<Record<string, string>> = {
  "reference-transaction": `#!/bin/sh
${GUARD_MARK}: installed by the Stellaris runner, which rewrites this file.
[ "$1" = prepared ] || exit 0
[ -n "$${RUNNER_GIT}" ] && exit 0
guarded=$(git config --get ${GUARD_KEY}) || exit 0
current=$(git rev-parse --verify -q "refs/heads/$guarded")
refused=
while read -r old new ref; do
  [ "$ref" = "refs/heads/$guarded" ] || continue
  case $new in *[!0]*) ;; *) continue ;; esac
  [ "$new" = "$current" ] || refused=1
done
[ -z "$refused" ] && exit 0
echo "${GUARD_REFUSAL}" >&2
exit 1
`,
  "pre-push": `#!/bin/sh
${GUARD_MARK}: installed by the Stellaris runner, which rewrites this file.
[ -n "$${RUNNER_GIT}" ] && exit 0
guarded=$(git config --get ${GUARD_KEY}) || exit 0
current=$(git rev-parse --verify -q "refs/heads/$guarded")
refused=
while read -r local_ref local_id remote_ref remote_id; do
  [ "$remote_ref" = "refs/heads/$guarded" ] || continue
  [ "$local_id" = "$current" ] || refused=1
done
[ -z "$refused" ] && exit 0
echo "${GUARD_REFUSAL}" >&2
exit 1
`,
};

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Where a hook that is not the runner's goes: a name git never runs, and no earlier one's. */
async function asideName(file: string): Promise<string> {
  for (let copy = 1; ; copy += 1) {
    const name = copy === 1 ? `${file}.replaced` : `${file}.replaced-${copy}`;
    if (!(await exists(name))) {
      return name;
    }
  }
}

async function git(
  args: readonly string[],
  cwd?: string,
  timeoutMs?: number,
  env: Readonly<Record<string, string>> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa("git", [...BOARD_IDENTITY, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    reject: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", [RUNNER_GIT]: "1", ...env },
  });
  return {
    stdout: result.stdout,
    stderr: result.timedOut ? `timed out after ${timeoutMs}ms` : result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

/** Non-empty lines of a command's output. */
function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

/** The last line git wrote, which says why it failed, or `fallback`. */
function lastLine(text: string, fallback: string): string {
  return lines(text).at(-1)?.trim() ?? fallback;
}

/** Branches by name under a ref prefix, with the commit each points at. */
async function refsUnder(repoDir: string, prefix: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const out = await must(["for-each-ref", "--format=%(refname)%00%(objectname)", prefix], repoDir);
  for (const line of lines(out)) {
    const [ref, id] = line.split("\0");
    if (ref !== undefined && id !== undefined) {
      refs.set(ref.slice(prefix.length + 1), id);
    }
  }
  return refs;
}

async function isAncestor(repoDir: string, ancestor: string, of: string): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", ancestor, of], repoDir)).exitCode === 0;
}

async function count(repoDir: string, args: readonly string[]): Promise<number> {
  return Number((await must(["rev-list", "--count", ...args], repoDir)).trim()) || 0;
}

/** Local branches by name and the worktree each is checked out in. */
async function checkedOut(repoDir: string): Promise<Map<string, string>> {
  const where = new Map<string, string>();
  let worktree: string | null = null;
  for (const line of lines(await must(["worktree", "list", "--porcelain"], repoDir))) {
    if (line.startsWith("worktree ")) {
      worktree = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/") && worktree !== null) {
      where.set(line.slice("branch refs/heads/".length), path.resolve(worktree));
    }
  }
  return where;
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

  async refs(repoDir: string): Promise<RepoRefs> {
    const out = await must(
      ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"],
      repoDir,
    );
    const refs: RepoRefs = {};
    for (const line of lines(out)) {
      const space = line.indexOf(" ");
      refs[line.slice(space + 1)] = line.slice(0, space);
    }
    return refs;
  }

  async objectBytes(repoDir: string): Promise<number> {
    const out = await must(["count-objects", "-v"], repoDir);
    let kib = 0;
    for (const line of lines(out)) {
      const [key, value] = line.split(":").map((part) => part.trim());
      if (key === "size" || key === "size-pack") {
        kib += Number.parseInt(value ?? "0", 10) || 0;
      }
    }
    return kib * 1024;
  }

  async pushEverything(repoDir: string, url: string, auth: GitAuth | null): Promise<void> {
    const pushed = await git(
      [
        "push",
        "--quiet",
        "--no-verify",
        url,
        "+refs/heads/*:refs/heads/*",
        "+refs/tags/*:refs/tags/*",
      ],
      repoDir,
      MOVE_TIMEOUT_MS,
      authEnv(auth),
    );
    if (pushed.exitCode !== 0) {
      throw new Error(
        `the push to the board failed: ${lastLine(pushed.stderr, "git push failed")}`,
      );
    }
  }

  async cloneEverything(
    url: string,
    auth: GitAuth | null,
    requestedDir: string,
    project: ProjectRepo,
  ): Promise<void> {
    const dir = path.resolve(requestedDir);
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.dirname(dir), { recursive: true });
    await must(["init", "--quiet", "-b", project.defaultBranch, dir]);
    // HEAD names the default branch before it exists, so the fetch may write it.
    const fetched = await git(
      [
        "-c",
        "transfer.fsckObjects=true",
        "fetch",
        "--quiet",
        "--no-tags",
        "--update-head-ok",
        url,
        "+refs/heads/*:refs/heads/*",
        "+refs/tags/*:refs/tags/*",
      ],
      dir,
      MOVE_TIMEOUT_MS,
      authEnv(auth),
    );
    if (fetched.exitCode !== 0) {
      throw new Error(
        `the fetch from the board failed: ${lastLine(fetched.stderr, "git fetch failed")}`,
      );
    }
    if (!(await this.branchExists(dir, project.defaultBranch))) {
      throw new Error(`what arrived has no ${project.defaultBranch} branch`);
    }
    await must(["reset", "--quiet", "--hard"], dir);
    if (project.origin === null) {
      return;
    }
    await must(["remote", "add", "origin", project.origin], dir);
    const remote = await git(["fetch", "--quiet", "--prune", "origin"], dir, FETCH_TIMEOUT_MS);
    if (remote.exitCode !== 0) {
      throw new Error(
        `this runner cannot fetch ${project.origin}: ${lastLine(remote.stderr, "git fetch failed")}`,
      );
    }
    const tracking = `refs/remotes/origin/${project.defaultBranch}`;
    if ((await git(["rev-parse", "--verify", "--quiet", tracking], dir)).exitCode === 0) {
      await must(
        [
          "branch",
          "--quiet",
          `--set-upstream-to=origin/${project.defaultBranch}`,
          project.defaultBranch,
        ],
        dir,
      );
    }
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

  async ensureDefaultBranch(repoDir: string, project: ProjectRepo): Promise<string | null> {
    const branch = project.defaultBranch;
    if (await this.branchExists(repoDir, branch)) {
      return null;
    }
    const ref = `refs/heads/${branch}`;
    // The clone's HEAD names its default branch once it has landed there or was cloned on it; the
    // guard lets a deletion through (see `guardDefaultBranch`), and HEAD's reflog outlives the
    // branch's own, holding its last tip and every landing that only the clone has.
    const lost = (await git(["symbolic-ref", "-q", "HEAD"], repoDir)).stdout.trim() === ref;
    if (lost) {
      const last = await this.lastHeadTip(repoDir);
      if (last !== null) {
        await must(["update-ref", ref, last, ""], repoDir);
        return `restored ${branch}, deleted from the clone, at ${last.slice(0, 7)} from the clone's history`;
      }
    }
    if (project.origin !== null) {
      // Into the remote-tracking branch, since git refuses to fetch into one the clone has checked out.
      const fetched = await git(
        ["fetch", "--quiet", "origin", `+${ref}:refs/remotes/origin/${branch}`],
        repoDir,
      );
      if (fetched.exitCode === 0) {
        await must(["update-ref", ref, `refs/remotes/origin/${branch}`, ""], repoDir);
        return lost ? `restored ${branch}, deleted from the clone, from the remote` : null;
      }
    }
    if (lost) {
      throw new Error(
        `${branch} was deleted from the clone, and neither the clone's history nor a remote has it`,
      );
    }
    await must(["branch", branch, "HEAD"], repoDir);
    return null;
  }

  /** The commit the clone's HEAD named last, from its reflog: git reads none while HEAD is unborn. */
  private async lastHeadTip(repoDir: string): Promise<string | null> {
    const log = (await git(["rev-parse", "--git-path", "logs/HEAD"], repoDir)).stdout.trim();
    const text = await readFile(path.resolve(repoDir, log), "utf8").catch(() => "");
    const newest = text.trimEnd().split("\n").at(-1) ?? "";
    // Each entry is "<old> <new> <who> <when>\t<message>"; a deletion's new is all zeros.
    const id = newest
      .split(" ", 2)
      .toReversed()
      .find((part) => /^[0-9a-f]{40,64}$/.test(part) && /[^0]/.test(part));
    if (id === undefined) {
      return null;
    }
    const commit = await git(["rev-parse", "--verify", "-q", `${id}^{commit}`], repoDir);
    return commit.exitCode === 0 ? commit.stdout.trim() : null;
  }

  async ensureTaskWorktree(
    repoDir: string,
    requestedDir: string,
    branch: string,
    base: string,
    take = true,
  ): Promise<string> {
    const worktreeDir = path.resolve(requestedDir);
    if (!(await exists(path.join(worktreeDir, ".git")))) {
      await mkdir(path.dirname(worktreeDir), { recursive: true });
      await must(["worktree", "add", "--detach", worktreeDir, branch], repoDir);
    } else if ((await this.beyondBranch(worktreeDir, branch, base)).total > 0) {
      // Switching away would leave commits the branch lacks, which no branch may hold, or only a
      // pull request's that the branch would then not match; the turn is told of them instead.
      return worktreeDir;
    }
    // A branch is checked out in one worktree at a time: another turn in the task may have it.
    const switched = take && (await git(["switch", "--quiet", branch], worktreeDir)).exitCode === 0;
    if (!switched) {
      await must(["switch", "--quiet", "--detach", branch], worktreeDir);
    }
    return worktreeDir;
  }

  async settleTaskBranch(
    repoDir: string,
    branch: string,
    base: string,
    worktrees: readonly string[],
  ): Promise<TaskBranchSettled> {
    const tip = await this.head(repoDir, branch);
    if (tip === null) {
      return { moved: null, stuck: [] };
    }
    const waiting: StrandedWork[] = [];
    for (const worktree of worktrees) {
      const beyond = await this.beyondBranch(worktree, branch, base);
      if (beyond.total > 0) {
        const head = (await must(["rev-parse", "HEAD"], worktree)).trim();
        waiting.push({ worktree: path.resolve(worktree), head, commits: beyond });
      }
    }
    if (waiting.length === 0) {
      return { moved: null, stuck: [] };
    }
    const building: StrandedWork[] = [];
    for (const each of waiting) {
      if (await isAncestor(repoDir, tip, each.head)) {
        building.push(each);
      }
    }
    let furthest: StrandedWork | undefined;
    for (const candidate of building) {
      let reaches = true;
      for (const other of building) {
        reaches &&= await isAncestor(repoDir, other.head, candidate.head);
      }
      if (reaches) {
        furthest = candidate;
        break;
      }
    }
    if (furthest === undefined) {
      return { moved: null, stuck: waiting };
    }
    // A push into the clone is refused for a branch a worktree has checked out or is rebasing,
    // which `worktree list` shows as detached, and that worktree's hand-back settles what builds
    // on the tip; it is refused too unless a fast-forward under the ref's lock, so a commit that
    // reached the branch since its tip was read, as another turn's hand-back makes, stays on it.
    const moved = await git(
      ["push", "--quiet", "--no-verify", ".", `${furthest.head}:refs/heads/${branch}`],
      repoDir,
    );
    if (moved.exitCode !== 0) {
      return { moved: null, stuck: waiting.filter((each) => !building.includes(each)) };
    }
    const stuck: StrandedWork[] = [];
    for (const each of waiting) {
      if (!(await isAncestor(repoDir, each.head, furthest.head))) {
        stuck.push(each);
      }
    }
    return { moved: furthest.head, stuck };
  }

  async beyondBranch(worktree: string, branch: string, base: string): Promise<Listed> {
    const known: string[] = [];
    for (const ref of [`refs/heads/${branch}`, `refs/heads/${base}`]) {
      if ((await git(["rev-parse", "--verify", "--quiet", ref], worktree)).exitCode === 0) {
        known.push(ref);
      }
    }
    const range = ["HEAD", "--not", ...known];
    const items = lines(
      await must(["log", `--max-count=${LISTED}`, "--format=%h %s", ...range], worktree),
    );
    return {
      items,
      total: items.length < LISTED ? items.length : await count(worktree, range),
    };
  }

  async ensureThreadWorktree(repoDir: string, requestedDir: string, from: string): Promise<string> {
    const worktreeDir = path.resolve(requestedDir);
    if (!(await exists(path.join(worktreeDir, ".git")))) {
      await mkdir(path.dirname(worktreeDir), { recursive: true });
      await must(["worktree", "add", "--detach", worktreeDir, from], repoDir);
    }
    return worktreeDir;
  }

  async syncRemote(repoDir: string, defaultBranch: string, fetch: boolean): Promise<RemoteSync> {
    let fetchError: string | undefined;
    if (fetch) {
      const fetched = await git(
        ["fetch", "--prune", "--quiet", "origin"],
        repoDir,
        FETCH_TIMEOUT_MS,
      );
      if (fetched.exitCode !== 0) {
        fetchError = lines(fetched.stderr).at(-1) ?? "git fetch failed";
      }
    }
    const remote = await refsUnder(repoDir, "refs/remotes/origin");
    const local = await refsUnder(repoDir, "refs/heads");
    const where = await checkedOut(repoDir);
    const clone = path.resolve(repoDir);
    let diverged: RemoteSync["diverged"];
    for (const [branch, there] of remote) {
      const here = local.get(branch);
      if (
        branch === "HEAD" ||
        branch.startsWith("task/") ||
        branch.startsWith("agent/") ||
        here === undefined ||
        here === there
      ) {
        continue;
      }
      if (await isAncestor(repoDir, here, there)) {
        const worktree = where.get(branch);
        if (worktree === undefined) {
          await must(["update-ref", `refs/heads/${branch}`, there, here], repoDir);
        } else if (worktree === clone) {
          // Only the clone's own tree, which the runner alone works in, moves while checked out.
          await this.fastForwardWorktree(clone, there);
        }
      } else if (branch === defaultBranch && !(await isAncestor(repoDir, there, here))) {
        diverged = {
          here: await count(repoDir, [here, "--not", there]),
          there: await count(repoDir, [there, "--not", here]),
        };
      }
    }
    return {
      ...(fetchError === undefined ? {} : { fetchError }),
      ...(diverged === undefined ? {} : { diverged }),
    };
  }

  async followBase(repoDir: string, branch: string, base: string): Promise<boolean> {
    const here = await this.head(repoDir, branch);
    const there = await this.head(repoDir, base);
    if (here === null || there === null || here === there) {
      return false;
    }
    if ((await checkedOut(repoDir)).has(branch) || !(await isAncestor(repoDir, here, there))) {
      return false;
    }
    await must(["update-ref", `refs/heads/${branch}`, there, here], repoDir);
    return true;
  }

  async fastForwardWorktree(worktree: string, to: string): Promise<boolean> {
    const status = await must(["status", "--porcelain"], worktree);
    if (status.trim() !== "" || !(await isAncestor(worktree, "HEAD", to))) {
      return false;
    }
    const before = (await must(["rev-parse", "HEAD"], worktree)).trim();
    await must(["merge", "--ff-only", "--quiet", to], worktree);
    return (await must(["rev-parse", "HEAD"], worktree)).trim() !== before;
  }

  async refreshDetached(worktree: string, to: string): Promise<boolean> {
    const state = await this.worktreeState(worktree);
    if (state.uncommitted.total > 0 || state.onNoBranch.total > 0) {
      return false;
    }
    const [at, target] = await Promise.all([
      must(["rev-parse", "HEAD"], worktree),
      must(["rev-parse", `${to}^{commit}`], worktree),
    ]);
    if (at.trim() === target.trim() && state.branch === null) {
      return false;
    }
    await must(["switch", "--quiet", "--detach", to], worktree);
    return true;
  }

  async worktreeState(worktree: string): Promise<WorktreeState> {
    const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], worktree);
    const uncommitted = lines(await must(["status", "--porcelain"], worktree));
    const stray = ["HEAD", "--not", "--branches", "--remotes"];
    const onNoBranch = lines(
      await must(["log", `--max-count=${LISTED}`, "--format=%h %s", ...stray], worktree),
    );
    return {
      branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
      uncommitted: { items: uncommitted.slice(0, LISTED), total: uncommitted.length },
      onNoBranch: {
        items: onNoBranch,
        total: onNoBranch.length < LISTED ? onNoBranch.length : await count(worktree, stray),
      },
    };
  }

  async ahead(repoDir: string, from: string, to: string, limit: number): Promise<Ahead> {
    const commits = lines(
      await must(["log", `--max-count=${limit}`, "--format=%h %s", `${from}..${to}`], repoDir),
    );
    const files = lines(await must(["diff", "--name-only", `${from}...${to}`], repoDir));
    return {
      commits: { items: commits, total: await count(repoDir, [`${from}..${to}`]) },
      files: { items: files.slice(0, limit), total: files.length },
    };
  }

  async removeWorktree(repoDir: string, requestedDir: string): Promise<void> {
    const worktreeDir = path.resolve(requestedDir);
    if (await exists(worktreeDir)) {
      await must(["worktree", "remove", "--force", worktreeDir], repoDir);
    }
  }

  async guardDefaultBranch(repoDir: string, branch: string | null): Promise<GuardOutcome> {
    if (branch === null) {
      // Exits 5 when the key is not set, which is the state wanted.
      await git(["config", "--unset", GUARD_KEY], repoDir);
      return { ok: true, clearedHooksPath: null, movedHooks: [] };
    }
    // Each line is a scope, the file the value came from, and the value; exits 1 when the key is
    // set nowhere. A file `.git/config` includes reports as `local` too, while `--local` edits
    // `.git/config` alone, so only a value from there is the runner's to clear.
    const hooksPaths = lines(
      (
        await git(
          ["config", "--show-scope", "--show-origin", "--get-all", "core.hooksPath"],
          repoDir,
        )
      ).stdout,
    ).map((line) => {
      const [scope = "", origin = "", ...value] = line.split("\t");
      return { scope, origin, value: value.join("\t") };
    });
    const outside = hooksPaths.find(
      ({ scope, origin }) => scope !== "local" || origin !== "file:.git/config",
    );
    if (outside !== undefined) {
      return {
        ok: false,
        reason: `core.hooksPath is ${outside.value} from ${outside.origin} in the ${outside.scope} configuration, which the runner leaves alone`,
      };
    }
    if (hooksPaths.length > 0) {
      const cleared = await git(["config", "--local", "--unset-all", "core.hooksPath"], repoDir);
      if (cleared.exitCode !== 0) {
        return {
          ok: false,
          reason: `could not clear core.hooksPath from .git/config: ${cleared.stderr.trim() || `git exited ${cleared.exitCode}`}`,
        };
      }
    }
    const hooks = path.join(repoDir, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    const movedHooks: string[] = [];
    for (const [name, script] of Object.entries(GUARD_HOOKS)) {
      const file = path.join(hooks, name);
      const existing = await readFile(file, "utf8").catch(() => null);
      if (existing !== null && !existing.includes(GUARD_MARK)) {
        // Kept under a name git never runs, for whoever wants it back.
        await rename(file, await asideName(file));
        movedHooks.push(name);
      }
      if (existing !== script) {
        await writeFile(file, script);
      }
      await chmod(file, 0o755);
    }
    await must(["config", GUARD_KEY, branch], repoDir);
    return {
      ok: true,
      clearedHooksPath:
        hooksPaths.length === 0 ? null : hooksPaths.map(({ value }) => value).join(", "),
      movedHooks,
    };
  }

  async fetchPullHead(repoDir: string, number: number): Promise<string> {
    const fetched = await git(
      ["fetch", "--quiet", "origin", `refs/pull/${number}/head`],
      repoDir,
      FETCH_TIMEOUT_MS,
    );
    if (fetched.exitCode !== 0) {
      throw new Error(lines(fetched.stderr).at(-1) ?? `could not fetch pull request ${number}`);
    }
    // Landings run one at a time per project, so FETCH_HEAD is this fetch's until it is read.
    return (await must(["rev-parse", "FETCH_HEAD^{commit}"], repoDir)).trim();
  }

  async sameTree(repoDir: string, a: string, b: string): Promise<boolean> {
    const [one, two] = await Promise.all(
      [a, b].map(async (rev) => (await must(["rev-parse", `${rev}^{tree}`], repoDir)).trim()),
    );
    return one === two;
  }

  async tidyClone(repoDir: string): Promise<boolean> {
    let tidied = false;
    for (const state of ["rebase-merge", "rebase-apply"]) {
      if (await exists(path.join(repoDir, ".git", state))) {
        await must(["rebase", "--abort"], repoDir);
        tidied = true;
      }
    }
    if ((await must(["status", "--porcelain", "--untracked-files=no"], repoDir)).trim() !== "") {
      await must(
        [
          "stash",
          "push",
          "--quiet",
          "-m",
          "left in the runner's clone, which only the runner works in",
        ],
        repoDir,
      );
      tidied = true;
    }
    // A merge whose result matched the tree leaves its state and nothing to stash.
    for (const state of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      if (await exists(path.join(repoDir, ".git", state))) {
        await must(["reset", "--quiet", "--hard"], repoDir);
        tidied = true;
      }
    }
    return tidied;
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
      // Later -c options win over the board identity every git call starts with. A project's
      // commit hooks are for its citizens' own commits: `pre-commit install` in any worktree
      // writes the clone's shared pre-commit hook, which fails on a branch without its
      // configuration and would leave the work uncommitted, the branch held from its next holder.
      await must(
        [
          "-c",
          `user.name=${author.name}`,
          "-c",
          `user.email=${author.email}`,
          "commit",
          "--quiet",
          "--no-verify",
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
    const range = await this.branchRange(repoDir, branch, defaultBranch);
    if (range === null) {
      return null;
    }
    const { head, base, from } = range;
    const tip = head.id;
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
        status: fileStatus(letter),
        ...(counts.get(changed) ?? { added: null, removed: null }),
        ...(last === undefined ? {} : { lastChange: last }),
      });
    }
    return { head, files, total };
  }

  async branchDiff(
    repoDir: string,
    branch: string,
    defaultBranch: string,
    file: string,
    limit: number,
  ): Promise<BranchFileDiff | null> {
    const range = await this.branchRange(repoDir, branch, defaultBranch);
    if (range === null) {
      return null;
    }
    // The path names itself alone, glob characters and all, and no diff driver or text conversion
    // the repository configures runs on a read.
    const diff = [
      "--literal-pathspecs",
      "diff",
      "--no-color",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      range.from,
      range.head.id,
    ];
    const [letter] = (await must([...diff, "--name-status", "-z", "--", file], repoDir)).split(
      "\0",
    );
    if (letter === undefined || letter === "") {
      return null;
    }
    const patch = await must([...diff, "--", file], repoDir);
    return {
      head: range.head,
      path: file,
      status: fileStatus(letter),
      ...patchHunks(patch, limit),
    };
  }

  /**
   * What a branch's changes are counted over: its newest commit, where it left the default branch,
   * or null when the two share no commit, and what to diff from, the empty tree then. Null when the
   * branch does not exist.
   */
  private async branchRange(
    repoDir: string,
    branch: string,
    defaultBranch: string,
  ): Promise<{ head: BranchCommit; base: string | null; from: string } | null> {
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
    return { head, base, from };
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

function fileStatus(letter: string): BranchFileChange["status"] {
  return letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
}

/** A `--numstat` count, null where git counts a binary file as `-`. */
function lineCount(value: string | undefined): number | null {
  return value === undefined || value === "-" ? null : Number.parseInt(value, 10);
}
