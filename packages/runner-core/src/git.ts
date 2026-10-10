import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
   * the runner's own, and any push of other work to it on the remote; null lifts the guard. False
   * when the guard cannot be installed: the clone runs hooks from elsewhere (`core.hooksPath`), or
   * a hook of the same name is not the runner's.
   */
  guardDefaultBranch(repoDir: string, branch: string | null): Promise<boolean>;
  /**
   * Puts away what the clone's own tree holds, which only the runner works in: a rebase left in
   * progress is aborted, and changes are stashed, merge state included, as a guarded move of the
   * default branch leaves them when refused. True when there was anything.
   */
  tidyClone(repoDir: string): Promise<boolean>;
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

async function git(
  args: readonly string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa("git", [...BOARD_IDENTITY, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    reject: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", [RUNNER_GIT]: "1" },
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
    } else if ((await this.worktreeState(worktreeDir)).onNoBranch.total > 0) {
      // Switching away would lose commits no branch holds; the turn is told of them instead.
      return worktreeDir;
    }
    // A branch is checked out in one worktree at a time: another holder's turn may have it.
    const switched = await git(["switch", "--quiet", branch], worktreeDir);
    if (switched.exitCode !== 0) {
      await must(["switch", "--quiet", "--detach", branch], worktreeDir);
    }
    return worktreeDir;
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

  async guardDefaultBranch(repoDir: string, branch: string | null): Promise<boolean> {
    if (branch === null) {
      // Exits 5 when the key is not set, which is the state wanted.
      await git(["config", "--unset", GUARD_KEY], repoDir);
      return true;
    }
    if ((await git(["config", "--get", "core.hooksPath"], repoDir)).stdout.trim() !== "") {
      return false;
    }
    const hooks = path.join(repoDir, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    for (const [name, script] of Object.entries(GUARD_HOOKS)) {
      const file = path.join(hooks, name);
      const existing = await readFile(file, "utf8").catch(() => null);
      if (existing !== null && !existing.includes(GUARD_MARK)) {
        return false;
      }
      if (existing !== script) {
        await writeFile(file, script);
      }
      await chmod(file, 0o755);
    }
    await must(["config", GUARD_KEY, branch], repoDir);
    return true;
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
