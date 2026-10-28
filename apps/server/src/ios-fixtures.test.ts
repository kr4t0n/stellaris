import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { ZERO_USAGE, type AgentBackend } from "@stellaris/runner-core";
import { BoardEventSchema, BranchFileSchema, ULID_PATTERN } from "@stellaris/shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startTestSociety, type TestSociety } from "./testing/harness.js";
import { addWorkRoles, USER } from "./testing/scripted-backend.js";
import { TurnHub } from "./turn-hub.js";

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
const PostSchema = z.object({ id: z.string(), author: z.string() });
const ProposalRowSchema = z.object({ id: z.string(), kind: z.string() });
const SessionSchema = z.object({ session: z.string() });

/** A one-pixel PNG, the image a turn leaves on a task's branch for the app to read. */
const PLOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** eng-1's CLI: its one turn leaves a plot on the task's branch. */
const plotting: AgentBackend = {
  kind: "codex",
  newSession: () => Promise.resolve("session-1"),
  runTurn: async (request) => {
    await mkdir(path.join(request.spec.cwd, "evidence"), { recursive: true });
    await writeFile(path.join(request.spec.cwd, "evidence", "plot.png"), PLOT);
    return {
      events: [],
      finalText: "Plotted.",
      usage: ZERO_USAGE,
      costUsd: 0,
      status: {
        summary: "Plotted.",
        claimsHeld: [],
        blockedOn: [],
        needsUserDecision: false,
        memoryUpdated: false,
      },
      exitReason: "completed",
    };
  },
};

/** The app's PKCE pair: RFC 7636's example in its appendix B, a verifier and its S256 challenge. */
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
/** The GitHub login the board lets in, and the code GitHub gives back for one it doesn't. */
const LOGIN = "fixture-login";
const STRANGER = "stranger";

/** GitHub as the board's sign-in asks it: a token for any code, then the account it names. */
const github: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === "https://github.com/login/oauth/access_token") {
    const body = typeof init?.body === "string" ? init.body : "{}";
    const { code } = z.object({ code: z.string() }).parse(JSON.parse(body));
    return Response.json({ access_token: `gho_${code}` });
  }
  const authorization = new Headers(init?.headers).get("authorization") ?? "";
  return Response.json({ login: authorization.endsWith(STRANGER) ? STRANGER : LOGIN, id: 1001 });
};

/**
 * Ids and times as a fixture shows them. Each id becomes a placeholder numbered in the order the
 * capture first met it, the same in every fixture, so a request names what an earlier answer gave.
 * A secret the server made up, as a sign-in's state, code, or session, becomes the name given it.
 */
class Normaliser {
  private readonly ids = new Map<string, string>();
  private readonly secrets = new Map<string, string>();

  secret(value: string, name: string): void {
    this.secrets.set(value, name);
  }

