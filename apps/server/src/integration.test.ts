import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import {
  LocalRunner,
  ZERO_USAGE,
  type AgentBackend,
  type TurnRequest,
  type TurnResult,
} from "@stellaris/runner-core";
import { Scheduler } from "@stellaris/scheduler";
import { execa } from "execa";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const OWNER = { name: "owner", role: "owner" } as const;
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;

function done(summary: string): TurnResult {
  return {
    events: [{ type: "tool_call", name: "mcp__board__post_message", input: {} }],
    finalText: summary,
    usage: ZERO_USAGE,
    costUsd: 0.01,
    status: {
      summary,
      claimsHeld: [],
      blockedOn: [],
      needsOwnerDecision: false,
      memoryUpdated: false,
    },
    exitReason: "completed",
  };
}

/**
 * A scripted stand-in for a CLI agent. It reads the prompt like an agent would, acts through the
 * HTTP verbs with the turn token it was handed, and edits code in its worktree with git.
 * The real adapters replace it; everything around it is the production path.
 */
class ScriptedBackend implements AgentBackend {
  readonly kind = "claude" as const;
  readonly prompts: string[] = [];

  constructor(
    private readonly app: Hono<{ Variables: { actor: { name: string; role: string } } }>,
  ) {}

  newSession(): Promise<string> {
    return Promise.resolve(`session-${this.prompts.length + 1}`);
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    this.prompts.push(request.prompt);
    const verb = async (name: string, input: unknown): Promise<unknown> => {
      const response = await this.app.request(`/api/verbs/${name}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${request.mcp.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(`${name} failed: ${JSON.stringify(body)}`);
      }
      return body;
    };

    // A claim event names the task; a mention carries it in the message body.
    const taskId =
      /Task in question: ([0-9A-HJKMNP-TV-Z]{26})/.exec(request.prompt)?.[1] ??
      /take task ([0-9A-HJKMNP-TV-Z]{26})/.exec(request.prompt)?.[1];
    if (taskId === undefined || !ULID.test(taskId)) {
      return done("nothing to do");
    }

    if (request.spec.agent === "eng-1") {
      if (request.prompt.includes("task approved")) {
        await verb("close_thread", { thread_id: taskId, summary: "Shipped hello.txt." });
        return done("closed the thread");
      }
      await verb("claim_task", { task_id: taskId });
      await writeFile(path.join(request.spec.cwd, "hello.txt"), "hello from eng-1\n", "utf8");
      const git = (...args: string[]) =>
        execa("git", args, { cwd: request.spec.cwd, env: { ...process.env, ...request.env } });
      await git("add", "hello.txt");
      await git("commit", "-m", "feat: add hello.txt");
      await verb("open_thread", { task_id: taskId });
      await verb("post_message", {
        channel: "demo/general",
        body: "Committed hello.txt on my branch.",
        thread_id: taskId,
      });
      await verb("update_task", { task_id: taskId, status: "in_review", note: "ready for review" });
      return done("submitted hello.txt for review");
    }

    if (request.spec.agent === "rev-1") {
      const log = await execa("git", ["log", "--oneline", "agent/eng-1"], {
        cwd: request.spec.cwd,
      });
      if (!log.stdout.includes("feat: add hello.txt")) {
        throw new Error("reviewer cannot see the engineer's commit");
      }
      await verb("update_task", {
        task_id: taskId,
        status: "done",
        note: "reviewed the diff, tests not required for a text file",
      });
      return done("approved");
    }
    return done("no script");
  }
}

describe("Phase 1 exit criterion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-e2e-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("two agents complete a task end to end with a reviewed merge, with the owner participating by mention", async () => {
    const { board } = await Board.init(dir, { name: "e2e" });
    await board.addProject(OWNER, { slug: "demo" });
    await board.addAgent(OWNER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    await board.addAgent(OWNER, {
      name: "rev-1",
      role: "reviewer",
      cli: "claude",
      memberships: ["demo"],
    });

    const app = createApp({ board, version: "test" });
    const backend = new ScriptedBackend(app);
    const runner = new LocalRunner({
      board,
      backends: { claude: backend },
      mcpUrl: "http://127.0.0.1:0/mcp",
    });
    const scheduler = new Scheduler({
      board,
      runner,
      timings: {
        debounceMs: 0,
        ownerDebounceMs: 0,
        heartbeatMs: 3_600_000,
        unclaimedTaskMs: 3_600_000,
      },
    });
    const settle = async (): Promise<void> => {
      await scheduler.tick();
      await scheduler.drain();
    };

    // Onboarding turns for both members fire from the agent.added events.
    await settle();
    expect(backend.prompts.filter((p) => p.includes("This is your first turn")).length).toBe(2);

    const task = await board.createTask(OWNER, {
      project: "demo",
      title: "Add hello.txt",
      body: "One file, one line.",
    });
    const mention = await board.postMessage(OWNER, {
      channel: "demo/general",
      body: `@eng-1 please take task ${task.id}: add hello.txt with a greeting.`,
    });

    await settle(); // eng-1: claim, commit, submit for review
    expect((await board.getTask(OWNER, { task_id: task.id })).status).toBe("in_review");
    await settle(); // rev-1: review and approve
    expect((await board.getTask(OWNER, { task_id: task.id })).status).toBe("done");
    await settle(); // merge lands and eng-1 closes the thread
    await settle();

    const final = await board.getTask(OWNER, { task_id: task.id });
    expect(final.thread).toBe("closed");

    const mainLog = await execa("git", ["log", "--oneline", "main"], {
      cwd: board.paths.repo("demo"),
    });
    expect(mainLog.stdout).toContain("feat: add hello.txt");
    expect(mainLog.stdout).toContain("merge: land agent/eng-1 on main");
    expect(await readFile(path.join(board.paths.repo("demo"), "hello.txt"), "utf8")).toBe(
      "hello from eng-1\n",
    );

    const general = await board.listChannel("demo/general");
    expect(general.some((m) => m.author === "board" && m.body.includes("Merged agent/eng-1"))).toBe(
      true,
    );
    expect(general.some((m) => m.author === "eng-1" && m.body.includes("Thread closed"))).toBe(
      true,
    );

    const types = (await board.readEvents(null)).map((e) => e.type);
    expect(types.filter((t) => t === "turn.completed").length).toBeGreaterThanOrEqual(5);
    expect(types).toContain("merge.completed");
    expect(types).not.toContain("turn.failed");

    const last = await board.readLastTurn("eng-1", "demo");
    expect(last?.exitReason).toBe("completed");
    expect(last?.status?.summary).toBe("closed the thread");
    const rendered = await readFile(
      path.join(board.paths.agent("eng-1"), ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(rendered).toContain("## Role");
    expect(rendered).toContain(board.paths.board);
    // The owner's mention was delivered in a completed turn, so the cursor has moved past it.
    const unread = await board.readInbox({ name: "eng-1", role: "engineer" }, { advance: false });
    expect(unread.messages.map((m) => m.id)).not.toContain(mention.id);
  });
});
