import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { ZERO_USAGE, type AgentBackend, type TurnResult } from "@stellaris/runner-core";
import {
  BranchChangesSchema,
  MEMBER_VERBS,
  ProjectMovedSchema,
  RUNNER_PROTOCOL,
  RunnerHelloSchema,
  TurnDispatchSchema,
  type RunnerHelloInput,
  type RunnerMessage,
} from "@stellaris/shared";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestSociety, type TestSociety } from "./testing/harness.js";

const USER = { name: "user", role: "user" } as const;

function completed(summary: string): TurnResult {
  return {
    events: [],
    finalText: summary,
    usage: ZERO_USAGE,
    costUsd: 0.01,
    status: {
      summary,
      claimsHeld: [],
      blockedOn: [],
      needsUserDecision: false,
      memoryUpdated: false,
    },
    exitReason: "completed",
  };
}

/** A commit in a worktree, by a citizen with a git identity of its own, as CI's account has none. */
async function commit(cwd: string, file: string): Promise<void> {
  await writeFile(path.join(cwd, file), `${file}\n`, "utf8");
  await execa("git", ["add", file], { cwd });
  await execa("git", ["-c", "user.name=eng-1", "-c", "user.email=eng-1@x", "commit", "-qm", file], {
    cwd,
  });
}

async function refsOf(repo: string): Promise<Record<string, string>> {
  const out = (
    await execa(
      "git",
      ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"],
      {
        cwd: repo,
      },
    )
  ).stdout;
  return Object.fromEntries(
    out
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [object = "", name = ""] = line.split(" ");
        return [name, object];
      }),
  );
}

