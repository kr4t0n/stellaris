import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

/**
 * The repositories projects travel through when the user moves one to another runner: one bare
 * repository per move, which the old runner pushes every branch and tag to and the new runner
 * clones, made when the move starts and removed when it ends, whatever the outcome. None outlives
 * the server's process, so a start removes what a crash left.
 */
export class MoveRepos {
  constructor(private readonly root: string) {}

  /** Makes the move's empty repository, which checks every object a push brings, and answers its path. */
  async open(dir: string): Promise<string> {
    await mkdir(this.root, { recursive: true });
    await git(["init", "--quiet", "--bare", dir], this.root);
    await git(["config", "receive.fsckObjects", "true"], dir);
    return dir;
  }

  async drop(dir: string): Promise<void> {
    await rm(path.resolve(this.root, dir), { recursive: true, force: true });
  }

  /** Removes every move's repository, as the server starts: a move never survives a restart. */
  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

async function git(args: readonly string[], cwd: string): Promise<void> {
  const result = await execa("git", args, {
    cwd,
    reject: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ""} failed: ${result.stderr.trim()}`);
  }
}
