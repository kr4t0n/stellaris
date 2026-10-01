import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HOME_FILE_LIMIT_BYTES, HOME_SCRATCH } from "@stellaris/shared";
import { execa } from "execa";
import { exists } from "./fs.js";

/**
 * What a home's repository never tracks: the records the board keeps in a home (the agent record,
 * the charter file, cursors, session records, last turns, transcripts), the CLI configuration a
 * runner renders there, the scratch folder turns outside any project work in, and the byproducts
 * of tools wherever they appear. Everything else in a home is the citizen's, and travels.
 */
export const HOME_GITIGNORE = [
  "/agent.json",
  "/cursors.json",
  "/role.md",
  "/turns/",
  "/.claude/",
  "/.codex/",
  "/projects/*/sessions*.json",
  "/projects/*/last-turn.json",
  "/projects/*/threads/",
  `/${HOME_SCRATCH}/`,
  "*.tmp",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".ipynb_checkpoints/",
  ".cache/",
  ".DS_Store",
];

const IGNORE_FILE = `${HOME_GITIGNORE.join("\n")}\n`;

/**
 * The hook every home runs before it takes a push: only `main` moves, from where it is now, and
 * never out of existence; the ignore file stays the board's; and no pushed tree may hold a path the
 * board keeps, since git treats an ignored file as expendable and would overwrite the board's copy.
 * Nor may a push carry a file over the size limit, in any of its commits, since history keeps
 * every file it ever held. The check that `main` has not moved must be here: with `updateInstead`, git rewrites the working
 * tree and index before it checks the branch, so a push from a stale view, refused only then, would
 * leave the home half-updated and refusing every later push. The server takes one push per home at
 * a time, so nothing moves `main` between this check and the update.
 */
const PRE_RECEIVE = `#!/bin/sh
forbidden='^(agent\\.json|cursors\\.json|role\\.md|turns/|\\.claude/|\\.codex/|projects/[^/]+/(sessions[^/]*\\.json|last-turn\\.json|threads/))'
while read old new ref; do
  if [ "$ref" != "refs/heads/main" ]; then
    echo "a home takes pushes to main only" >&2
    exit 1
  fi
  if [ "$(git rev-parse --verify --quiet "$ref")" != "$old" ]; then
    echo "a home's main has moved since this push was prepared; fetch and merge, then push again" >&2
    exit 1
  fi
  case "$new" in
    *[!0]*) ;;
    *) echo "a home's main may not be deleted" >&2; exit 1 ;;
  esac
  case "$old" in
    *[!0]*) range="$old..$new" ;;
    *) range="$new" ;;
  esac
  big=$(git rev-list --objects $range | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' | awk -v cap=${HOME_FILE_LIMIT_BYTES} '$1 == "blob" && $2 > cap { print $3 }')
  if [ -n "$big" ]; then
    echo "a home does not take files over ${HOME_FILE_LIMIT_BYTES} bytes: $big" >&2
    exit 1
  fi
  bad=$(git ls-tree -r --name-only "$new" | grep -E "$forbidden")
  if [ -n "$bad" ]; then
    echo "a home does not take the board's own records: $bad" >&2
    exit 1
  fi
  case "$old" in
    *[!0]*)
      if ! git diff --quiet "$old" "$new" -- .gitignore; then
        echo "a home's .gitignore is the board's" >&2
        exit 1
      fi
      ;;
  esac
done
exit 0
`;

const BOARD_IDENTITY = [
  "-c",
  "user.name=stellaris-board",
  "-c",
  "user.email=board@stellaris.local",
];

async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await execa("git", [...BOARD_IDENTITY, ...args], {
    cwd,
    reject: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Every agent's home as a git repository the runners clone and push to. The home directory stays
 * an ordinary directory, its working tree, which the board reads as before: a push updates it in
 * place (`receive.denyCurrentBranch updateInstead`), which needs a clean tree, so the board writes
 * tracked files only when it creates a home, as its first commit.
 */
export class HomeRepos {
  private readonly ready = new Map<string, Promise<void>>();

  constructor(private readonly hooksDir: string) {}

  /** Writes the shared pre-receive hook every home runs. */
  async installHooks(): Promise<void> {
    await mkdir(this.hooksDir, { recursive: true });
    const hook = path.join(this.hooksDir, "pre-receive");
    await writeFile(hook, PRE_RECEIVE, "utf8");
    await chmod(hook, 0o755);
  }

  /**
   * Makes a home a repository if it is not one yet, committing what is in it, and configures it to
   * take pushes into its working tree through the board's hook. A home whose ignore file predates
   * the board's current one gets the current one as a commit by the board, before any push is taken.
   * Runs once per home in a process; every later call waits for that run.
   */
  ensure(home: string): Promise<void> {
    let run = this.ready.get(home);
    if (run === undefined) {
      run = this.prepare(home);
      this.ready.set(home, run);
      run.catch(() => this.ready.delete(home));
    }
    return run;
  }

  private async prepare(home: string): Promise<void> {
    const ignore = path.join(home, ".gitignore");
    if (!(await exists(path.join(home, ".git")))) {
      await mkdir(home, { recursive: true });
      await git(["init", "--quiet", "--initial-branch=main"], home);
      await writeFile(ignore, IGNORE_FILE, "utf8");
      await git(["add", "--all"], home);
      await git(["commit", "--quiet", "--allow-empty", "-m", "home: created by the board"], home);
    } else if ((await readFile(ignore, "utf8").catch(() => "")) !== IGNORE_FILE) {
      await writeFile(ignore, IGNORE_FILE, "utf8");
      await git(["add", ".gitignore"], home);
      await git(["commit", "--quiet", "-m", "home: the board's ignore file"], home);
    }
    await git(["config", "receive.denyCurrentBranch", "updateInstead"], home);
    // A forced push would drop what another runner pushed; git refuses one before the tree moves.
    await git(["config", "receive.denyNonFastForwards", "true"], home);
    await git(["config", "core.hooksPath", this.hooksDir], home);
    await git(["config", "http.receivepack", "true"], home);
  }
}