/** Every commit a repository holds, newest first, with its subject. */
async function history(repo: string): Promise<string> {
  return (await execa("git", ["log", "--format=%H %s", "--all"], { cwd: repo })).stdout;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe("moving a project to another runner", () => {
  let dir: string;
  let society: TestSociety | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-moves-test-"));
  });

  afterEach(async () => {
    await society?.stop();
    society = null;
    await rm(dir, { recursive: true, force: true });
  });

  /** A society with one citizen in `slug`, and two runners, a and b, each with its own backend. */
  async function twoRunners(slug: string, repo: string | null) {
    const { board, userToken } = await Board.init(path.join(dir, "data"), { name: "moves" });
    await board.addProject(USER, { slug, repo, onDone: "none" });
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: [slug],
    });
    const ran: Array<{ runner: string; cwd: string }> = [];
    let script: ((cwd: string) => Promise<void>) | null = null;
    const backendOn = (runner: string): AgentBackend => ({
      kind: "claude",
      newSession: () => Promise.resolve(`session-${runner}`),
      runTurn: async (request) => {
        ran.push({ runner, cwd: request.spec.cwd });
        await script?.(request.spec.cwd);
        script = null;
        return completed("done");
      },
    });
    society = await startTestSociety({
      board,
      runnerName: "a",
      backends: () => ({ claude: backendOn("a") }),
      extraRunners: [{ name: "b", backends: () => ({ claude: backendOn("b") }) }],
    });
    // The citizen's turns outside the project are pinned to a, so the project's first turn lands there.
    await board.setAgentRunner(USER, "eng-1", "a");
    const live = society;
    const turn = (thread?: string) =>
      live.run({
        agent: "eng-1",
        project: slug,
        ...(thread === undefined ? {} : { thread: { id: thread, task: true } }),
        trigger: { kind: "manual" as const, fromUser: true, reason: "test" },
        priority: 1,
      });
    const move = async (body: object) => {
      const response = await live.app.request(`/api/projects/${slug}/runner`, {
        method: "PUT",
        headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const runner = (name: string) => {
      const found = live.runners.get(name);
      if (found === undefined) {
        throw new Error(`no runner ${name}`);
      }
      return found;
    };
    return {
      board,
      live,
      ran,
      turn,
      move,
      runner,
      script: (next: (cwd: string) => Promise<void>) => {
        script = next;
      },
    };
  }

  /** A bare repository standing in for GitHub, with one commit on main. */
  async function remote(): Promise<string> {
    const seed = path.join(dir, "seed");
    await execa("git", ["init", "--quiet", "-b", "main", seed]);
    await commit(seed, "README.md");
    const origin = path.join(dir, "origin.git");
    await execa("git", ["clone", "--quiet", "--bare", seed, origin]);
    return origin;
  }

  it("carries every branch and tag to the new runner, keeps a task in play working there, and lets the old copy go", async () => {
    const origin = await remote();
    const { board, live, ran, turn, move, runner, script } = await twoRunners("demo", origin);
    const a = runner("a");
    const b = runner("b");

    // The citizen's own commit, and a task in play whose work the runner commits as the turn ends.
    script((cwd) => commit(cwd, "notes.md"));
    await turn();
    const task = await board.createTask(USER, { project: "demo", title: "build" });
    const branch = `task/${task.id}`;
    script(async (cwd) => {
      await writeFile(path.join(cwd, "work.txt"), "work\n", "utf8");
      await execa("git", ["branch", "fix/typo", "main"], { cwd });
      await execa("git", ["tag", "v1", "main"], { cwd });
    });
    await turn(task.id);
    expect((await board.readProject("demo")).runner).toBe("a");
    expect(ran.map((each) => each.runner)).toEqual(["a", "a"]);
    const before = await refsOf(a.paths.repo("demo"));
    expect(Object.keys(before).toSorted()).toEqual([
      "refs/heads/agent/eng-1",
      "refs/heads/fix/typo",
      "refs/heads/main",
      `refs/heads/${branch}`,
      "refs/tags/v1",
    ]);

    const moved = await move({ runner: "b" });
    expect(moved.status).toBe(200);
    expect(ProjectMovedSchema.parse(moved.body)).toMatchObject({
      project: { slug: "demo", runner: "b" },
      carried: 5,
      released: { ok: true, detail: "a removed 2 worktree(s) and its clone" },
    });
    expect((await board.readProject("demo")).runner).toBe("b");
    const events = (await board.readEvents(null)).filter((event) => event.type === "project.moved");
    expect(events.map((event) => event.payload)).toEqual([
      { slug: "demo", from: "a", to: "b", carried: 5 },
    ]);

    // b holds every branch and tag at a's commits, follows the project's remote, and kept no header.
    const repo = b.paths.repo("demo");
    expect(await refsOf(repo)).toEqual(before);
    expect((await execa("git", ["remote", "get-url", "origin"], { cwd: repo })).stdout).toBe(
      origin,
    );
    const kept = await execa("git", ["config", "--get-regexp", "extraheader"], {
      cwd: repo,
      reject: false,
    });
    expect(kept.stdout).toBe("");
    // a's copy is gone, and so is the server's repository for the move.
    expect(await exists(a.paths.repo("demo"))).toBe(false);
    expect(await exists(a.paths.worktree("eng-1", "demo"))).toBe(false);
    expect(await exists(a.paths.taskWorktree("eng-1", task.id))).toBe(false);
    expect(await readdir(board.moveRepos).catch(() => [])).toEqual([]);

    // The task's next turn runs on b, on the branch a left, and its file reads answer from b.
    let found = "";
    script(async (cwd) => {
      found = await readFile(path.join(cwd, "work.txt"), "utf8");
    });
    await turn(task.id);
    expect(ran.at(-1)).toEqual({ runner: "b", cwd: b.paths.taskWorktree("eng-1", task.id) });
    expect(found).toBe("work\n");
    const changes = BranchChangesSchema.parse(await live.hub.branchChanges("demo", branch));
    expect(changes.files.map((file) => file.path)).toEqual(["work.txt"]);
    const file = await live.hub.readBranch("demo", branch, "work.txt");
    expect(file.kind === "file" ? Buffer.from(file.content ?? "", "base64").toString() : "").toBe(
      "work\n",
    );
  });

  it("carries the whole history of a project with no remote", async () => {
    const { board, ran, turn, move, runner, script } = await twoRunners("lab", null);
    script((cwd) => commit(cwd, "notes.md"));
    await turn();
    const a = runner("a");
    const before = await history(a.paths.repo("lab"));

    expect((await move({ runner: "b" })).status).toBe(200);
    const repo = runner("b").paths.repo("lab");
    expect(await history(repo)).toBe(before);
    expect((await execa("git", ["remote"], { cwd: repo })).stdout).toBe("");

    let found = "";
    script(async (cwd) => {
      found = await readFile(path.join(cwd, "notes.md"), "utf8");
    });
    await turn();
    expect(ran.at(-1)?.runner).toBe("b");
    expect(found).toBe("notes.md\n");
    expect(await history(repo)).toBe(before);
    expect((await board.readProject("lab")).runner).toBe("b");
  });

  it("refuses to move while a worktree holds work no branch does, and leaves everything where it was", async () => {
    const origin = await remote();
    const { board, move, turn, runner, script } = await twoRunners("demo", origin);
    script(async (cwd) => {
      await writeFile(path.join(cwd, "draft.md"), "not yet\n", "utf8");
    });
    await turn();
    const a = runner("a");
    const before = await refsOf(a.paths.repo("demo"));

    const refused = await move({ runner: "b" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: "INVALID_STATE",
      message: expect.stringContaining("eng-1, its own worktree: 1 uncommitted file(s)"),
    });
    expect((await board.readProject("demo")).runner).toBe("a");
    expect(await refsOf(a.paths.repo("demo"))).toEqual(before);
    await expect(
      readFile(path.join(a.paths.worktree("eng-1", "demo"), "draft.md"), "utf8"),
    ).resolves.toBe("not yet\n");
    expect(await exists(runner("b").paths.repo("demo"))).toBe(false);
    expect(await readdir(board.moveRepos).catch(() => [])).toEqual([]);
  });

  it("serves a move's repository to its old runner while it exports and its new one while it imports, and to nobody else", async () => {
    const { board, userToken } = await Board.init(path.join(dir, "data"), { name: "gate" });
    await board.addProject(USER, { slug: "demo" });
    await board.addProject(USER, { slug: "lab" });
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "Builds.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    const { token: engToken } = await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-1"),
      runTurn: () => Promise.resolve(completed("done")),
    };
    society = await startTestSociety({ board, backends: () => ({ claude: backend }) });
    const { app, hub, url } = society;
    // Runners played by the test through the protocol, so a move stops wherever it waits on one.
    const tokens: Record<string, string> = {};
    const sent: Record<string, RunnerMessage[]> = {};
    const detach: Record<string, () => Promise<void>> = {};
    const seat = async (name: string, hello: Partial<RunnerHelloInput> = {}) => {
      tokens[name] ??= (await board.addRunner(USER, name)).token;
      await hub.register(
        name,
        RunnerHelloSchema.parse({
          protocol: RUNNER_PROTOCOL,
          version: "test",
          os: "linux",
          clis: ["claude"],
          projectMoves: true,
          slots: null,
          ...hello,
        }),
      );
      sent[name] = [];
      detach[name] = await hub.attach(name, (message) => {
        sent[name]?.push(message);
        return true;
      });
    };
    await seat("x");
    await seat("y");
    await seat("z");
    await board.placeProject("demo", "x");
    await board.placeProject("lab", "x");
    const move = async (slug: string, body: object, token = userToken) => {
      const response = await app.request(`/api/projects/${slug}/runner`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const probe = async (token: string, id: string, service: string, rest = "/info/refs") =>
      (
        await fetch(`${url}/runner/moves/${id}/git${rest}?service=${service}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status;
    const request = async (name: string, type: RunnerMessage["type"]) =>
      vi.waitFor(
        () => {
          const found = sent[name]?.find((message) => message.type === type);
          if (found === undefined || found.type === "turn") {
            throw new Error(`no ${type} for ${name} yet`);
          }
          return found;
        },
        { timeout: 10_000 },
      );
    const tok = (name: string): string => tokens[name] ?? "";

    // Only the user moves a project, to a runner named as a runner is.
    expect(await move("demo", { runner: "y" }, engToken)).toMatchObject({
      status: 403,
      body: { message: "only the user may move a project to another runner" },
    });
    expect((await move("demo", { runner: "Not A Name" })).status).toBe(400);
    expect(sent["x"]).toEqual([]);

    // The move waits on x's export; meanwhile only x may push, the project's turns wait, and
    // no second move starts.
    const first = move("demo", { runner: "y" });
    const exporting = await request("x", "export");
    const id = exporting.type === "export" ? exporting.export.move : "";
    expect(await probe(tok("x"), id, "git-receive-pack")).toBe(200);
    expect(await probe(tok("x"), id, "git-upload-pack")).toBe(403);
    expect(await probe(tok("y"), id, "git-receive-pack")).toBe(403);
    expect(await probe(tok("y"), id, "git-upload-pack")).toBe(403);
    expect(await probe(tok("z"), id, "git-receive-pack")).toBe(403);
    expect(await probe(userToken, id, "git-upload-pack")).toBe(401);
    expect(await probe(tok("x"), "01ARZ3NDEKTSV4RRFFQ69G5FAV", "git-receive-pack")).toBe(404);
    expect(await probe(tok("x"), id, "", "/HEAD")).toBe(404);
    expect(
      await hub.assign(
        TurnDispatchSchema.parse({
          agent: "eng-1",
          project: "demo",
          trigger: { kind: "manual", fromUser: true, reason: "test" },
          priority: 1,
        }),
      ),
    ).toBeNull();
    expect(await move("lab", { runner: "y" })).toMatchObject({
      status: 409,
      body: { message: "a move of demo is under way; try again once it ends" },
    });
    hub.answer("x", exporting.request, {
      ok: true,
      value: { ok: true, refs: { "refs/heads/main": "a".repeat(40) }, bytes: 10 },
    });

    // Then only y may fetch; what y reports holding differs, so y lets it go and nothing moves.
    const importing = await request("y", "import");
    expect(await probe(tok("y"), id, "git-upload-pack")).toBe(200);
    expect(await probe(tok("y"), id, "git-receive-pack")).toBe(403);
    expect(await probe(tok("x"), id, "git-receive-pack")).toBe(403);
    hub.answer("y", importing.request, {
      ok: true,
      value: { refs: { "refs/heads/main": "b".repeat(40) } },
    });
    const released = await request("y", "release");
    hub.answer("y", released.request, { ok: true, value: { worktrees: 0, clone: true } });
    expect(await first).toMatchObject({
      status: 409,
      body: {
        message: expect.stringContaining("demo arrived on y unlike it left x (refs/heads/main)"),
      },
    });
    expect((await board.readProject("demo")).runner).toBe("x");
    expect(sent["x"]?.some((message) => message.type === "release")).toBe(false);
    expect(await probe(tok("x"), id, "git-receive-pack")).toBe(404);
    expect(await readdir(board.moveRepos)).toEqual([]);

    // Work no branch holds, reported by the old runner, refuses the move with who holds it.
    const second = move("demo", { runner: "y" });
    const held = await vi.waitFor(
      () => {
        const found = sent["x"]?.filter((message) => message.type === "export").at(1);
        if (found === undefined) {
          throw new Error("no second export yet");
        }
        return found;
      },
      { timeout: 10_000 },
    );
    hub.answer("x", held.request, {
      ok: true,
      value: {
        ok: false,
        held: [
          {
            agent: "eng-1",
            conversation: { kind: "thread", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
            uncommitted: 0,
            onNoBranch: 2,
          },
        ],
        bytes: 10,
      },
    });
    expect(await second).toMatchObject({
      status: 409,
      body: {
        message: expect.stringContaining(
          "eng-1, thread 01ARZ3NDEKTSV4RRFFQ69G5FAV: 2 commit(s) on no branch",
        ),
      },
    });

    // A runner that cannot take the project's turns, or either runner from before moves, refuses it.
    await seat("z", { clis: ["codex"], gitIdentityMissing: ["email"] });
    const train = await board.createTask(USER, {
      project: "demo",
      title: "train",
      required_capabilities: ["gpu"],
    });
    expect(await move("demo", { runner: "z" })).toMatchObject({
      status: 409,
      body: {
        message:
          "runner z cannot take demo: it lacks claude for eng-1; the capability gpu; a git email for citizens' commits",
      },
    });
    await seat("y", { projectMoves: false, capabilities: ["gpu"] });
    expect(await move("demo", { runner: "y" })).toMatchObject({
      status: 409,
      body: { message: "runner y cannot take a project yet; upgrade it" },
    });
    await seat("y", { capabilities: ["gpu"] });
    await seat("x", { projectMoves: false });
    expect(await move("demo", { runner: "y" })).toMatchObject({
      status: 409,
      body: { message: "runner x, where demo lives, cannot carry a project yet; upgrade it" },
    });
    await board.addRunner(USER, "v");
    expect(await move("demo", { runner: "v" })).toMatchObject({
      status: 409,
      body: { message: "runner v is not connected" },
    });

    // With x away nothing can travel: the move says what stays there, and goes ahead when told to.
    await detach["x"]?.();
    expect(await move("demo", { runner: "y", withoutBranches: false })).toMatchObject({
      status: 409,
      body: {
        error: "SOURCE_AWAY",
        message:
          "runner x, where demo lives, is not connected, so nothing can travel. Staying on x: its local branches and worktrees; its whole history, since demo has no remote (y would start an empty repository); the work of 1 task(s) in play (" +
          train.id +
          "). Move it without them to go ahead",
      },
    });
    const without = await move("demo", { runner: "y", withoutBranches: true });
    expect(without.status).toBe(200);
    expect(ProjectMovedSchema.parse(without.body)).toMatchObject({
      project: { runner: "y" },
      carried: null,
      released: null,
    });
    // Told so while the runner it lives on is connected, the move refuses to leave the branches.
    await seat("x", { capabilities: ["gpu"] });
    expect(await move("demo", { runner: "x", withoutBranches: true })).toMatchObject({
      status: 409,
      body: {
        message: "runner y, where demo lives, is connected, so the move carries its branches",
      },
    });
  });
});
