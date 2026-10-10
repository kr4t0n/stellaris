import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  conflictCopyOf,
  HOME_FILE_LIMIT_BYTES,
  HOME_SCRATCH,
  type HomeChange,
  type HomeFileChange,
  type HomeFileDiff,
  type HomeHistory,
} from "@stellaris/shared";
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
  "/projects/*/channels/",
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
forbidden='^(agent\\.json|cursors\\.json|role\\.md|turns/|\\.claude/|\\.codex/|projects/[^/]+/(sessions[^/]*\\.json|last-turn\\.json|threads/|channels/))'
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

/** The name the board commits under in a home; its history shows those commits as the board's. */
const HOME_BOARD_AUTHOR = "stellaris-board";

const BOARD_IDENTITY = [
  "-c",
  `user.name=${HOME_BOARD_AUTHOR}`,
  "-c",
  "user.email=board@stellaris.local",
];

/** The most of one file's patch a change shows. */
const PATCH_LIMIT_CHARS = 50_000;
/** How a runner names the commit of what a turn left. */
const TURN_SUBJECT = /^turn ([0-9A-HJKMNP-TV-Z]{26})$/;
const RECORD = "\x1e";
const FIELD = "\x1f";

/** Runs a read in a home's repository, with paths taken literally and printed unquoted. */
async function read(home: string, args: readonly string[]): Promise<string> {
  const result = await execa(
    "git",
    ["-c", "core.quotePath=false", "--literal-pathspecs", ...args],
    {
      cwd: home,
      reject: false,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ""} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function lineCount(value: string | undefined): number | null {
  return value === undefined || value === "-" ? null : Number.parseInt(value, 10);
}

function fileStatus(letter: string): HomeFileChange["status"] {
  return letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
}

/** The hunks of a one-file patch without its header, cut at the limit, or null for a binary file. */
function hunksOf(patch: string): { patch: string | null; truncated: boolean } {
  if (/^Binary files .* differ$/m.test(patch)) {
    return { patch: null, truncated: false };
  }
  const start = patch.search(/^@@/m);
  const hunks = start === -1 ? "" : patch.slice(start);
  if (hunks.length <= PATCH_LIMIT_CHARS) {
    return { patch: hunks, truncated: false };
  }
  const cut = hunks.lastIndexOf("\n", PATCH_LIMIT_CHARS);
  return { patch: hunks.slice(0, cut === -1 ? PATCH_LIMIT_CHARS : cut), truncated: true };
}

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

  /**
   * When a file in a home last changed in its history, or null when the history does not hold it.
   * Plain history simplification is what finds a file a merge added: `--diff-filter=A` shows no
   * merge, and a later merge that only carries the file in is skipped as unchanged.
   */
  async changedAt(home: string, file: string): Promise<string | null> {
    if (!(await exists(path.join(home, ".git")))) {
      return null;
    }
    const result = await execa("git", ["log", "-1", "--format=%ct", "--", file], {
      cwd: home,
      reject: false,
    });
    const seconds = Number.parseInt(result.stdout.trim(), 10);
    return result.exitCode === 0 && Number.isFinite(seconds)
      ? new Date(seconds * 1000).toISOString()
      : null;
  }

  /**
   * The newest `limit` commits of a home, each with the files it touched. A merge is the runners
   * combining work whose sides are listed already, so one is listed only when it kept conflict
   * copies, and then with those alone. A home that is not a repository yet has no history; the
   * check matters, since git would otherwise read whatever repository holds the data directory.
   */
  async history(home: string, limit: number): Promise<HomeHistory> {
    if (!(await exists(path.join(home, ".git")))) {
      return { changes: [], more: false };
    }
    const log = await read(home, [
      "log",
      "--no-color",
      "--no-renames",
      `--format=${RECORD}%H${FIELD}%P${FIELD}%an${FIELD}%at${FIELD}%s`,
      "--numstat",
      "--summary",
      `--max-count=${limit + 1}`,
    ]);
    const records = log.split(RECORD).filter((record) => record.trim() !== "");
    const changes: HomeChange[] = [];
    for (const record of records.slice(0, limit)) {
      const [header = "", ...lines] = record.split("\n");
      const [commit = "", parents = "", author = "", seconds = "0", subject = ""] =
        header.split(FIELD);
      const [first, ...others] = parents.split(" ").filter((parent) => parent !== "");
      const files =
        first !== undefined && others.length > 0
          ? await this.keptCopies(home, first, commit)
          : filesOf(lines);
      if (others.length > 0 && files.length === 0) {
        continue;
      }
      const turnId = TURN_SUBJECT.exec(subject)?.[1];
      changes.push({
        commit,
        at: new Date(Number.parseInt(seconds, 10) * 1000).toISOString(),
        kind: others.length > 0 ? "merge" : author === HOME_BOARD_AUTHOR ? "board" : "turn",
        author,
        ...(turnId === undefined ? {} : { turnId }),
        subject,
        files,
      });
    }
    return { changes, more: records.length > limit };
  }

  /**
   * One commit of a home, file by file with its patch against the commit before it, or null when
   * the home has no such commit. A merge shows the conflict copies it kept, as its history entry
   * lists them.
   */
  async change(home: string, commit: string): Promise<HomeFileDiff[] | null> {
    if (!(await exists(path.join(home, ".git")))) {
      return null;
    }
    const type = await execa("git", ["cat-file", "-t", commit], { cwd: home, reject: false });
    if (type.exitCode !== 0 || type.stdout.trim() !== "commit") {
      return null;
    }
    const [, first, ...others] = (await read(home, ["rev-list", "--parents", "-n", "1", commit]))
      .trim()
      .split(" ");
    const range =
      first !== undefined && others.length > 0
        ? ["diff", "--no-color", "--no-renames", first, commit]
        : ["show", "--no-color", "--no-renames", "--format=", commit];
    const listed = (await read(home, [...range, "--name-status", "-z"])).split("\0");
    const files: HomeFileDiff[] = [];
    for (let index = 0; index + 1 < listed.length; index += 2) {
      const status = fileStatus(listed[index] ?? "");
      const file = listed[index + 1] ?? "";
      if (others.length > 0 && (status !== "added" || conflictCopyOf(file) === null)) {
        continue;
      }
      files.push({ path: file, status, ...hunksOf(await read(home, [...range, "--", file])) });
    }
    return files;
  }

  /** The conflict copies a merge added, against its first parent. */
  private async keptCopies(
    home: string,
    parent: string,
    commit: string,
  ): Promise<HomeFileChange[]> {
    const added = await read(home, [
      "diff",
      "--no-renames",
      "--numstat",
      "--diff-filter=A",
      parent,
      commit,
    ]);
    return filesOf(added.split("\n"), "added").filter((file) => conflictCopyOf(file.path) !== null);
  }
}

/**
 * The files of a commit from `--numstat` lines, with `--summary` lines marking the ones created or
 * deleted; or all with the status given.
 */
function filesOf(lines: readonly string[], status?: HomeFileChange["status"]): HomeFileChange[] {
  const files = new Map<string, HomeFileChange>();
  for (const line of lines) {
    const counted = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (counted?.[3] !== undefined) {
      files.set(counted[3], {
        path: counted[3],
        status: status ?? "modified",
        added: lineCount(counted[1]),
        removed: lineCount(counted[2]),
      });
      continue;
    }
    const summary = /^ (create|delete) mode \d+ (.+)$/.exec(line);
    const file = summary?.[2] === undefined ? undefined : files.get(summary[2]);
    if (file !== undefined) {
      files.set(file.path, { ...file, status: summary?.[1] === "create" ? "added" : "deleted" });
    }
  }
  return [...files.values()];
}
