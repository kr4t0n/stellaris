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

describe("renaming a runner", () => {
  let dir: string;
  let society: TestSociety | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-rename-test-"));
  });

  afterEach(async () => {
    await society?.stop();
    society = null;
    await rm(dir, { recursive: true, force: true });
  });

  it("waits until nothing runs there, then the connected runner takes its next turn under the new name, resuming the session it began", async () => {
    const { board, userToken } = await Board.init(dir, { name: "renames" });
    await addWorkRoles(board);
    await board.addProject(USER, { slug: "lab" });
    const { token: engToken } = await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["lab"],
    });

    // Every turn says where it ran and on which session; one may be held open until the test
    // lets it end.
    const ran: Array<{ runner: string; session: string; newSession: boolean }> = [];
    let gate: PromiseWithResolvers<void> | null = null;
    let sessions = 0;
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve(`session-${sessions++}`),
      runTurn: async (request) => {
        ran.push({
          runner: request.spec.runner,
          session: request.session,
          newSession: request.newSession,
        });
        await gate?.promise;
        return {
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
      },
    };
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({ claude: backend }),
    });
    const { app, runner } = society;
    const dispatch = {
      agent: "eng-1",
      project: "lab",
      trigger: { kind: "manual" as const, fromUser: false, reason: "work" },
      priority: 1,
    };
    const rename = (to: string, token = userToken): Promise<Response> =>
      Promise.resolve(
        app.request("/api/runners/pod/name", {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ name: to }),
        }),
      );

    // The first turn places lab on pod and begins the conversation's session there.
    await society.run(dispatch);
    expect(ran).toEqual([{ runner: "pod", session: "session-0", newSession: true }]);
    expect(await board.readSessions("eng-1", "lab")).toEqual({
      claude: "session-0",
      runner: "pod",
    });

    // No one but the user renames a runner, and a name of another shape is refused in words.
    expect((await rename("gpu-1", engToken)).status).toBe(403);
    const malformed = await rename("GPU 1");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "VALIDATION",
      message:
        '"GPU 1" is no runner name: a name is 1 to 32 lowercase letters, digits, or hyphens, starting with a letter or digit',
    });

    // While a turn runs there, the rename is refused, saying to pause the runner, and changes nothing.
    gate = Promise.withResolvers<void>();
    const running = society.run(dispatch);
    await expect.poll(() => ran.length).toBe(2);
    const refused = await rename("gpu-1");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "INVALID_STATE",
      message:
        "runner pod cannot be renamed while 1 turn(s) run or start there; pause it, and rename it once that ends",
    });
    expect((await board.readRunner("pod")).name).toBe("pod");
    expect((await board.readProject("lab")).runner).toBe("pod");
    gate.resolve();
    gate = null;
    await running;

    // Idle, it is renamed with what names it, and the runner, still connected, learns its new
    // name from the server as it connects again.
    const renamed = await rename("gpu-1");
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      runner: { name: "gpu-1" },
      projects: ["lab"],
      agents: [],
      sessions: 1,
    });
    await expect.poll(() => runner.name).toBe("gpu-1");
    await expect.poll(() => society?.hub.connected).toEqual(["gpu-1"]);
    await expect.poll(async () => (await board.readRunner("gpu-1")).status).toBe("connected");
    await expect(board.readRunner("pod")).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The next turn runs on it under the new name and resumes the session begun as pod.
    const after = await society.run(dispatch);
    expect(after.exitReason).toBe("completed");
    expect(after.runner).toBe("gpu-1");
    expect(ran.at(-1)).toEqual({ runner: "gpu-1", session: "session-0", newSession: false });
    expect(await board.readSessions("eng-1", "lab")).toEqual({
      claude: "session-0",
      runner: "gpu-1",
    });
  });

  it("starts a warm session again under the new name, on the session it kept, and moves the citizen's pin", async () => {
    const { board, userToken } = await Board.init(dir, { name: "warm-renames" });
    await board.addAgent(USER, { name: "concierge-1", role: "concierge", cli: "claude" });
    // Each start of a warm CLI says on which runner and session; each turn runs on the warm one.
    const started: Array<{ runner: string; session: string; newSession: boolean }> = [];
    const closed: string[] = [];
    const tokens: string[] = [];
    let sessions = 0;
    const backend: AgentBackend = {
      kind: "claude",
      newSession: () => Promise.resolve(`session-${sessions++}`),
      runTurn: () => Promise.resolve(done),
      startResident: (spec, resident) => {
        tokens.push(resident.mcp.token);
        started.push({
          runner: spec.runner,
          session: resident.session,
          newSession: resident.newSession,
        });
        return Promise.resolve({
          session: resident.session,
          runTurn: () => Promise.resolve(done),
          close: () => {
            closed.push(`${spec.runner}:${resident.session}`);
            return Promise.resolve();
          },
        });
      },
    };
    society = await startTestSociety({
      board,
      runnerName: "pod",
      backends: () => ({ claude: backend }),
    });
    const dispatch = {
      agent: "concierge-1",
      project: "society",
      trigger: { kind: "manual" as const, fromUser: false, reason: "work" },
      priority: 1,
    };

    // The home's first turn pins the concierge to pod and starts its session warm; the next
    // runs on the warm one.
    await society.run(dispatch);
    await society.run(dispatch);
    expect(started).toEqual([{ runner: "pod", session: "session-0", newSession: true }]);
    expect((await board.readAgent("concierge-1")).homeRunner).toBe("pod");

    const renamed = await society.app.request("/api/runners/pod/name", {
      method: "PUT",
      headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "gpu-1" }),
    });
    expect(await renamed.json()).toMatchObject({ agents: ["concierge-1"], sessions: 1 });
    expect((await board.readAgent("concierge-1")).homeRunner).toBe("gpu-1");
    await expect.poll(() => society?.hub.connected).toEqual(["gpu-1"]);
    // The warm session's token goes at once, rather than when its idle time runs out.
    expect(board.resolveToken(tokens[0] ?? "")).toBeNull();

    // Its next turn has a new token, so the warm CLI, which stamps the name it started with,
    // starts again under the new name on the session it kept.
    const after = await society.run(dispatch);
    expect(after).toMatchObject({ exitReason: "completed", runner: "gpu-1", session: "session-0" });
    expect(closed).toEqual(["pod:session-0"]);
    expect(started.at(-1)).toEqual({ runner: "gpu-1", session: "session-0", newSession: false });
  });

  it("gives back a placement that a rename overtook, so a pinned citizen's session stays on the renamed runner", async () => {
    const { board, userToken } = await Board.init(dir, { name: "overtaken" });
    await addWorkRoles(board);
    await board.addAgent(USER, { name: "eng-1", role: "engineer", cli: "claude" });
    const ran: Array<{ runner: string; session: string; newSession: boolean }> = [];
    let sessions = 0;
    const backend = (): AgentBackend => ({
      kind: "claude",
      newSession: () => Promise.resolve(`session-${sessions++}`),
      runTurn: (request) => {
        ran.push({
          runner: request.spec.runner,
          session: request.session,
          newSession: request.newSession,
        });
        return Promise.resolve(done);
      },
    });
    // A runner away past 50 ms has its pinned citizens' turns detour to another.
    society = await startTestSociety({
      board,
      runnerName: "pod",
      graceMs: 50,
      backends: () => ({ claude: backend() }),
      extraRunners: [{ name: "far", backends: () => ({ claude: backend() }) }],
    });
    const { app, hub } = society;
    await board.pinAgent("eng-1", "pod");
    const dispatch = TurnDispatchSchema.parse({
      agent: "eng-1",
      project: "society",
      trigger: { kind: "manual", fromUser: false, reason: "work" },
      priority: 1,
    });
    await society.run(dispatch);
    expect(ran).toEqual([{ runner: "pod", session: "session-0", newSession: true }]);

    // A placement reads the citizen pinned to pod, then the rename runs and ends before it goes
    // on: pod has no seat any more, as if away, and only the rename's count gives the turn back,
    // where it would have detoured to far and begun the conversation afresh there.
    const read = board.readAgent.bind(board);
    const { promise: reading, resolve: inside } = Promise.withResolvers<void>();
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    vi.spyOn(board, "readAgent").mockImplementationOnce(async (name) => {
      const agent = await read(name);
      inside();
      await gate;
      return agent;
    });
    const during = hub.assign(dispatch);
    await reading;
    const renamed = await app.request("/api/runners/pod/name", {
      method: "PUT",
      headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "gpu-1" }),
    });
    expect(renamed.status).toBe(200);
    open();
    expect(await during).toBeNull();

    // Once the runner is back under its new name, the turn goes there and resumes the session.
    await expect.poll(() => hub.connected).toEqual(["far", "gpu-1"]);
    await society.run(dispatch);
    expect(ran.at(-1)).toEqual({ runner: "gpu-1", session: "session-0", newSession: false });
    expect(await board.readSessions("eng-1", "society")).toEqual({
      claude: "session-0",
      runner: "gpu-1",
    });
  });

  it("asks nothing of the runner while it is renamed, and waits for a request or a move to end first", async () => {
    const { board, userToken } = await Board.init(dir, { name: "holds" });
    await addWorkRoles(board);
    await board.addProject(USER, { slug: "lab" });
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["lab"],
    });
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
    await board.placeProject("lab", "pod");
    const rename = async (to: string): Promise<{ status: number; message: unknown }> => {
      const answer = await app.request("/api/runners/pod/name", {
        method: "PUT",
        headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name: to }),
      });
      const body: unknown = await answer.json();
      return {
        status: answer.status,
        message:
          typeof body === "object" && body !== null && "message" in body ? body.message : null,
      };
    };

    // A request to pod that waits for its answer holds the rename back.
    const models = hub.models("claude", "pod");
    await asked.promise;
    expect(await rename("gpu-1")).toEqual({
      status: 409,
      message:
        "runner pod cannot be renamed while 1 request(s) to it, such as a landing, wait for an answer; pause it, and rename it once that ends",
    });
    listing.resolve([]);
    expect(await models).toEqual([]);

    // So does a project move under way.
    const { promise: checking, resolve: inside } = Promise.withResolvers<void>();
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    vi.spyOn(board, "prepareProjectMove").mockImplementationOnce(async () => {
      inside();
      await gate;
      throw new BoardError("INVALID_STATE", "the test ends this move");
    });
    const moving = hub.moveProject(USER, "lab", "far");
    await checking;
    expect(await rename("gpu-1")).toEqual({
      status: 409,
      message:
        "runner pod cannot be renamed while a move of lab is under way; pause it, and rename it once that ends",
    });
    open();
    await expect(moving).rejects.toThrow("the test ends this move");

    // While the rename runs, pod is offered no turn, asked nothing, and no move starts; a second
    // rename of it waits for the first.
    const real = board.renameRunner.bind(board);
    const { promise: renaming, resolve: started } = Promise.withResolvers<void>();
    const { promise: release, resolve: finish } = Promise.withResolvers<void>();
    vi.spyOn(board, "renameRunner").mockImplementationOnce(async (actor, from, to) => {
      started();
      await release;
      return real(actor, from, to);
    });
    const first = rename("gpu-1");
    await renaming;
    expect(
      await hub.assign(
        TurnDispatchSchema.parse({
          agent: "eng-1",
          project: "lab",
          trigger: { kind: "manual", fromUser: false, reason: "work" },
          priority: 1,
        }),
      ),
    ).toBeNull();
    await expect(hub.models("claude", "pod")).rejects.toThrow("runner pod is being renamed");
    await expect(hub.moveProject(USER, "lab", "far")).rejects.toThrow(
      "runner pod is being renamed; try again once that ends",
    );
    expect(await rename("gpu-2")).toEqual({
      status: 409,
      message: "runner pod is being renamed already; try again once that ends",
    });
    finish();
    expect((await first).status).toBe(200);
    expect((await board.readProject("lab")).runner).toBe("gpu-1");
  });
});