  text(raw: string): string {
    let masked = raw;
    for (const [value, name] of this.secrets) {
      masked = masked.replaceAll(value, name);
    }
    return masked
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
  /** Where a redirect sends the browser, for the steps of a sign-in. */
  readonly location?: string;
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
    const turns = new TurnHub();
    society = await startTestSociety({
      board,
      runnerName: "runner-1",
      backends: () => ({ codex: plotting }),
      turns,
      signIn: {
        github: {
          clientId: "Iv1.fixtures",
          clientSecret: "fixture-secret",
          users: [LOGIN],
          appleAppId: "ABCDE12345.com.example.stellaris",
        },
        fetch: github,
      },
    });
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

    /**
     * A step of a sign-in in the browser, kept under `name`, after the code a landing carries is
     * named; returns where it sends the browser.
     */
    const step = async (name: string, route: string): Promise<string> => {
      const response = await fetch(`${url}${route}`, { redirect: "manual" });
      const location = response.headers.get("location") ?? "";
      const code = new URLSearchParams(new URL(location, url).hash.slice(1)).get("code");
      if (code !== null) {
        normaliser.secret(code, "fixture-code");
      }
      captures.set(name, {
        request: normaliser.json({ method: "GET", path: route }),
        status: response.status,
        location: normaliser.text(location),
      });
      return location;
    };
    /** Starts the app's sign-in, kept under `name` when given, and gives the state GitHub would come back with. */
    const leave = async (name: string | null, stateName: string): Promise<string> => {
      const query = `landing=app&code_challenge=${CHALLENGE}&code_challenge_method=S256`;
      const response = await fetch(`${url}/auth/github?${query}`, { redirect: "manual" });
      const location = response.headers.get("location") ?? "";
      const state = new URL(location).searchParams.get("state") ?? "";
      normaliser.secret(state, stateName);
      if (name === null) {
        return state;
      }
      captures.set(name, {
        request: normaliser.json({ method: "GET", path: `/auth/github?${query}` }),
        status: response.status,
        location: normaliser.text(location),
      });
      return state;
    };

    // The reads, before the user changes anything.
    await call("auth-config", "GET", "/auth/config", undefined, null);

    // The app's sign-in with GitHub: the app starts it with its challenge, GitHub sends the browser
    // back to the board, which lands at the app's https path with a code the app trades with its
    // verifier for the session. One more lands refused, for a login the board doesn't let in.
    const state = await leave("app-sign-in", "fixture-state");
    const landing = await step(
      "app-landing",
      `/auth/github/callback?state=${state}&code=fixture-github-code`,
    );
    const code = new URLSearchParams(new URL(landing, url).hash.slice(1)).get("code") ?? "";
    const refusedState = await leave(null, "fixture-state-refused");
    await step(
      "app-landing-refused",
      `/auth/github/callback?state=${refusedState}&code=${STRANGER}`,
    );
    const exchange = { code, code_verifier: VERIFIER };
    const traded = await fetch(`${url}/auth/app/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exchange),
    });
    const tradedBody: unknown = await traded.json();
    normaliser.secret(SessionSchema.parse(tradedBody).session, "fixture-session");
    captures.set("app-token", {
      request: normaliser.json({ method: "POST", path: "/auth/app/token", body: exchange }),
      status: traded.status,
      body: normaliser.json(tradedBody),
    });
    // A code is good once.
    await call("error-app-token", "POST", "/auth/app/token", exchange, null);
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

    // A notice, the post a verb makes about its work, as writing a knowledge topic does.
    await board.invoke(ENGINEER, "write_knowledge", {
      project: "demo",
      topic: "release-flow",
      body: "The docs land before the export view.",
      revision: 0,
    });
    await call("channel-notice", "GET", "/api/channels/demo/general");

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

    // What the sky reads: the roster and the scheduler, and the live turn stream, where a turn
    // posts in the task's thread and runs a command while another citizen reads its inbox.
    await call("members", "GET", "/api/members");
    await call("scheduler", "GET", "/api/scheduler");
    const conversation = { thread: task?.id };
    turns.push("eng-1", "demo", { type: "text", delta: "Checking the export view." }, conversation);
    turns.push(
      "eng-1",
      "demo",
      {
        type: "tool_call",
        name: "mcp__board__post_message",
        input: { thread_id: task?.id, body: "## The export view is in\n\nThe design is approved." },
      },
      conversation,
    );
    turns.push(
      "eng-1",
      "demo",
      { type: "tool_call", name: "Bash", input: { command: "pnpm test" } },
      conversation,
    );
    turns.push("eng-1", "demo", { type: "tool_result", name: "Bash", ok: true }, conversation);
    turns.push("concierge-1", "society", {
      type: "tool_call",
      name: "mcp__board__read_inbox",
      input: {},
    });
    const turnRoute = "/api/turns/stream?since=0";
    const turnResponse = await fetch(`${url}${turnRoute}`, {
      headers: { authorization: `Bearer ${userToken}` },
    });
    const turnReader = turnResponse.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (turnReader === undefined) {
      throw new Error("the turn stream has no body");
    }
    let turnText = "";
    while (turnText.split("\n\n").length <= turns.lastSeq) {
      const { value, done } = await turnReader.read();
      if (done) {
        break;
      }
      turnText += value;
    }
    await turnReader.cancel();
    captures.set("turn-stream", {
      request: normaliser.json({ method: "GET", path: turnRoute }),
      status: turnResponse.status,
      text: normaliser.text(turnText),
    });

    // An image on the task's branch, which a message links by its path in a worktree: a turn
    // leaves it, and the board reads it from the project's runner. The commit's id varies by run.
    await society.run({
      agent: "eng-1",
      project: "demo",
      thread: { id: task?.id ?? "", task: true },
      trigger: { kind: "manual", fromUser: true, reason: "fixture" },
      priority: 2,
    });
    const fileRoute = `/api/tasks/${task?.id}/files/evidence/plot.png`;
    const file = BranchFileSchema.parse(await read(fileRoute));
    normaliser.secret(file.commit.id, "fixture-commit");
    await call("task-file", "GET", fileRoute);

    // Where the messages a text names by id are: one the board has, and one it doesn't, which the
    // answer leaves out.
    const posts = PostSchema.array().parse(await read("/api/channels/demo/general"));
    const named = posts.find((post) => post.author === "eng-1")?.id;
    await call("messages", "GET", `/api/messages?ids=${named},01HZZZZZZZZZZZZZZZZZZZZZZZ`);

    expect(events.map((event) => event.type)).toContain("proposal.decided");
    expect(captures.size).toBe(38);
    for (const [name, capture] of captures) {
      await expect(`${JSON.stringify(capture, null, 2)}\n`).toMatchFileSnapshot(
        `../../ios/fixtures/api/${name}.json`,
        name,
      );
    }
  });
});
