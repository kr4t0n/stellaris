import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitIdentityPart } from "@stellaris/shared";
import { execa } from "execa";
import { describeError } from "./errors.js";
import type { RunnerLog } from "./executor.js";

/** The settings git reads a commit's identity from, past the environment's overrides. */
const IDENTITY_KEYS = String.raw`^(user|author|committer)\.(name|email)$`;

/** A commit carries two identities, and git looks each one up on its own. */
const ROLES = [
  { role: "author", env: "AUTHOR" },
  { role: "committer", env: "COMMITTER" },
] as const;

/** A value git takes only when it holds something; an empty one falls through to the next place. */
function filled(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** Whether git found nothing to use: no place gave the part, or the one that did gave a blank. */
function lacks(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/**
 * What a commit made under `env` with these settings lacks of an identity, by git's own order of
 * places. For each of the author and the committer, the name is `GIT_<ROLE>_NAME`, else
 * `<role>.name`, else `user.name`, and the email is `GIT_<ROLE>_EMAIL`, else `<role>.email`, else
 * `user.email`; the variables and `user.*` count when set even if empty, as in git, and the others
 * only when they hold something. `EMAIL` comes last, and only while no `user.email`,
 * `author.email`, or `committer.email` is set at all: any of them, even empty, leaves a role that
 * has none of its own with `user.email` or an empty address. Past those, git falls back to the
 * account's full name, refusing the commit when that is empty, as in a container's account, and
 * makes an address up from the account and the host's name; neither fallback counts, since nobody
 * chose it.
 */
export function missingGitIdentity(
  settings: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv,
): GitIdentityPart[] {
  const missing = new Set<GitIdentityPart>();
  const emailSet = ["user.email", "author.email", "committer.email"].some((key) =>
    settings.has(key),
  );
  for (const { role, env: variable } of ROLES) {
    const name =
      env[`GIT_${variable}_NAME`] ??
      filled(settings.get(`${role}.name`)) ??
      settings.get("user.name");
    const email =
      env[`GIT_${variable}_EMAIL`] ??
      filled(settings.get(`${role}.email`)) ??
      settings.get("user.email") ??
      (emailSet ? undefined : filled(env["EMAIL"]));
    if (lacks(name)) {
      missing.add("name");
    }
    if (lacks(email)) {
      missing.add("email");
    }
  }
  return (["name", "email"] as const).filter((part) => missing.has(part));
}

/**
 * The identity settings git reads outside any repository, the last of each key winning as in git:
 * the system's, the account's global ones, and any given through `GIT_CONFIG_*`. It runs in an
 * empty folder of its own, above which git looks for no repository, and without `GIT_DIR`, so no
 * project's own settings count. A key written with no value reads as empty.
 */
export async function gitIdentitySettings(env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const dir = await mkdtemp(path.join(tmpdir(), "stellaris-identity-"));
  try {
    const outside = Object.entries(env).filter(([key]) => key !== "GIT_DIR");
    const result = await execa("git", ["config", "--null", "--get-regexp", IDENTITY_KEYS], {
      cwd: dir,
      env: {
        ...Object.fromEntries(outside),
        GIT_CEILING_DIRECTORIES: path.dirname(dir),
        LC_ALL: "C",
      },
      extendEnv: false,
      reject: false,
    });
    // Git answers 1 when no key matches, and anything else when it could not read its settings.
    if (result.exitCode === 1 && result.stdout === "") {
      return new Map();
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.shortMessage);
    }
    const settings = new Map<string, string>();
    for (const entry of result.stdout.split("\0")) {
      if (entry === "") {
        continue;
      }
      const end = entry.indexOf("\n");
      settings.set(
        end === -1 ? entry : entry.slice(0, end),
        end === -1 ? "" : entry.slice(end + 1),
      );
    }
    return settings;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * What this runner's account lacks of the git identity its citizens' own commits carry, since the
 * runner gives the CLIs none and they inherit its environment.
 */
export async function checkGitIdentity(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitIdentityPart[]> {
  return missingGitIdentity(await gitIdentitySettings(env), env);
}

/** The warning a runner logs for a gap, naming what is missing and the commands that fill it. */
export function gitIdentityWarning(missing: readonly GitIdentityPart[]): string {
  const keys = missing.map((part) => `user.${part}`).join(" or ");
  const effect = missing.includes("name")
    ? "git refuses the commits citizens make themselves"
    : "the commits citizens make themselves carry an empty address, or one git makes up from the account and the host's name";
  const commands = missing
    .map(
      (part) =>
        `git config --global user.${part} "${part === "name" ? "Your Name" : "you@example.com"}"`,
    )
    .join(" && ");
  return `this runner's account has no git ${keys}, so ${effect}. Run ${commands} as the account the runner runs as; the board marks this runner until it connects with ${missing.length === 1 ? "it" : "them"} set, as after a restart`;
}

/**
 * The runner's watch on its account's git identity: it checks when asked, at startup and before
 * every hello, and warns when a gap appears or changes and notes when it closes, so a runner that
 * reconnects often warns once. It is only a warning: turns run all the same, and nothing gives
 * the CLIs an identity in its place.
 */
export class GitIdentityCheck {
  /** The gap the log last spoke of; null before the first check. */
  private logged: string | null = null;

  constructor(
    private readonly log: RunnerLog,
    private readonly read: () => Promise<readonly GitIdentityPart[]> = () => checkGitIdentity(),
  ) {}

  /** What the account lacks, or null when git could not say, which a hello then leaves out. */
  async check(): Promise<GitIdentityPart[] | null> {
    let missing: GitIdentityPart[];
    try {
      missing = [...(await this.read())];
    } catch (error) {
      this.log.warn(
        { error: describeError(error) },
        "could not check the git identity of this runner's account",
      );
      return null;
    }
    const gap = missing.join(" ");
    if (gap !== this.logged) {
      if (missing.length > 0) {
        this.log.warn({ missing }, gitIdentityWarning(missing));
      } else if (this.logged !== null) {
        this.log.info({}, "this runner's account has a git identity now");
      }
      this.logged = gap;
    }
    return missing;
  }
}
