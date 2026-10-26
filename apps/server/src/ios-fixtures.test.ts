import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { BoardEventSchema, ULID_PATTERN } from "@stellaris/shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startTestSociety, type TestSociety } from "./testing/harness.js";
import { addWorkRoles, USER } from "./testing/scripted-backend.js";

/**
 * The answers the iOS client reads, captured from a real server into `apps/ios/fixtures/api`,
 * where BoardKit's tests decode every one and rebuild every request. A change to any answer fails
 * here until the fixtures are captured again with `-u`, which in turn runs the iOS workflow.
 */

const ENGINEER = { name: "eng-1", role: "engineer" } as const;
const REVIEWER = { name: "rev-1", role: "reviewer" } as const;
const CONCIERGE = { name: "concierge-1", role: "concierge" } as const;

const ULIDS = new RegExp(ULID_PATTERN.source.slice(1, -1), "g");
const TIMES = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** Every time in a fixture: a capture's times depend on how fast it ran. */
const TIME = "2026-01-01T00:00:00.000Z";

const IdSchema = z.object({ id: z.string() });
const TaskRowSchema = z.object({ id: z.string(), title: z.string() });
const ProposalRowSchema = z.object({ id: z.string(), kind: z.string() });

/**
 * Ids and times as a fixture shows them. Each id becomes a placeholder numbered in the order the
 * capture first met it, the same in every fixture, so a request names what an earlier answer gave.
 */
class Normaliser {
  private readonly ids = new Map<string, string>();

  text(raw: string): string {
    return raw
      .replace(ULIDS, (id) => {
        let placeholder = this.ids.get(id);
        if (placeholder === undefined) {
          placeholder = String(this.ids.size + 1).padStart(26, "0");
          this.ids.set(id, placeholder);
        }
        return placeholder;
      })
      .replace(TIMES, TIME);
  }

  json(value: unknown): unknown {
    return JSON.parse(this.text(JSON.stringify(value)));
  }
}

interface Capture {
  readonly request: unknown;
  readonly status: number;
  /** The answer's JSON, or for the event stream its text. */
  readonly body?: unknown;
  readonly text?: string;
}

/** The project and the citizens the fixtures' society has. */
async function addMembers(board: Board): Promise<void> {
  await board.addProject(USER, { slug: "demo", name: "Demo" });
  await addWorkRoles(board);
  await board.addAgent(USER, { name: "concierge-1", role: "concierge", cli: "claude" });
  await board.addAgent(USER, {
    name: "eng-1",
    role: "engineer",
    cli: "codex",
    memberships: ["demo"],
  });
  await board.addAgent(USER, {
    name: "rev-1",
    role: "reviewer",
    cli: "claude",
    memberships: ["demo"],
  });
}

/**
 * The society as the user finds it on opening the app: questions in a channel and in a thread, a
 * task at the user's stage and one held, three proposals, and a dashboard.
 */
async function fill(board: Board): Promise<void> {
  await board.invoke(ENGINEER, "post_message", {
    channel: "demo/general",
    body: "The build is green on `dev`. @user, should the release wait for the docs?",
  });
  const asked = IdSchema.parse(
    await board.invoke(CONCIERGE, "open_thread", {
      channel: "general",
      title: "Release notes for 0.4.0",
    }),
  );
  await board.invoke(CONCIERGE, "post_message", {
    thread_id: asked.id,
    body: "A draft is in the notes. @user, which features lead?",
  });
  const task = IdSchema.parse(
    await board.invoke(CONCIERGE, "create_task", {
      project: "demo",
      title: "Add the export view",
      body: "Export a channel's messages as markdown.",
      stages: [
        { name: "Build it", role: "engineer" },
        { name: "Approve the design", agent: "user", gate: true },
        { name: "Review it", agent: "rev-1", gate: true },
      ],
    }),
  );
  await board.invoke(ENGINEER, "claim_task", { task_id: task.id });
  await board.invoke(ENGINEER, "advance_task", {
    task_id: task.id,
    note: "Built; the design is in the thread.",
  });
  const held = IdSchema.parse(
    await board.invoke(ENGINEER, "create_task", { project: "demo", title: "Fix the empty state" }),
  );
  await board.invoke(ENGINEER, "claim_task", { task_id: held.id });
  await board.invoke(CONCIERGE, "propose", {
    kind: "member",
    charter: { name: "eng-2", role: "engineer", cli: "claude", memberships: ["demo"] },
    rationale: "The backlog has grown past one engineer.",
  });
  await board.invoke(ENGINEER, "propose", {
    kind: "channel",
    charter: { project: "demo", name: "release", purpose: "The 0.4.0 release." },
    rationale: "The release needs a workstream of its own.",
  });
  await board.invoke(REVIEWER, "propose", {
    kind: "reallocation",
    charter: {
      role: "reviewer",
      changes: { maxReplicas: 2 },
      description: "Two reviewers per project.",
    },
    rationale: "Reviews wait a day.",
  });
  await board.invoke(ENGINEER, "update_dashboard", {
    project: "demo",
    body: "## Demo\n\n- Export view: waiting on the design",
    revision: 0,
  });
}

