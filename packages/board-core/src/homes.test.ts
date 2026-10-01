import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HomeRepos } from "./homes.js";

const TURN_A = "01M3S000000000000000000AAA";
const TURN_B = "01M3S000000000000000000BBB";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa(
    "git",
    ["-c", "user.name=ada", "-c", "user.email=ada@stellaris.local", ...args],
    { cwd },
  );
  return result.stdout;
}

describe("HomeRepos history", () => {
  let dir: string;
  let home: string;
  let homes: HomeRepos;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-homes-"));
    home = path.join(dir, "agents", "ada");
    await mkdir(path.join(home, "memory"), { recursive: true });
    await writeFile(path.join(home, "memory", "core.md"), "# Core memory\n\n- one\n", "utf8");
    homes = new HomeRepos(path.join(dir, "hooks"));
    await homes.installHooks();
    await homes.ensure(home);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists a home's changes newest first with the turn and the files each touched", async () => {
    await writeFile(path.join(home, "memory", "core.md"), "# Core memory\n\n- one, learned\n");
    await mkdir(path.join(home, "skills", "triage"), { recursive: true });
    await writeFile(path.join(home, "skills", "triage", "SKILL.md"), "# Triage\n\n1. Read\n");
    await writeFile(path.join(home, "logo.png"), Buffer.from([0, 1, 2, 0, 255]));
    await git(home, "add", "--all");
    await git(home, "commit", "-qm", `turn ${TURN_A}`);
    await git(home, "rm", "-q", "logo.png");
    await git(home, "commit", "-qm", `turn ${TURN_B}`);

    const { changes, more } = await homes.history(home, 30);
    expect(more).toBe(false);
    expect(changes.map((change) => [change.kind, change.turnId ?? null, change.author])).toEqual([
      ["turn", TURN_B, "ada"],
      ["turn", TURN_A, "ada"],
      ["board", null, "stellaris-board"],
    ]);
    expect(changes[1]?.files).toEqual([
      { path: "logo.png", status: "added", added: null, removed: null },
      { path: "memory/core.md", status: "modified", added: 1, removed: 1 },
      { path: "skills/triage/SKILL.md", status: "added", added: 3, removed: 0 },
    ]);
    expect(changes[0]?.files).toEqual([
      { path: "logo.png", status: "deleted", added: null, removed: null },
    ]);
    // The board's first commit created the home.
    expect(changes[2]?.subject).toBe("home: created by the board");
    expect(changes[2]?.files.map((file) => [file.path, file.status])).toEqual([
      [".gitignore", "added"],
      ["memory/core.md", "added"],
    ]);

    const page = await homes.history(home, 2);
    expect(page.more).toBe(true);
    expect(page.changes.map((change) => change.turnId)).toEqual([TURN_B, TURN_A]);

    const files = await homes.change(home, changes[1]?.commit ?? "");
    expect(files?.map((file) => [file.path, file.status, file.patch])).toEqual([
      ["logo.png", "added", null],
      ["memory/core.md", "modified", "@@ -1,3 +1,3 @@\n # Core memory\n \n-- one\n+- one, learned"],
      ["skills/triage/SKILL.md", "added", "@@ -0,0 +1,3 @@\n+# Triage\n+\n+1. Read"],
    ]);
    expect(await homes.change(home, "0".repeat(40))).toBeNull();
  });

  it("lists a merge only for the conflict copies it kept, and shows those alone", async () => {
    const base = (await git(home, "rev-parse", "HEAD")).trim();
    await writeFile(path.join(home, "memory", "core.md"), "# Core memory\n\n- one, from b\n");
    await git(home, "commit", "-qam", `turn ${TURN_B}`);
    // A runner's turn on the old base, merged as HomeSync does: the board's version stays in
    // place and the turn's is kept beside it.
    await git(home, "checkout", "-q", "-b", "runner", base);
    await writeFile(path.join(home, "memory", "core.md"), "# Core memory\n\n- one, from a\n");
    await git(home, "commit", "-qam", `turn ${TURN_A}`);
    await git(home, "merge", "-q", "main", "--no-commit").catch(() => undefined);
    await writeFile(
      path.join(home, "memory", `core.md.conflict-${TURN_A.slice(-8)}`),
      "# Core memory\n\n- one, from a\n",
    );
    await git(home, "checkout", "--theirs", "--", "memory/core.md");
    await git(home, "add", "--all");
    await git(home, "commit", "-q", "--no-edit");
    // A merge that conflicted in nothing is the runners' bookkeeping, not a change.
    await git(home, "checkout", "-q", "-b", "quiet", base);
    await writeFile(path.join(home, "notes.md"), "# Notes\n");
    await git(home, "add", "--all");
    await git(home, "commit", "-qm", "turn 01M3S000000000000000000CCC");
    await git(home, "checkout", "-q", "runner");
    await git(home, "merge", "-q", "--no-edit", "quiet");

    const { changes } = await homes.history(home, 30);
    const merges = changes.filter((change) => change.kind === "merge");
    expect(merges).toHaveLength(1);
    expect(merges[0]?.files).toEqual([
      {
        path: `memory/core.md.conflict-${TURN_A.slice(-8)}`,
        status: "added",
        added: 3,
        removed: 0,
      },
    ]);
    const files = await homes.change(home, merges[0]?.commit ?? "");
    expect(files?.map((file) => [file.path, file.patch])).toEqual([
      [
        `memory/core.md.conflict-${TURN_A.slice(-8)}`,
        "@@ -0,0 +1,3 @@\n+# Core memory\n+\n+- one, from a",
      ],
    ]);
  });

  it("has no history for a home that is not a repository, whatever holds it", async () => {
    // The data directory inside a repository of its own, as `./data` in a checkout is.
    await git(dir, "init", "-q");
    await writeFile(path.join(dir, "readme.md"), "outer\n");
    await git(dir, "add", "readme.md");
    await git(dir, "commit", "-qm", "outer");
    const bare = path.join(dir, "agents", "user");
    await mkdir(bare, { recursive: true });
    expect(await homes.history(bare, 30)).toEqual({ changes: [], more: false });
    expect(await homes.change(bare, (await git(dir, "rev-parse", "HEAD")).trim())).toBeNull();
  });
});
