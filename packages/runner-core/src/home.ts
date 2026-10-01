import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Name } from "@stellaris/shared";
import { execa } from "execa";
import type { RunnerLog } from "./executor.js";
import type { RunnerLayout } from "./layout.js";

/** Where an agent's home repository is, and the header that lets this runner reach it. */
export interface HomeRemote {
  url(agent: Name): string;
  /** An `Authorization` header line for git's `http.extraHeader`, or null for a local path. */
  readonly authorization: string | null;
}

const SILENT: RunnerLog = { info() {}, warn() {}, error() {} };
/** How many times a push is merged and tried again before the turn's work waits for the next one. */
const PUSH_ATTEMPTS = 5;

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The runner's copies of agent homes, each a clone of the home's repository on the board server.
 * Before a turn the copy takes what other runners pushed; after it, what the turn left is committed
 * and pushed, merged first with anything pushed meanwhile, as `git pull` then `git push` would. A
 * file both sides changed in the same lines keeps the server's version, and this turn's is kept
 * beside it as `<file>.conflict-<turn>`, so no edit is lost and the citizen reconciles them. Work
 * on one agent's copy runs one step at a time; turns of one agent on this runner share the copy.
 */
export class HomeSync {
  private readonly locks = new Map<Name, Promise<unknown>>();

  constructor(
    private readonly layout: RunnerLayout,
    private readonly remote: HomeRemote,
    private readonly log: RunnerLog = SILENT,
  ) {}

  /**
   * Brings the agent's copy up to the server's: a clone the first time, then a merge of what other
   * runners pushed, unless a turn of the agent is still at work in it, whose own push will merge.
   */
  prepare(agent: Name): Promise<void> {
    return this.serial(agent, async () => {
      const home = this.layout.agent(agent);
      if (!(await exists(path.join(home, ".git")))) {
        await this.clone(agent, home);
        return;
      }
      await this.must(home, ["fetch", "--quiet", "origin", "main"], true);
      if ((await this.must(home, ["status", "--porcelain"])).trim() !== "") {
        return;
      }
      await this.merge(agent, home, "conflict-local");
    });
  }

  /**
   * Commits what a turn left in the agent's home and pushes it. Returns the files that conflicted
   * with what another runner had pushed, each kept beside the server's version.
   */
  publish(agent: Name, turnId: string): Promise<string[]> {
    return this.serial(agent, async () => {
      const home = this.layout.agent(agent);
      if (!(await exists(path.join(home, ".git")))) {
        return [];
      }
      await this.must(home, ["add", "--all"]);
      const staged = await this.git(home, ["diff", "--cached", "--quiet"]);
      if (!staged.ok) {
        await this.must(home, [
          ...this.identity(agent),
          "commit",
          "--quiet",
          "-m",
          `turn ${turnId}`,
        ]);
      }
      const conflicts: string[] = [];
      for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
        const pushed = await this.git(home, ["push", "--quiet", "origin", "HEAD:main"], true);
        if (pushed.ok) {
          return conflicts;
        }
        this.log.info(
          { agent, attempt, reason: pushed.stderr.trim() },
          "home push refused; merging",
        );
        await this.must(home, ["fetch", "--quiet", "origin", "main"], true);
        conflicts.push(...(await this.merge(agent, home, `conflict-${turnId.slice(-8)}`)));
      }
      this.log.warn({ agent, turnId }, "home not pushed; the next turn of the agent tries again");
      return conflicts;
    });
  }

  private async clone(agent: Name, home: string): Promise<void> {
    if (await exists(home)) {
      // A copy from before homes were repositories: kept aside, never merged by guesswork.
      await rename(home, `${home}.before-git-${Date.now()}`);
    }
    await mkdir(path.dirname(home), { recursive: true });
    const cloned = await execa(
      "git",
      [...this.auth(), "clone", "--quiet", "--branch", "main", this.remote.url(agent), home],
      { reject: false, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    if (cloned.exitCode !== 0) {
      throw new Error(`could not clone ${agent}'s home: ${cloned.stderr.trim()}`);
    }
  }

  /**
   * Merges the server's `main` into the copy. Where both changed the same lines, the server's
   * version stays and the copy's is written beside it with `label`; returns those files.
   */
  private async merge(agent: Name, home: string, label: string): Promise<string[]> {
    const merged = await this.git(home, [
      ...this.identity(agent),
      "merge",
      "--quiet",
      "--autostash",
      "--no-edit",
      "origin/main",
    ]);
    if (merged.ok) {
      return [];
    }
    const unmerged = (await this.must(home, ["diff", "--name-only", "--diff-filter=U"]))
      .split("\n")
      .filter((file) => file.length > 0);
    if (unmerged.length === 0) {
      await this.git(home, ["merge", "--abort"]);
      throw new Error(`could not merge ${agent}'s home: ${merged.stderr.trim()}`);
    }
    for (const file of unmerged) {
      const ours = await execa("git", ["show", `:2:${file}`], {
        cwd: home,
        reject: false,
        encoding: "buffer",
      });
      if (ours.exitCode === 0) {
        await writeFile(path.join(home, `${file}.${label}`), ours.stdout);
      }
      const theirs = await this.git(home, ["cat-file", "-e", `:3:${file}`]);
      await this.must(
        home,
        theirs.ok ? ["checkout", "--theirs", "--", file] : ["rm", "--quiet", "--", file],
      );
    }
    await this.must(home, ["add", "--all"]);
    await this.must(home, [...this.identity(agent), "commit", "--quiet", "--no-edit"]);
    this.log.warn(
      { agent, files: unmerged },
      "home edits conflicted; kept the server's and the turn's",
    );
    return unmerged;
  }

  private identity(agent: Name): string[] {
    return ["-c", `user.name=${agent}`, "-c", `user.email=${agent}@stellaris.local`];
  }

  private auth(): string[] {
    return this.remote.authorization === null
      ? []
      : ["-c", `http.extraHeader=${this.remote.authorization}`];
  }

  private async git(home: string, args: readonly string[], network = false): Promise<GitResult> {
    const result = await execa("git", [...(network ? this.auth() : []), ...args], {
      cwd: home,
      reject: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
  }

  private async must(home: string, args: readonly string[], network = false): Promise<string> {
    const result = await this.git(home, args, network);
    if (!result.ok) {
      throw new Error(`git ${args[0] ?? ""} failed in ${home}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }

  private serial<T>(agent: Name, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agent) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.locks.set(
      agent,
      run.catch(() => undefined),
    );
    return run;
  }
}