describe("the answers the iOS client reads", () => {
  let dir: string | undefined;
  let society: TestSociety | undefined;

  afterEach(async () => {
    await society?.stop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("match the fixtures BoardKit decodes", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-ios-fixtures-"));
    const { board, userToken } = await Board.init(dir, { name: "fixtures" });
    await addMembers(board);
    society = await startTestSociety({ board, runnerName: "runner-1", backends: () => ({}) });
    const { url } = society;
    // The runner's connection is logged a moment after it starts; the stream is captured from after it.
    await expect
      .poll(async () =>
        (await board.readEvents(null, 1_000)).some(
          (event) => event.type === "ops.signal" && event.payload["key"] === "runner:runner-1",
        ),
      )
      .toBe(true);
    const streamFrom = await board.latestEventId();
    await fill(board);
    const normaliser = new Normaliser();
    const captures = new Map<string, Capture>();

    /** One request as the client makes it, kept under `name`; returns the answer as sent. */
    const call = async (
      name: string,
      method: "GET" | "POST" | "DELETE",
      route: string,
      input?: Record<string, unknown>,
      token: string | null = userToken,
    ): Promise<unknown> => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(input === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      const answer: unknown = await response.json();
      captures.set(name, {
        request: normaliser.json({
          method,
          path: route,
          ...(input === undefined ? {} : { body: input }),
        }),
        status: response.status,
        body: normaliser.json(answer),
      });
      return answer;
    };
    const read = async (route: string): Promise<unknown> =>
      (await fetch(`${url}${route}`, { headers: { authorization: `Bearer ${userToken}` } })).json();

    // The reads, before the user changes anything.
    await call("auth-config", "GET", "/auth/config", undefined, null);
    await call("me", "GET", "/api/me");
    await call("society", "GET", "/api/society");
    await call("projects", "GET", "/api/projects");
    await call("channels", "GET", "/api/channels");
    await call("channel", "GET", "/api/channels/demo/general");
    await call("threads", "GET", "/api/threads");
    await call("requests", "GET", "/api/requests");
    const tasks = TaskRowSchema.array().parse(
      await call("tasks", "GET", "/api/projects/demo/tasks"),
    );
    const task = tasks.find((each) => each.title === "Add the export view");
    await call("task", "GET", `/api/tasks/${task?.id}`);
    await call("thread", "GET", `/api/threads/${task?.id}`);
    const proposals = ProposalRowSchema.array().parse(
      await call("proposals", "GET", "/api/proposals"),
    );
    await call("proposal", "GET", `/api/proposals/${proposals[0]?.id}`);
    await call("dashboard", "GET", "/api/projects/demo/dashboard");

    // The writes, each a verb the app runs as the user.
    await call("post-message", "POST", "/api/verbs/post_message", {
      channel: "general",
      body: "Morning. The export view's design is next.",
    });
    const thread = IdSchema.parse(
      await call("open-thread", "POST", "/api/verbs/open_thread", {
        channel: "demo/general",
        title: "Rollout order",
      }),
    );
    await call("post-message-thread", "POST", "/api/verbs/post_message", {
      thread_id: thread.id,
      body: "Docs first, then the export view.",
    });
    await call("advance-task", "POST", "/api/verbs/advance_task", {
      task_id: task?.id,
      note: "The design is approved.",
    });
    const channel = proposals.find((each) => each.kind === "channel");
    await call("approve", "POST", "/api/verbs/approve", { proposal_id: channel?.id });
    await call("reject", "POST", "/api/verbs/reject", {
      proposal_id: proposals.find((each) => each.kind === "reallocation")?.id,
      reason: "One reviewer keeps up for now.",
    });
    await call("sign-out", "DELETE", "/api/sign-in");
    // The same two under a GitHub sign-in, the app's own way in, which names the account.
    const signedIn = await board.signIn("fixture-login", 60 * 60 * 1000);
    await call("me-signed-in", "GET", "/api/me", undefined, signedIn);
    await call("sign-out-signed-in", "DELETE", "/api/sign-in", undefined, signedIn);

    // The refusals, as `{error, message}`.
    await call("error-unauthorized", "GET", "/api/me", undefined, "not-a-token");
    await call("error-not-found", "GET", "/api/tasks/01HZZZZZZZZZZZZZZZZZZZZZZZ");
    await call("error-refused", "POST", "/api/verbs/approve", { proposal_id: channel?.id });

    // The event stream as the server writes it, every event since the society was set up.
    const events = BoardEventSchema.array().parse(await read(`/api/events?since=${streamFrom}`));
    const route = `/api/events/stream?since=${streamFrom}`;
    const response = await fetch(`${url}${route}`, {
      headers: { authorization: `Bearer ${userToken}` },
    });
    const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (reader === undefined) {
      throw new Error("the event stream has no body");
    }
    let text = "";
    while (text.split("\n\n").length <= events.length) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      text += value;
    }
    await reader.cancel();
    captures.set("event-stream", {
      request: normaliser.json({ method: "GET", path: route }),
      status: response.status,
      text: normaliser.text(text),
    });

    expect(events.map((event) => event.type)).toContain("proposal.decided");
    expect(captures.size).toBe(27);
    for (const [name, capture] of captures) {
      await expect(`${JSON.stringify(capture, null, 2)}\n`).toMatchFileSnapshot(
        `../../ios/fixtures/api/${name}.json`,
        name,
      );
    }
  });
});
