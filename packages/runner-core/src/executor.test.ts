import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MOVE_PACK_LIMIT_BYTES, moveTransferMs, type ProjectRepo } from "@stellaris/shared";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TurnExecutor, type MoveRemote } from "./executor.js";
import { ExecaGit, type GitAuth } from "./git.js";
import { RunnerLayout } from "./layout.js";

const MOVE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/** The runner's git, noting the clock each move's push and clone is given. */
class TimedGit extends ExecaGit {
  readonly clocks: Array<{ op: "push" | "clone"; timeoutMs: number | undefined }> = [];

  override async pushEverything(
    repoDir: string,
    url: string,
    auth: GitAuth | null,
    timeoutMs?: number,
  ): Promise<void> {
    this.clocks.push({ op: "push", timeoutMs });
    await super.pushEverything(repoDir, url, auth, timeoutMs);
  }

  override async cloneEverything(
    url: string,
    auth: GitAuth | null,
    dir: string,
    project: ProjectRepo,
    timeoutMs?: number,
  ): Promise<void> {
    this.clocks.push({ op: "clone", timeoutMs });
    await super.cloneEverything(url, auth, dir, project, timeoutMs);
  }
}

describe("a project's move on a runner", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-executor-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function runner(name: string) {
    const git = new TimedGit();
    const layout = new RunnerLayout(path.join(dir, name));
    const executor = new TurnExecutor({
      layout,
      backends: {},
      runnerName: () => name,
      git,
      serverUrl: "http://127.0.0.1:1",
    });
    return { git, layout, executor };
  }

  it("times the push by the packs it measured, and the clone by the size it is told or the cap", async () => {
    const project: ProjectRepo = {
      slug: "demo",
      origin: null,
      defaultBranch: "main",
      boardLands: false,
    };
    const a = runner("a");
    const repo = await a.git.ensureRepo(project, a.layout.repo("demo"));
    // Random bytes stay their size in a pack, so the clock moves past the ten minutes alone.
    await writeFile(path.join(repo, "weights.bin"), randomBytes(256 * 1024));
    await execa("git", ["add", "weights.bin"], { cwd: repo });
    await execa(
      "git",
      ["-c", "user.name=eng-1", "-c", "user.email=eng-1@x", "commit", "-qm", "weights"],
      { cwd: repo },
    );
    const carry = path.join(dir, "carry.git");
    await execa("git", ["init", "--quiet", "--bare", carry]);
    const remote: MoveRemote = { url: () => carry, authorization: null };

    const exported = await a.executor.exportProject({ move: MOVE, repo: project }, remote);
    expect(exported).toMatchObject({ ok: true });
    expect(exported.bytes).toBeGreaterThan(256 * 1024);
    expect(a.git.clocks).toEqual([{ op: "push", timeoutMs: moveTransferMs(exported.bytes) }]);

    const b = runner("b");
    await b.executor.importProject(
      { move: MOVE, repo: project, pullRequests: false, bytes: exported.bytes },
      remote,
    );
    expect(b.git.clocks).toEqual([{ op: "clone", timeoutMs: moveTransferMs(exported.bytes) }]);

    // From a server that names no size, the clone is timed for a pack at the cap.
    const c = runner("c");
    await c.executor.importProject({ move: MOVE, repo: project, pullRequests: false }, remote);
    expect(c.git.clocks).toEqual([
      { op: "clone", timeoutMs: moveTransferMs(MOVE_PACK_LIMIT_BYTES) },
    ]);
  });
});
