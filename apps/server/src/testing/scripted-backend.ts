import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ZERO_USAGE,
  type AgentBackend,
  type AgentSpec,
  type ResidentSession,
  type ResidentStart,
  type TurnRequest,
  type TurnResult,
} from "@stellaris/runner-core";
import type { Board } from "@stellaris/board-core";
import { MEMBER_VERBS } from "@stellaris/shared";
import { execa } from "execa";
import type { Hono } from "hono";
import { z } from "zod";

export const USER = { name: "user", role: "user" } as const;

/**
 * Roles for the work itself are not seeded; tests that need them write them the way a society
 * would, by charter.
 */
export async function addWorkRoles(board: Board): Promise<void> {
  await board.setRoleCharter(USER, {
    name: "engineer",
    purpose: "Builds what a stage asks for and commits it on the task's branch.",
    verbs: [...MEMBER_VERBS],
    wakeTriggers: ["heartbeat"],
  });
  await board.setRoleCharter(USER, {
    name: "reviewer",
    purpose: "Checks work at gated stages and sends it back when it is unfinished.",
    verbs: [...MEMBER_VERBS],
    wakeTriggers: ["heartbeat"],
  });
}

export const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;

export function done(summary: string): TurnResult {
  return {
    events: [{ type: "tool_call", name: "mcp__board__post_message", input: {} }],
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

/** A turn that changed the memory core or a skill, which the runner must know to recycle a warm session. */
export function remembered(summary: string): TurnResult {
  const result = done(summary);
  return {
    ...result,
    status: result.status === null ? null : { ...result.status, memoryUpdated: true },
  };
}

/**
 * A scripted stand-in for a CLI agent. It reads the prompt like an agent would, acts through the
 * HTTP verbs with the turn token it was handed, and edits code in its worktree with git.
 * The real adapters replace it; everything around it is the production path.
 */
export class ScriptedBackend implements AgentBackend {
  readonly kind = "claude" as const;
  readonly prompts: string[] = [];
  readonly residentStarts: string[] = [];
  readonly residentCloses: string[] = [];

  constructor(
    private readonly app: Hono<{ Variables: { actor: { name: string; role: string } } }>,
  ) {}

  newSession(): Promise<string> {
    return Promise.resolve(`session-${this.prompts.length + 1}`);
  }

  /** The same script over a warm session, so resident roles exercise the runner's resident path. */
  startResident(spec: AgentSpec, start: ResidentStart): Promise<ResidentSession> {
    const key = `${spec.agent}/${spec.project}`;
    this.residentStarts.push(key);
    const session: ResidentSession = {
      session: start.session,
      runTurn: (prompt) =>
        this.runTurn({
          spec,
          session: start.session,
          newSession: start.newSession,
          prompt,
          instructions: start.instructions,
          mcp: start.mcp,
          limits: start.limits,
          statusSchema: start.statusSchema,
          env: start.env,
        }),
      close: () => {
        this.residentCloses.push(key);
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
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

    // The front desk routes the user's posts: a planned task for an existing project, or a new
    // project; a task it created coming back done is news for the user.
    if (request.spec.agent === "desk") {
      if (request.prompt.includes("Trigger: task_done")) {
        await verb("post_message", {
          channel: "general",
          body: "The health endpoint is in: its task is done.",
        });
        return done("told the user the task is done");
      }
      if (!request.prompt.includes("Trigger: user_post")) {
        return done("nothing to do");
      }
      if (request.prompt.includes("health endpoint")) {
        await verb("create_task", {
          project: "demo",
          title: "Add a health endpoint",
          body: "Requested by the user at the front desk.",
          stages: [{ name: "build", role: "engineer" }],
        });
        return done("planned the request as a task on demo for its engineers");
      }
      if (request.prompt.includes("new project called api")) {
        await verb("create_project", { slug: "api", name: "Public API" });
        await verb("propose", {
          kind: "member",
          charter: { name: "eng-2", role: "engineer", cli: "codex", memberships: ["api"] },
          rationale: "The user opened a project with no engineer on it.",
        });
        return done("created the api project and proposed its first engineer");
      }
      return done("answered");
    }

    // The steward reads operations signals and proposes; it never touches tasks.
    if (request.spec.agent === "stew-1") {
      if (request.prompt.includes("Trigger: ops_event") && /\] backlog: /.test(request.prompt)) {
        await verb("propose", {
          kind: "member",
          charter: {
            name: "eng-2",
            role: "engineer",
            cli: "codex",
            memberships: ["demo"],
            seedInstructions: "Start with the oldest open task.",
          },
          rationale: "The backlog per engineer on demo reached the threshold.",
        });
        return done("proposed a second engineer for demo");
      }
      // The steward curates the society's skills: a proposed procedure in its digest gets a decision.
      const skillProposal = /Proposal ([0-9A-HJKMNP-TV-Z]{26}): skill /.exec(request.prompt)?.[1];
      if (skillProposal !== undefined) {
        await verb("approve", {
          proposal_id: skillProposal,
          reason: "a procedure every Python project here needs",
        });
        return done(`approved skill proposal ${skillProposal}`);
      }
      return done("nothing to do");
    }

    // A citizen that learns: a lesson in its core, a skill in its home, a fact in project knowledge.
    if (request.spec.agent === "mem-1") {
      const home = request.spec.configHome;
      if (request.prompt.includes("## Reflection")) {
        if (!request.instructions.includes("prefers uv")) {
          throw new Error("the reflection turn did not load the core memory");
        }
        if (!request.instructions.includes("- uv-setup (yours): Set up a uv project")) {
          throw new Error("the reflection turn did not list the agent's own skill");
        }
        await writeFile(
          path.join(home, "memory", "python.md"),
          "# Python\n\nLock files are committed; run uv sync --locked before anything else.\n",
          "utf8",
        );
        await writeFile(
          path.join(home, "profile.md"),
          "# Profile\n\nPython projects with uv; send me packaging and test setup.\n",
          "utf8",
        );
        await verb("propose", {
          kind: "skill",
          charter: {
            name: "uv-setup",
            summary: "Set up a uv project with locked dependencies",
            body: await readFile(path.join(home, "skills", "uv-setup", "SKILL.md"), "utf8"),
          },
          rationale: "Every Python project in the society needs the same setup.",
        });
        return remembered("reflected: archived the uv notes and proposed uv-setup to the society");
      }
      if (request.prompt.includes("This is your first turn") && request.prompt.includes('"beta"')) {
        // The second project: the lesson, the archive, and both skills came along.
        if (!request.instructions.includes("prefers uv")) {
          throw new Error("the lesson from alpha did not reach beta");
        }
        if (
          !request.instructions.includes("- uv-setup (yours)") ||
          !request.instructions.includes("- uv-setup (society)")
        ) {
          throw new Error("the skills index on beta misses a skill");
        }
        const hits = z
          .array(z.object({ kind: z.string(), ref: z.string() }))
          .parse(await verb("search", { query: "uv sync --locked" }));
        if (!hits.some((hit) => hit.kind === "memory" && hit.ref === "memory/python.md")) {
          throw new Error(`the archive is not searchable on beta: ${JSON.stringify(hits)}`);
        }
        await verb("write_knowledge", {
          project: "beta",
          topic: "testing",
          body: "Run uv sync --locked, then uv run pytest -q; carried over from alpha.",
        });
        return done("onboarded on beta and wrote its testing knowledge from the alpha lesson");
      }
      if (request.prompt.includes("Trigger: manual")) {
        await mkdir(path.join(home, "memory"), { recursive: true });
        await writeFile(
          path.join(home, "memory", "core.md"),
          "- The user prefers uv for Python; run uv sync --locked before the tests.\n",
          "utf8",
        );
        await mkdir(path.join(home, "skills", "uv-setup"), { recursive: true });
        await writeFile(
          path.join(home, "skills", "uv-setup", "SKILL.md"),
          "---\nname: uv-setup\ndescription: Set up a uv project with locked dependencies\n---\n# uv setup\n\n1. uv sync --locked\n2. uv run pytest -q\n",
          "utf8",
        );
        await verb("write_knowledge", {
          project: "alpha",
          topic: "testing",
          body: "Run uv sync --locked, then uv run pytest -q.",
        });
        return remembered("wrote the uv lesson, the uv-setup skill, and alpha's testing knowledge");
      }
      return done("nothing to do");
    }

    // A stage wake names the task; a mention carries it in the message body.
    const taskId =
      /Task in question: ([0-9A-HJKMNP-TV-Z]{26})/.exec(request.prompt)?.[1] ??
      /take task ([0-9A-HJKMNP-TV-Z]{26})/.exec(request.prompt)?.[1];
    if (taskId === undefined || !ULID.test(taskId)) {
      return done("nothing to do");
    }
    const git = (...args: string[]) =>
      execa("git", args, { cwd: request.spec.cwd, env: { ...process.env, ...request.env } });
    const branch = `task/${taskId}`;

    // The engineer builds on the task's branch; a second pass adds what the review asked for.
    if (request.spec.agent === "eng-1") {
      await verb("claim_task", { task_id: taskId });
      await git("switch", branch);
      const file = path.join(request.spec.cwd, "hello.txt");
      const again = await readFile(file, "utf8").then(
        () => true,
        () => false,
      );
      if (again) {
        await writeFile(file, "hello from eng-1\nand a second line\n", "utf8");
        await git("commit", "-am", "feat: add the second line the review asked for");
      } else {
        await writeFile(file, "hello from eng-1\n", "utf8");
        await git("add", "hello.txt");
        await git("commit", "-m", "feat: add hello.txt");
        await verb("post_message", {
          body: `Committed hello.txt on ${branch}.`,
          thread_id: taskId,
        });
      }
      await verb("advance_task", { task_id: taskId, note: again ? "second line added" : "built" });
      return done(again ? "reworked hello.txt" : "built hello.txt");
    }

    // The reviewer holds the gated stage: it sends the work back once, then approves.
    if (request.spec.agent === "rev-1") {
      await verb("claim_task", { task_id: taskId });
      const content = await git("show", `${branch}:hello.txt`);
      if (content.stdout.split("\n").length < 2) {
        const task = z
          .object({ stages: z.array(z.object({ id: z.string() })) })
          .parse(await verb("get_task", { task_id: taskId }));
        await verb("update_task", {
          task_id: taskId,
          stage: task.stages[0]?.id,
          note: "add a second line",
        });
        return done("sent the task back for a second line");
      }
      await verb("advance_task", { task_id: taskId, note: "reviewed the diff" });
      return done("approved");
    }
    return done("no script");
  }
}
