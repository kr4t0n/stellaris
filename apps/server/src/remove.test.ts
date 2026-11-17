import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board, BoardError } from "@stellaris/board-core";
import { ZERO_USAGE, type AgentBackend, type TurnResult } from "@stellaris/runner-core";
import { TurnDispatchSchema, type ModelOption } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestSociety, type TestSociety } from "./testing/harness.js";
import { addWorkRoles, USER } from "./testing/scripted-backend.js";

/** A turn that ends at once, done. */
const done: TurnResult = {
  events: [],
  finalText: "done",
  usage: ZERO_USAGE,
  costUsd: 0,
  status: {
    summary: "done",
    claimsHeld: [],
    blockedOn: [],
    needsUserDecision: false,
    memoryUpdated: false,
  },
  exitReason: "completed",
};

/** What the server answered a request: its status and, for a refusal, its words. */
async function answered(response: Response): Promise<{ status: number; message: unknown }> {
  const body: unknown = await response.json();
  return {
    status: response.status,
    message: typeof body === "object" && body !== null && "message" in body ? body.message : null,
  };
}

describe("removing a runner", () => {
  let dir: string;
  let society: TestSociety | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-remove-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await society?.stop();
    society = null;
    await rm(dir, { recursive: true, force: true });
  });

  it("waits until it is paused, nothing runs there and no project lives there, then refuses its token and pins its citizen again elsewhere", async () => {
    const { board, userToken } = await Board.init(dir, { name: "removals" });
    await addWorkRoles(board);
    await board.addProject(USER, { slug: "lab" });
    const { token: engToken } = await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["lab"],
    });
    await board.addAgent(USER, { name: "concierge-1", role: "concierge", cli: "claude" });
    // Each runner's token, as the harness registers it.
    const tokens = new Map<string, string>();
    const add = board.addRunner.bind(board);
    vi.spyOn(board, "addRunner").mockImplementation(async (actor, name, enrolled) => {
      const added = await add(actor, name, enrolled);
      tokens.set(added.runner.name, added.token);
      return added;
    });
    // What the server answers each of pod's registrations.
    const hellos: number[] = [];
    const counting: typeof fetch = async (input, init) => {
      const answer = await fetch(input, init);
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/runner/hello") {
        hellos.push(answer.status);
      }
      return answer;
    };
    // Each start of a warm CLI says on which runner and session, with the turn's token; a turn
    // may be held open until the test lets it end.
    const started: Array<{ runner: string; session: string; newSession: boolean }> = [];
    const warmTokens: string[] = [];
    let gate: PromiseWithResolvers<void> | null = null;
    let turns = 0;
    const prompts: string[] = [];
    let sessions = 0;
    const backend = (): AgentBackend => ({
      kind: "claude",
      newSession: () => Promise.resolve(`session-${sessions++}`),
      runTurn: () => Promise.resolve(done),
      startResident: (spec, resident) => {
        warmTokens.push(resident.mcp.token);
        started.push({
          runner: spec.runner,
          session: resident.session,
          newSession: resident.newSession,
        });
        return Promise.resolve({
          session: resident.session,
          runTurn: async (prompt) => {
            prompts.push(prompt);
            turns += 1;
            await gate?.promise;
            return done;
          },
          close: () => Promise.resolve(),
        });
      },
    });
    society = await startTestSociety({
      board,
      runnerName: "pod",
      fetch: counting,
      backends: () => ({ claude: backend() }),
      extraRunners: [{ name: "far", backends: () => ({ claude: backend() }) }],
    });
    const { app, hub } = society;
    await board.placeProject("lab", "pod");
    await board.pinAgent("concierge-1", "pod");
    const dispatch = {
      agent: "concierge-1",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: false, reason: "work" },
      priority: 1,
    };
    const remove = async (runner = "pod", token = userToken) =>
      answered(
        await app.request(`/api/runners/${runner}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        }),
      );

    // The concierge's home begins its session warm on pod.
    await society.run(dispatch);
    expect(started).toEqual([{ runner: "pod", session: "session-0", newSession: true }]);
    expect(await board.readSessions("concierge-1", "society")).toEqual({
      claude: "session-0",
      runner: "pod",
    });

    // No one but the user removes a runner, and only one the board knows.
    expect(await remove("pod", engToken)).toEqual({
      status: 403,
      message: "only the user may remove a runner",
    });
    expect(await remove("ghost")).toEqual({ status: 404, message: "runner ghost not found" });
    // Connected and not paused, it may be given a turn at any moment.
    expect(await remove()).toEqual({
      status: 409,
      message: "runner pod cannot be removed while it is connected and not paused; pause it first",
    });

    // Paused while a turn runs there, it waits for the turn.
    gate = Promise.withResolvers<void>();
    const running = society.run(dispatch);
    await expect.poll(() => turns).toBe(2);
    await board.setRunnerPaused(USER, "pod", { paused: true });
    expect(await remove()).toEqual({
      status: 409,
      message:
        "runner pod cannot be removed while 1 turn(s) run or start there; pause it, and remove it once that ends",
    });
    gate.resolve();
    gate = null;
    expect((await running).runner).toBe("pod");

    // Idle and paused, it still holds lab's repository, which the board refuses to lose.
    expect(await remove()).toEqual({
      status: 409,
      message:
        "runner pod cannot be removed while lab lives there; move it to another runner first",
    });
    expect((await board.readRunner("pod")).name).toBe("pod");
    expect((await board.readAgent("concierge-1")).homeRunner).toBe("pod");
    expect(hub.connected).toEqual(["far", "pod"]);

    // Once lab is archived, it goes, with the pin and the session that named it.
    await board.archiveProject(USER, { project: "lab", reason: "done" });
    const asked = hellos.length;
    const removed = await app.request("/api/runners/pod", {
      method: "DELETE",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      name: "pod",
      projects: ["lab"],
      agents: ["concierge-1"],
      sessions: 1,
    });
    await expect(board.readRunner("pod")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await board.readProject("lab")).runner).toBeUndefined();
    expect((await board.readAgent("concierge-1")).homeRunner).toBeUndefined();
    expect(await board.readSessions("concierge-1", "society")).toEqual({ runner: "pod" });
    expect(hub.connected).toEqual(["far"]);
    // The warm session's token goes with it.
    expect(warmTokens).toHaveLength(1);
    expect(board.resolveToken(warmTokens[0] ?? "")).toBeNull();

    // pod's stream ended, and the server refuses its token: still running, it asks again and is
    // refused each time, until its process is stopped.
    await expect
      .poll(() => hellos.slice(asked).length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(3);
    expect(new Set(hellos.slice(asked))).toEqual(new Set([401]));
    const refused = await fetch(`${society.url}/runner/hello`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.get("pod") ?? ""}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(refused.status).toBe(401);
    expect(hub.connected).toEqual(["far"]);
    expect((await board.listRunners()).map((runner) => runner.name)).toEqual(["far"]);

    // The concierge's next turn runs on far, which pins it, afresh: its record still names pod, so
    // the turn is told its session started afresh, not given the first-turn notes.
    const after = await society.run(dispatch);
    expect(after).toMatchObject({ exitReason: "completed", runner: "far" });
    expect(started.at(-1)).toEqual({ runner: "far", session: "session-1", newSession: true });
    expect(prompts.at(-1)).toContain("## Your session started afresh");
    expect(prompts.at(-1)).not.toContain("## First turn");
    expect((await board.readAgent("concierge-1")).homeRunner).toBe("far");
  });

  it("asks nothing of the runner while it is removed, and waits for a request, a move, or a rename to end first", async () => {
    const { board, userToken } = await Board.init(dir, { name: "holds" });
    await addWorkRoles(board);
    await board.addProject(USER, { slug: "lab" });
    // pod's model list answers only when the test lets it, and says when it was asked.
    const asked = Promise.withResolvers<void>();
    const listing = Promise.withResolvers<ModelOption[]>();
    const backend = (): AgentBackend => ({
      kind: "claude",
      newSession: () => Promise.resolve("session-0"),
      runTurn: () => Promise.resolve(done),
      listModels: () => {
        asked.resolve();
        return listing.promise;
      },
    });
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({ claude: backend() }),
      extraRunners: [{ name: "far", backends: () => ({ claude: backend() }) }],
    });
    const { app, hub } = society;
    await board.placeProject("lab", "far");
    await board.setRunnerPaused(USER, "pod", { paused: true });
    const remove = async () =>
      answered(
        await app.request("/api/runners/pod", {
          method: "DELETE",
          headers: { authorization: `Bearer ${userToken}` },
        }),
      );
    const rename = async (to: string) =>
      answered(
        await app.request("/api/runners/pod/name", {
          method: "PUT",
          headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
          body: JSON.stringify({ name: to }),
        }),
      );

    // A request to pod that waits for its answer holds the removal back, paused as it is.
    const models = hub.models("claude", "pod");
    await asked.promise;
    expect(await remove()).toEqual({
      status: 409,
      message:
        "runner pod cannot be removed while 1 request(s) to it, such as a landing, wait for an answer; pause it, and remove it once that ends",
    });
    listing.resolve([]);
    expect(await models).toEqual([]);

    // So does a project move under way, wherever it goes.
    const { promise: checking, resolve: inside } = Promise.withResolvers<void>();
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    vi.spyOn(board, "prepareProjectMove").mockImplementationOnce(async () => {
      inside();
      await gate;
      throw new BoardError("INVALID_STATE", "the test ends this move");
    });
    const moving = hub.moveProject(USER, "lab", "pod");
    await checking;
    expect(await remove()).toEqual({
      status: 409,
      message:
        "runner pod cannot be removed while a move of lab is under way; pause it, and remove it once that ends",
    });
    open();
    await expect(moving).rejects.toThrow("the test ends this move");

    // And a rename of it under way, which this one ends without renaming it.
    const { promise: renaming, resolve: renameStarted } = Promise.withResolvers<void>();
    const { promise: renameGate, resolve: endRename } = Promise.withResolvers<void>();
    vi.spyOn(board, "renameRunner").mockImplementationOnce(async () => {
      renameStarted();
      await renameGate;
      throw new BoardError("INVALID_STATE", "the test ends this rename");
    });
    const renamed = rename("gpu-1");
    await renaming;
    expect(await remove()).toEqual({
      status: 409,
      message: "runner pod is being renamed; try again once that ends",
    });
    endRename();
    expect(await renamed).toEqual({ status: 409, message: "the test ends this rename" });

    // While the removal runs, pod is asked nothing and no move starts; a second removal of it, or
    // a rename, waits for the first.
    const real = board.removeRunner.bind(board);
    const { promise: removing, resolve: started } = Promise.withResolvers<void>();
    const { promise: release, resolve: finish } = Promise.withResolvers<void>();
    vi.spyOn(board, "removeRunner").mockImplementationOnce(async (actor, name) => {
      started();
      await release;
      return real(actor, name);
    });
    const first = remove();
    await removing;
    await expect(hub.models("claude", "pod")).rejects.toThrow("runner pod is being removed");
    await expect(hub.moveProject(USER, "lab", "pod")).rejects.toThrow(
      "runner pod is being removed; try again once that ends",
    );
    expect(await remove()).toEqual({
      status: 409,
      message: "runner pod is being removed already; try again once that ends",
    });
    expect(await rename("gpu-1")).toEqual({
      status: 409,
      message: "runner pod is being removed; try again once that ends",
    });
    finish();
    expect((await first).status).toBe(200);
    expect(hub.connected).toEqual(["far"]);
    await expect(hub.models("claude", "pod")).rejects.toThrow(
      "runner pod is not connected with claude",
    );
    await expect(board.readRunner("pod")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("gives back a placement that a removal overtook once it had pinned the citizen there", async () => {
    const { board, userToken } = await Board.init(dir, { name: "overtaken" });
    await addWorkRoles(board);
    await board.addAgent(USER, { name: "eng-1", role: "engineer", cli: "claude" });
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve("session-0"),
      runTurn: () => Promise.resolve(done),
    };
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({ claude: backend }),
    });
    const { app, hub } = society;

    // A placement finds pod free, unpaused, for a citizen not pinned yet, and pins it there; then
    // the user pauses pod and removes it before the placement goes on. Only the removal's count
    // gives the turn back, where it would have gone to a seat the hub has let go.
    const real = board.pinAgent.bind(board);
    const { promise: pinning, resolve: pinned } = Promise.withResolvers<void>();
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    vi.spyOn(board, "pinAgent").mockImplementationOnce(async (name, runner, from) => {
      const home = await real(name, runner, from);
      pinned();
      await gate;
      return home;
    });
    const during = hub.assign(
      TurnDispatchSchema.parse({
        agent: "eng-1",
        project: "society",
        trigger: { kind: "manual", fromUser: false, reason: "work" },
        priority: 1,
      }),
    );
    await pinning;
    expect((await board.readAgent("eng-1")).homeRunner).toBe("pod");
    await board.setRunnerPaused(USER, "pod", { paused: true });
    const removed = await app.request("/api/runners/pod", {
      method: "DELETE",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(await removed.json()).toMatchObject({ name: "pod", agents: ["eng-1"] });
    open();
    expect(await during).toBeNull();
    expect((await board.readAgent("eng-1")).homeRunner).toBeUndefined();
    expect(hub.connected).toEqual([]);
  });
});
