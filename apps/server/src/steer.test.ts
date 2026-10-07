import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import {
  ZERO_USAGE,
  type AgentBackend,
  type TurnControl,
  type TurnRequest,
  type TurnResult,
} from "@stellaris/runner-core";
import { Scheduler } from "@stellaris/scheduler";
import { MEMBER_VERBS, type AgentEvent, type BoardEvent } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestSociety, type TestSociety } from "./testing/harness.js";

const USER = { name: "user", role: "user" } as const;

function finished(summary: string): TurnResult {
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

/**
 * A CLI whose turns asked to "hold on" keep running until the test releases them, taking every
 * steer it is handed as the real CLIs do, and ending at once when stopped. Other turns end at once.
 */
class HeldBackend implements AgentBackend {
  readonly kind = "claude" as const;
  readonly stops = true;
  readonly prompts: string[] = [];
  readonly steers: boolean;
  /** What each steer delivered, in order. */
  readonly delivered: string[] = [];
  private held: { release: () => void; running: PromiseWithResolvers<void> } | null = null;
  private running = Promise.withResolvers<void>();

  constructor(steers: boolean) {
    this.steers = steers;
  }

  newSession(): Promise<string> {
    return Promise.resolve(randomUUID());
  }

  /** Resolves once a held turn is running. */
  whenHeld(): Promise<void> {
    return this.running.promise;
  }

  release(): void {
    this.held?.release();
  }

  async runTurn(
    request: TurnRequest,
    onEvent?: (event: AgentEvent) => void,
    control?: TurnControl,
  ): Promise<TurnResult> {
    this.prompts.push(request.prompt);
    if (!request.prompt.includes("hold on")) {
      return finished("nothing to do");
    }
    const ended = Promise.withResolvers<"released" | "stopped">();
    const detach = control?.attach({
      ...(this.steers
        ? {
            steer: (steer) => {
              this.delivered.push(steer.text);
              onEvent?.({ type: "steered", steer: steer.id });
              return Promise.resolve(true);
            },
          }
        : {}),
      stop: () => ended.resolve("stopped"),
    });
    this.held = { release: () => ended.resolve("released"), running: this.running };
    this.running.resolve();
    const how = await ended.promise;
    detach?.();
    this.running = Promise.withResolvers<void>();
    return how === "stopped"
      ? { ...finished("stopped"), status: null, exitReason: "interrupted" }
      : finished("worked through it");
  }
}

async function eventsOf(board: Board, type: string): Promise<BoardEvent[]> {
  return (await board.readEvents(null, 10_000)).filter((event) => event.type === type);
}

describe("steering and stopping a turn in flight", () => {
  let dir: string;
  let society: TestSociety | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-steer-"));
  });

  afterEach(async () => {
    await society?.stop();
    society = null;
    await rm(dir, { recursive: true, force: true });
  });

  async function setup(steers: boolean) {
    const { board, userToken } = await Board.init(dir, { name: "steer" });
    await board.addProject(USER, { slug: "demo" });
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
      memberships: ["demo"],
    });
    const backend = new HeldBackend(steers);
    society = await startTestSociety({ board, backends: () => ({ claude: backend }) });
    const scheduler = new Scheduler({
      board,
      runner: society.hub,
      timings: {
        debounceMs: 0,
        userDebounceMs: 0,
        heartbeatMs: 3_600_000,
        waitingStageMs: 3_600_000,
      },
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };
    await settle(); // the onboarding turn
    return { board, userToken, backend, scheduler, settle, society };
  }

  it("delivers a post into the turn running in its conversation, and runs no turn for it after", async () => {
    const { board, backend, scheduler, settle } = await setup(true);
    await board.postMessage(USER, {
      channel: "demo/general",
      body: "@eng-1 hold on, start the build",
    });
    await scheduler.tick();
    await backend.whenHeld();

    const followUp = await board.postMessage(USER, {
      channel: "demo/general",
      body: "@eng-1 also add a test for it",
    });
    await scheduler.tick();
    await vi.waitFor(() => expect(backend.delivered).toHaveLength(1));
    expect(backend.delivered[0]).toContain("## New in this conversation while you work (1)");
    expect(backend.delivered[0]).toContain("also add a test for it");
    expect(backend.delivered[0]).toContain(`(message ${followUp.id})`);
    // The board learns the CLI took it from the turn's steps.
    await vi.waitFor(async () =>
      expect((await eventsOf(board, "turn.steered")).map((event) => event.payload)).toEqual([
        expect.objectContaining({ project: "demo", messages: [followUp.id] }),
      ]),
    );

    backend.release();
    await scheduler.drain();
    await settle();
    await settle();
    // The onboarding turn and the held one: the post needed no turn of its own.
    expect(backend.prompts).toHaveLength(2);
    expect(await board.digestCursor("eng-1", "demo")).toBe(followUp.id);
    const [turn] = (await board.listTurns("eng-1")).slice(-1);
    const transcript = await board.readTranscript("eng-1", turn?.turnId ?? "");
    expect(transcript.map((entry) => entry.event)).toContainEqual({
      type: "steered",
      steer: expect.any(String),
      messages: [followUp.id],
      text: expect.stringContaining("also add a test for it"),
    });
  });

  it("leaves a post its runner cannot steer to a turn of its own once the running one ends", async () => {
    const { board, backend, scheduler, settle } = await setup(false);
    await board.postMessage(USER, {
      channel: "demo/general",
      body: "@eng-1 hold on, start the build",
    });
    await scheduler.tick();
    await backend.whenHeld();
    await board.postMessage(USER, {
      channel: "demo/general",
      body: "@eng-1 also add a test for it",
    });
    await scheduler.tick();
    expect(backend.delivered).toEqual([]);

    backend.release();
    await scheduler.drain();
    await settle();
    expect(backend.prompts).toHaveLength(3);
    expect(backend.prompts[2]).toContain("also add a test for it");
    expect(await eventsOf(board, "turn.steered")).toEqual([]);
  });

  it("stops a turn the user asks to stop, counts what it was shown as read, and tells the next turn", async () => {
    const { board, userToken, backend, scheduler, settle, society: running } = await setup(true);
    const ask = await board.postMessage(USER, {
      channel: "demo/general",
      body: "@eng-1 hold on, start the build",
    });
    await scheduler.tick();
    await backend.whenHeld();
    const [turn] = running.hub.liveTurns();
    expect(turn).toMatchObject({ agent: "eng-1", scope: "demo", steerable: true, stoppable: true });

    const headers = { authorization: `Bearer ${userToken}`, "content-type": "application/json" };
    const refused = await running.app.request(`/api/turns/${turn?.turnId}/stop`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer nobody" },
    });
    expect(refused.status).toBe(401);
    const stopped = await running.app.request(`/api/turns/${turn?.turnId}/stop`, {
      method: "POST",
      headers,
    });
    expect(stopped.status).toBe(200);
    await scheduler.drain();

    const record = await board.readLastTurn("eng-1", "demo");
    expect(record).toMatchObject({ exitReason: "stopped", stoppedBy: "user", error: null });
    expect((await eventsOf(board, "turn.stopped")).map((event) => event.actor)).toEqual(["user"]);
    // What the turn was shown is read: nothing wakes the citizen to do it again.
    expect(await board.digestCursor("eng-1", "demo")).toBe(ask.id);
    expect(await board.unreadByConversation({ name: "eng-1", role: "engineer" })).toEqual([]);

    await board.requestWake(USER, { agent: "eng-1", project: "demo", reason: "carry on" });
    await settle();
    expect(backend.prompts.at(-1)).toContain("## The user stopped your previous turn");
    // A turn no longer in flight cannot be stopped.
    const again = await running.app.request(`/api/turns/${turn?.turnId}/stop`, {
      method: "POST",
      headers,
    });
    expect(again.status).toBe(404);
  });
});
