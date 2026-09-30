import type { Page, Route } from "@playwright/test";

export const TOKEN = "stl_e2e_fixture";
export const SKILL_PROPOSAL = "01M3PY56V68VFS0EG5ER4B9AMD";

const CREATED = "2026-09-29T09:00:00.000Z";

function member(
  name: string,
  charter: string,
  memberships: string[] = [],
  model: string | null = null,
) {
  return {
    name,
    role: charter,
    cli: "claude",
    ...(model === null ? {} : { model }),
    lastModel: "claude-opus-5-5",
    homeRunner: "server",
    status: "active",
    resident: false,
    skills: [],
    memberships,
    subscriptions: [],
    claimsHeld: 0,
    tasksDone: 0,
    createdAt: CREATED,
    profile: "",
  };
}

function role(name: string, wakeTriggers: string[], resident = false) {
  return {
    name,
    purpose: `The ${name}.`,
    verbs: ["post_message", "propose", "approve"],
    wakeTriggers,
    maxReplicas: 1,
    backlogThreshold: 3,
    resident,
    societyScope: true,
    reflects: true,
  };
}

function channel(name: string) {
  return { ref: name, project: null, name, messages: 0, lastMessageId: null, lastAt: null };
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

interface Proposal {
  id: string;
  kind: string;
  proposedBy: string;
  status: string;
  createdAt: string;
  charter: Record<string, unknown>;
  body: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  provisionedAt?: string;
  provision?: Record<string, unknown>;
}

export interface Write {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

export const STAGE_TASK = "01M3Q2AAAAAAAAAAAAAAAAAAA1";

const PROJECT = {
  slug: "lab",
  name: "Lab",
  repo: null,
  defaultBranch: "main",
  channels: ["general"],
  members: ["desk"],
  approvers: [],
  requiredCapabilities: [],
  createdAt: CREATED,
  defaultPlan: [],
  onDone: "none",
};

/** A study whose gated sign-off stage names the user. */
const TASK = {
  id: STAGE_TASK,
  project: "lab",
  title: "Compare shortest-path algorithms",
  status: "open",
  createdBy: "desk",
  createdAt: CREATED,
  updatedAt: CREATED,
  blockedBy: [],
  requiredCapabilities: [],
  stages: [
    {
      id: "s1",
      name: "Survey",
      role: "researcher",
      gate: false,
      holders: ["ada"],
      completedBy: "ada",
      completedAt: CREATED,
    },
    { id: "s2", name: "Sign off", agent: "user", gate: true, holders: [] },
  ],
  stage: "s2",
  stageSince: CREATED,
  stageSeq: 2,
  onDone: "none",
  completing: false,
  body: "",
};

/** desk's one finished turn, as the event log pairs its start and end. */
const DESK_TURN_ID = "01M3Q2DDDDDDDDDDDDDDDDDDD2";

const DESK_TURN = {
  id: "01M3Q2DDDDDDDDDDDDDDDDDDD1",
  turnId: DESK_TURN_ID,
  ts: "2026-09-29T09:03:00.000Z",
  outcome: "completed",
  project: "lab",
  trigger: "user_post",
  exitReason: "completed",
  costUsd: 0.25,
  model: "claude-opus-5-5",
  summary: "Routed the survey request to ada and filed the task.",
  error: null,
  startedAt: "2026-09-29T09:00:00.000Z",
  toolCalls: 4,
};

/** The steps desk's turn kept: what it said, a command that failed, and a board verb. */
const DESK_TRANSCRIPT = [
  {
    ts: "2026-09-29T09:00:00.000Z",
    event: { type: "turn_started", agent: "desk", session: "s-1", runner: "server" },
  },
  { ts: "2026-09-29T09:00:05.000Z", event: { type: "text", delta: "Looking at the request." } },
  {
    ts: "2026-09-29T09:00:06.000Z",
    event: { type: "tool_call", name: "Bash", input: { command: "ls lab/bench" } },
  },
  {
    ts: "2026-09-29T09:00:07.000Z",
    event: {
      type: "tool_result",
      name: "Bash",
      ok: false,
      output: "ls: cannot access 'lab/bench': No such file or directory",
    },
  },
  {
    ts: "2026-09-29T09:01:00.000Z",
    event: {
      type: "tool_call",
      name: "mcp__board__create_task",
      input: { project: "lab", title: "Survey" },
    },
  },
  {
    ts: "2026-09-29T09:01:01.000Z",
    event: {
      type: "tool_result",
      name: "mcp__board__create_task",
      ok: true,
      output: '{"id":"01M3Q2AAAAAAAAAAAAAAAAAAA1"}',
    },
  },
  {
    ts: "2026-09-29T09:03:00.000Z",
    event: {
      type: "turn_completed",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.25,
      status: {
        summary: "Routed the survey request to ada and filed the task.",
        claimsHeld: [],
        blockedOn: [],
        needsUserDecision: false,
        memoryUpdated: false,
      },
      exitReason: "completed",
    },
  },
];

const LAB_TOPIC = {
  topic: "experiments",
  project: "lab",
  updatedBy: "ada",
  updatedAt: CREATED,
  body: "Every run fixes its seed at 42.\n\nThe harness lives in `bench/`.",
};

/** A turn that reported it needs the user, as the runner posts it. */
const REQUEST = {
  id: "01M3Q2BBBBBBBBBBBBBBBBBBB1",
  author: "stew",
  channel: "decisions",
  ts: CREATED,
  mentions: ["user"],
  body: "@user decision needed on lab: sign off the survey before it merges",
};

export interface FakeBoard {
  /** Every write the interface sent, in order. */
  readonly writes: Write[];
  /** Makes the next decision fail as the board would, with this reason. */
  refuseNext(message: string): void;
}

/**
 * A society of the user, a concierge, and a steward, with one skill proposal waiting on the user.
 * Decisions and the pause switch change the fake's state the way the board would.
 */
export async function fakeBoard(
  page: Page,
  options: { unreadDecisions?: boolean } = {},
): Promise<FakeBoard> {
  const writes: Write[] = [];
  let refusal: string | null = null;
  let paused = false;
  let deskModel: string | null = null;
  const proposal: Proposal = {
    id: SKILL_PROPOSAL,
    kind: "skill",
    proposedBy: "stew",
    status: "proposed",
    createdAt: CREATED,
    charter: {
      name: "refereed-research",
      summary: "Plan a research task with a gated referee.",
      body: "---\nname: refereed-research\ndescription: Plan a research task.\n---\n\n# Refereed research\n\nUse this for any study.",
    },
    body: "The plan has run on four tasks.",
  };

  const decide = (
    route: Route,
    outcome: "approved" | "rejected",
    body: Record<string, unknown>,
  ) => {
    if (refusal !== null) {
      const message = refusal;
      refusal = null;
      return json(route, { message }, 409);
    }
    const ts = "2026-09-29T10:00:00.000Z";
    const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;
    Object.assign(proposal, {
      status: outcome === "rejected" ? "rejected" : "provisioned",
      decidedBy: "user",
      decidedAt: ts,
      ...(reason === undefined ? {} : { reason }),
      ...(outcome === "approved"
        ? { provisionedAt: ts, provision: { skill: "refereed-research", replaced: false } }
        : {}),
    });
    return json(route, {
      id: "01M3Q1AAAAAAAAAAAAAAAAAAAA",
      proposalId: proposal.id,
      decidedBy: "user",
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ts,
    });
  };

  await page.addInitScript((token) => localStorage.setItem("stellaris.token", token), TOKEN);
  if (options.unreadDecisions === true) {
    // A browser that listed the board before the request arrived, so #decisions has something new.
    await page.addInitScript(() => localStorage.setItem("stellaris.seen", '{"*":"1"}'));
  }
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() !== "GET") {
      const body: Record<string, unknown> = request.postDataJSON() ?? {};
      writes.push({ path: pathname, body });
      switch (pathname) {
        case "/api/verbs/approve":
          return decide(route, "approved", body);
        case "/api/verbs/reject":
          return decide(route, "rejected", body);
        case "/api/agents/desk/model":
          deskModel = typeof body["model"] === "string" ? body["model"] : null;
          return json(route, {
            ...member("desk", "concierge", ["lab"], deskModel),
            homeRunner: "server",
          });
        case "/api/wake":
          return json(route, {
            id: "01M3Q2EEEEEEEEEEEEEEEEEEE1",
            ts: CREATED,
            type: "wake.requested",
            actor: "user",
            payload: body,
          });
        case "/api/pause":
        case "/api/resume":
          paused = pathname === "/api/pause";
          return json(route, { paused });
        default:
          return json(route, { message: `no fake for ${pathname}` }, 404);
      }
    }
    switch (pathname) {
      // Streams stay open and quiet, as a board with nothing happening does.
      case "/api/events/stream":
      case "/api/turns/stream":
        return undefined;
      case "/api/me":
        return json(route, { name: "user", role: "user" });
      case "/api/society":
        return json(route, {
          name: "fixture",
          version: 1,
          createdAt: CREATED,
          channels: ["general", "governance", "decisions"],
        });
      case "/api/members":
        return json(route, [
          member("desk", "concierge", ["lab"], deskModel),
          member("stew", "steward"),
        ]);
      case "/api/models/claude":
        return json(route, [
          { id: "opus", name: "Opus 5.5", description: "For complex work.", isDefault: true },
          { id: "sonnet", name: "Sonnet 5", description: "Efficient for routine tasks." },
        ]);
      case "/api/agents/desk/turns":
        return json(route, [DESK_TURN]);
      case `/api/agents/desk/turns/${DESK_TURN_ID}`:
        return json(route, DESK_TRANSCRIPT);
      case "/api/agents/desk/memory":
        return json(route, { body: "# Core memory\n\n- The user writes names plainly." });
      case "/api/agents/desk/skills":
        return json(route, [
          {
            name: "routing",
            summary: "Send a post to who can act on it.",
            scope: "own",
            path: "/x",
          },
        ]);
      case "/api/projects/lab/dashboard":
        return json(route, { data: {}, body: "# Lab dashboard\n\nThroughput is steady." });
      case "/api/projects/lab/knowledge":
        return json(route, [LAB_TOPIC]);
      case "/api/society/knowledge":
        return json(route, []);
      case "/api/roles":
        return json(route, [
          role("concierge", ["user_post"], true),
          role("steward", ["ops_event"]),
        ]);
      case "/api/projects":
        return json(route, [PROJECT]);
      case "/api/projects/lab/tasks":
        return json(route, [TASK]);
      case "/api/threads":
      case "/api/skills":
      case "/api/channels/general":
      case "/api/channels/governance":
        return json(route, []);
      case "/api/channels/decisions":
        return json(route, [REQUEST]);
      case "/api/scheduler":
        return json(route, { paused, running: [], pending: [], resident: [], signals: [] });
      case "/api/channels":
        return json(route, [
          channel("general"),
          channel("governance"),
          { ...channel("decisions"), messages: 1, lastMessageId: REQUEST.id, lastAt: REQUEST.ts },
          { ...channel("general"), ref: "lab/general", project: "lab" },
        ]);
      case "/api/proposals":
        return json(route, [proposal]);
      case `/api/proposals/${SKILL_PROPOSAL}`:
        return json(route, proposal);
      default:
        return json(route, { message: `no fake for ${pathname}` }, 404);
    }
  });
  return {
    writes,
    refuseNext: (message) => {
      refusal = message;
    },
  };
}
