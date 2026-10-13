import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitIdentityPart } from "@stellaris/shared";
import {
  checkGitIdentity,
  GitIdentityCheck,
  gitIdentitySettings,
  gitIdentityWarning,
  missingGitIdentity,
} from "./git-identity.js";

/** Settings as `git config` lists them, the last of a key winning. */
function settings(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

const CITIZEN = {
  GIT_AUTHOR_NAME: "eng-1",
  GIT_AUTHOR_EMAIL: "eng-1@stellaris.local",
  GIT_COMMITTER_NAME: "eng-1",
  GIT_COMMITTER_EMAIL: "eng-1@stellaris.local",
};

describe("missingGitIdentity", () => {
  it("finds nothing missing when the account has a name and an email", () => {
    expect(
      missingGitIdentity(settings({ "user.name": "Op", "user.email": "op@example.com" }), {}),
    ).toEqual([]);
  });

  it("finds both missing when nothing gives them", () => {
    expect(missingGitIdentity(settings({}), {})).toEqual(["name", "email"]);
  });

  it("finds the name missing, which makes git refuse a commit", () => {
    expect(missingGitIdentity(settings({ "user.email": "op@example.com" }), {})).toEqual(["name"]);
  });

  it("finds the email missing, which git would make up from the account and the host", () => {
    expect(missingGitIdentity(settings({ "user.name": "Op" }), {})).toEqual(["email"]);
  });

  it("counts an identity the environment gives alone, for the author and the committer both", () => {
    expect(missingGitIdentity(settings({}), CITIZEN)).toEqual([]);
    // A commit needs a committer as well, and git looks it up on its own.
    expect(
      missingGitIdentity(settings({}), {
        GIT_AUTHOR_NAME: "eng-1",
        GIT_AUTHOR_EMAIL: "eng-1@stellaris.local",
      }),
    ).toEqual(["name", "email"]);
    expect(
      missingGitIdentity(settings({ "user.name": "Op" }), { EMAIL: "op@example.com" }),
    ).toEqual([]);
  });

  it("counts the author's and the committer's own settings", () => {
    expect(
      missingGitIdentity(
        settings({
          "author.name": "Au",
          "author.email": "au@example.com",
          "committer.name": "Co",
          "committer.email": "co@example.com",
        }),
        {},
      ),
    ).toEqual([]);
    expect(
      missingGitIdentity(settings({ "author.name": "Au", "author.email": "au@example.com" }), {}),
    ).toEqual(["name", "email"]);
  });

  it("follows git where a place is set but empty", () => {
    // An empty variable is taken, and git refuses the empty name.
    expect(
      missingGitIdentity(settings({ "user.name": "Op", "user.email": "op@example.com" }), {
        GIT_AUTHOR_NAME: "",
      }),
    ).toEqual(["name"]);
    // An empty author.email is passed over for user.email.
    expect(
      missingGitIdentity(
        settings({ "user.name": "Op", "author.email": "", "user.email": "op@example.com" }),
        {},
      ),
    ).toEqual([]);
    // An empty user.email is taken, so EMAIL is never read, and the commit's address is empty.
    expect(
      missingGitIdentity(settings({ "user.name": "Op", "user.email": "" }), {
        EMAIL: "op@example.com",
      }),
    ).toEqual(["email"]);
    // An empty EMAIL is passed over, and git makes an address up.
    expect(missingGitIdentity(settings({ "user.name": "Op" }), { EMAIL: "" })).toEqual(["email"]);
    expect(
      missingGitIdentity(settings({ "user.name": "  ", "user.email": "op@example.com" }), {}),
    ).toEqual(["name"]);
  });
});

describe("gitIdentitySettings", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const tmp = process.env["TMPDIR"];
  const gitDir = process.env["GIT_DIR"];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-identity-test-"));
    await mkdir(path.join(dir, "home"));
    // Only what git needs to run, an account of the test's own, and no system settings.
    env = { PATH: process.env["PATH"], HOME: path.join(dir, "home"), GIT_CONFIG_NOSYSTEM: "1" };
  });

  afterEach(async () => {
    if (tmp === undefined) {
      delete process.env["TMPDIR"];
    } else {
      process.env["TMPDIR"] = tmp;
    }
    if (gitDir === undefined) {
      delete process.env["GIT_DIR"];
    } else {
      process.env["GIT_DIR"] = gitDir;
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function global(text: string): Promise<void> {
    await writeFile(path.join(dir, "home", ".gitconfig"), text, "utf8");
  }

  it("reads the account's settings, the last of a key winning, and none when there are none", async () => {
    expect(await gitIdentitySettings(env)).toEqual(new Map());
    await global(
      "[user]\n\tname = Op Erator\n\temail = op@example.com\n[author]\n\tname = Au\n[user]\n\tname = Later\n[core]\n\teditor = vi\n",
    );
    expect(await gitIdentitySettings(env)).toEqual(
      settings({ "user.name": "Later", "user.email": "op@example.com", "author.name": "Au" }),
    );
    // A key written with no value reads as empty, which leaves that part missing.
    await global("[user]\n\tname = Op\n[committer]\n\temail\n");
    expect(await gitIdentitySettings(env)).toEqual(
      settings({ "user.name": "Op", "committer.email": "" }),
    );
    expect(await checkGitIdentity(env)).toEqual(["email"]);
    await global(
      "[user]\n\tname = Op Erator\n\temail = op@example.com\n[author]\n\tname = Au\n[user]\n\tname = Later\n[core]\n\teditor = vi\n",
    );
    // Settings given through the environment, as `git -c` passes them on, count too.
    expect(
      await gitIdentitySettings({
        ...env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "committer.email",
        GIT_CONFIG_VALUE_0: "co@example.com",
      }),
    ).toEqual(
      settings({
        "user.name": "Later",
        "user.email": "op@example.com",
        "author.name": "Au",
        "committer.email": "co@example.com",
      }),
    );
  });

  it("leaves a project's own settings out, wherever the runner is", async () => {
    await global("[user]\n\tname = Op\n");
    const repo = path.join(dir, "repo");
    await execa("git", ["init", "--quiet", repo], { env, extendEnv: false });
    await execa("git", ["config", "user.email", "project@example.com"], {
      cwd: repo,
      env,
      extendEnv: false,
    });
    // Not through a repository named in the environment, the runner's own included, nor from a
    // temporary folder inside one.
    process.env["GIT_DIR"] = path.join(repo, ".git");
    expect(await gitIdentitySettings({ ...env, GIT_DIR: path.join(repo, ".git") })).toEqual(
      settings({ "user.name": "Op" }),
    );
    delete process.env["GIT_DIR"];
    process.env["TMPDIR"] = repo;
    expect(await gitIdentitySettings(env)).toEqual(settings({ "user.name": "Op" }));
    expect(await checkGitIdentity({ ...env, GIT_DIR: path.join(repo, ".git") })).toEqual(["email"]);
  });

  it("checks the account git would commit as, environment included", async () => {
    expect(await checkGitIdentity(env)).toEqual(["name", "email"]);
    expect(await checkGitIdentity({ ...env, ...CITIZEN })).toEqual([]);
    await global("[user]\n\temail = op@example.com\n");
    expect(await checkGitIdentity(env)).toEqual(["name"]);
    await global("[user]\n\tname = Op\n");
    expect(await checkGitIdentity(env)).toEqual(["email"]);
    await global("[user]\n\tname = Op\n\temail = op@example.com\n");
    expect(await checkGitIdentity(env)).toEqual([]);
  });

  it("fails when git cannot read the account's settings", async () => {
    await global("[user\n");
    await expect(gitIdentitySettings(env)).rejects.toThrow(/bad config/);
  });
});

describe("gitIdentityWarning", () => {
  it("names what is missing and the commands that set it", () => {
    const name = gitIdentityWarning(["name"]);
    expect(name).toContain("no git user.name, so git refuses the commits citizens make themselves");
    expect(name).toContain(`git config --global user.name "Your Name"`);
    expect(name).not.toContain("user.email");

    const email = gitIdentityWarning(["email"]);
    expect(email).toContain(
      "no git user.email, so the commits citizens make themselves carry an address git makes up",
    );
    expect(email).toContain(`git config --global user.email "you@example.com"`);
    expect(email).not.toContain("user.name");

    const both = gitIdentityWarning(["name", "email"]);
    expect(both).toContain("no git user.name or user.email, so git refuses");
    expect(both).toContain(
      `git config --global user.name "Your Name" && git config --global user.email "you@example.com"`,
    );
  });
});

describe("GitIdentityCheck", () => {
  it("warns of a gap when it appears or changes, notes when it closes, and says when git could not tell", async () => {
    let answer: GitIdentityPart[] | Error = [];
    const said: string[] = [];
    const check = new GitIdentityCheck(
      {
        info: (_context, message) => said.push(`info: ${message}`),
        warn: (_context, message) => said.push(`warn: ${message}`),
        error: (_context, message) => said.push(`error: ${message}`),
      },
      () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
    );
    // Nothing to say about an identity that was always there.
    expect(await check.check()).toEqual([]);
    expect(said).toEqual([]);

    answer = ["email"];
    expect(await check.check()).toEqual(["email"]);
    expect(await check.check()).toEqual(["email"]);
    answer = ["name", "email"];
    expect(await check.check()).toEqual(["name", "email"]);
    answer = [];
    expect(await check.check()).toEqual([]);
    expect(said).toEqual([
      `warn: ${gitIdentityWarning(["email"])}`,
      `warn: ${gitIdentityWarning(["name", "email"])}`,
      "info: this runner's account has a git identity now",
    ]);

    answer = new Error("spawn git ENOENT");
    expect(await check.check()).toBeNull();
    expect(said.at(-1)).toBe("warn: could not check the git identity of this runner's account");
  });
});
