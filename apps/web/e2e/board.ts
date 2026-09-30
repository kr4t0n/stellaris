import type { Page, Route } from "@playwright/test";

export const TOKEN = "stl_e2e_fixture";
export const SKILL_PROPOSAL = "01M3PY56V68VFS0EG5ER4B9AMD";
export const ARCHIVE_PROPOSAL = "01M3PY56V68VFS0EG5ER4B9AME";

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
  onDone: "none",
};

/** A project archived after its work moved to lab, with the one post it kept. */
const ARCHIVED_PROJECT = {
  ...PROJECT,
  slug: "iphone",
  name: "iPhone study",
  members: [],
  archived: { at: CREATED, by: "user", reason: "merged into lab" },
};

const ARCHIVED_POST = {
  id: "01M3Q2GGGGGGGGGGGGGGGGGGG1",
  author: "ada",
  channel: "iphone/general",
  ts: CREATED,
  mentions: [],
  body: "The findings are on task/01M3Q2AAAAAAAAAAAAAAAAAAA9.",
};

/** desk asks to archive lab, whose sign-off stage is still in play. */
const ARCHIVE = {
  id: ARCHIVE_PROPOSAL,
  kind: "archive",
  proposedBy: "desk",
  status: "proposed",
  createdAt: CREATED,
  charter: { project: "lab", reason: "its work moves to a phones project" },
  body: "Its work moves to a phones project.",
};

const ARCHIVE_PITCH = {
  id: "01M3Q2GGGGGGGGGGGGGGGGGGG2",
  author: "desk",
  channel: "governance",
  thread: ARCHIVE_PROPOSAL,
  ts: CREATED,
  mentions: [],
  body: `Proposal ${ARCHIVE_PROPOSAL}: archive of project lab: its work moves to a phones project.`,
};

const ARCHIVE_THREAD = {
  id: ARCHIVE_PROPOSAL,
  channel: "governance",
  title: "archive proposal: archive of project lab",
  subject: { kind: "proposal", id: ARCHIVE_PROPOSAL },
  state: "open",
  openedBy: "desk",
  openedAt: CREATED,
  body: "",
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
  body: "Survey the field and tabulate the methods.",
};

/** The task's thread, opened with it, where ada's handover of the survey stage landed. */
const TASK_THREAD = {
  id: STAGE_TASK,
  channel: "lab/general",
  title: TASK.title,
  subject: { kind: "task", id: STAGE_TASK },
  state: "open",
  openedBy: "desk",
  openedAt: CREATED,
  body: "",
};

const HANDOVER = {
  id: "01M3Q2AAAAAAAAAAAAAAAAAAB1",
  author: "ada",
  channel: "lab/general",
  thread: STAGE_TASK,
  step: { action: "advanced", stage: "s1", to: "s2" },
  ts: CREATED,
  mentions: [],
  body: "Survey done: twelve methods in SURVEY.md, with sources.",
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
  body: `Every run fixes its seed at 42.\n\nThe harness lives in \`bench/\`.\n\nTask ${STAGE_TASK} settled the seed; its branch is task/${STAGE_TASK}.`,
};

/** The operations log: a runner reconnect, which informs, and a role gap, which wakes the steward. */
const SIGNALS = [
  {
    id: "01M3Q2FFFFFFFFFFFFFFFFFFF1",
    ts: CREATED,
    signal: {
      kind: "runner",
      key: "runner:server",
      summary: "runner server is connected with claude, codex",
      value: 1,
    },
  },
  {
    id: "01M3Q2FFFFFFFFFFFFFFFFFFF2",
    ts: CREATED,
    signal: {
      kind: "role_gap",
      key: "role_gap:lab:referee",
      summary: "a stage in lab waits on the referee role, which nobody fills",
      value: 1,
      project: "lab",
      role: "referee",
    },
  },
];

/** ada asks the user in the task's thread; the board lists it until the user answers there. */
const ASK = {
  id: "01M3Q2BBBBBBBBBBBBBBBBBBB1",
  author: "ada",
  channel: "lab/general",
  thread: STAGE_TASK,
  ts: CREATED,
  mentions: ["user"],
  body: "@user should the survey cover the 2025 results too?",
};

/** The skill proposal's pitch, which opened its thread in governance. */
const PITCH = {
  id: "01M3Q2CCCCCCCCCCCCCCCCCCC1",
  author: "stew",
  channel: "governance",
  thread: SKILL_PROPOSAL,
  ts: CREATED,
  mentions: [],
  body: `Proposal ${SKILL_PROPOSAL}: skill refereed-research.\n\nThe plan has run on four tasks.`,
};

export const ANSWERED_ASK = "01M3Q2HHHHHHHHHHHHHHHHHHH1";
export const CLOSED_ASK = "01M3Q2HHHHHHHHHHHHHHHHHHH0";

interface AskFixture {
  thread: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
}

function askMessage(id: string, thread: string, author: string, body: string) {
  return { id, author, channel: "general", thread, ts: CREATED, mentions: [], body };
}

/** Two asks the user made: one desk answered and nobody has read yet, one desk closed. */
function askFixtures(): Map<string, AskFixture> {
  return new Map([
    [
      CLOSED_ASK,
      {
        thread: {
          id: CLOSED_ASK,
          channel: "general",
          title: "Merge the phone projects",
          state: "closed",
          openedBy: "user",
          openedAt: CREATED,
          closedBy: "desk",
          closedAt: CREATED,
          body: "Filed the merge as a task in lab and proposed archiving iphone.",
        },
        messages: [
          askMessage("01M3Q2JJJJJJJJJJJJJJJJJJJ0", CLOSED_ASK, "user", "Merge the phone projects."),
          askMessage("01M3Q2JJJJJJJJJJJJJJJJJJJ1", CLOSED_ASK, "desk", "Filed it in lab."),
        ],
      },
    ],
    [
      ANSWERED_ASK,
      {
        thread: {
          id: ANSWERED_ASK,
          channel: "general",
          title: "Who reviews the survey?",
          state: "open",
          openedBy: "user",
          openedAt: CREATED,
          body: "",
        },
        messages: [
          askMessage("01M3Q2JJJJJJJJJJJJJJJJJJJ2", ANSWERED_ASK, "user", "Who reviews the survey?"),
          askMessage("01M3Q2JJJJJJJJJJJJJJJJJJJ3", ANSWERED_ASK, "desk", "ada reviews it."),
        ],
      },
    ],
  ]);
}

export interface FakeBoard {
  /** Every write the interface sent, in order. */
  readonly writes: Write[];
  /** Makes the next decision fail as the board would, with this reason. */
  refuseNext(message: string): void;
}

/**
 * A society of the user, a concierge, and a steward, with one skill proposal waiting on the user.
 * Decisions and the pause switch change the fake's state the way the board would. With `archived`,
 * an archived project sits beside lab and desk asks to archive lab too. With `asks`, the user has
 * asked twice before; a new ask opens a thread in general, and desk is in a turn on it once posted.
 */
export async function fakeBoard(
  page: Page,
  options: { asked?: boolean; archived?: boolean; asks?: boolean } = {},
): Promise<FakeBoard> {
  const archived = options.archived === true;
  const asks = options.asks === true ? askFixtures() : new Map<string, AskFixture>();
  let answering: string | null = null;
  const writes: Write[] = [];
  let refusal: string | null = null;
  let paused = false;
  let deskModel: string | null = null;
  // With `asked`, ada's question waits in the task's thread until the user writes there.
  let waitingAsk = options.asked === true;
  const threadMessages: Array<Record<string, unknown>> = waitingAsk ? [HANDOVER, ASK] : [HANDOVER];
  const proposalMessages: Array<Record<string, unknown>> = [PITCH];
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
    proposalMessages.push({
      id: "01M3Q2CCCCCCCCCCCCCCCCCCC2",
      author: "user",
      channel: "governance",
      thread: SKILL_PROPOSAL,
      step: { action: outcome },
      ts,
      mentions: [],
      body: `${outcome === "approved" ? "Approved" : "Rejected"}: skill refereed-research.`,
    });
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

  // The proposal's thread opened with its pitch and closes with its decision.
  const proposalThread = () => ({
    id: SKILL_PROPOSAL,
    channel: "governance",
    title: "skill proposal: refereed-research",
    subject: { kind: "proposal", id: SKILL_PROPOSAL },
    state: proposal.status === "proposed" ? "open" : "closed",
    openedBy: "stew",
    openedAt: CREATED,
    body: "",
  });

  await page.addInitScript((token) => localStorage.setItem("stellaris.token", token), TOKEN);
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
        case "/api/verbs/open_thread": {
          const thread = {
            id: `01M3Q2HHHHHHHHHHHHHHHHHHH${asks.size + 2}`,
            channel: body["channel"],
            title: body["title"],
            state: "open",
            openedBy: "user",
            openedAt: "2026-09-29T10:00:00.000Z",
            body: "",
          };
          asks.set(thread.id, { thread, messages: [] });
          return json(route, thread);
        }
        case "/api/verbs/post_message": {
          const ask = asks.get(String(body["thread_id"]));
          if (ask !== undefined) {
            const posted = {
              ...askMessage(
                `01M3Q2KKKKKKKKKKKKKKKKKKK${ask.messages.length}`,
                String(ask.thread["id"]),
                "user",
                String(body["body"]),
              ),
              ts: "2026-09-29T10:00:00.000Z",
            };
            ask.messages.push(posted);
            answering = String(ask.thread["id"]);
            return json(route, posted);
          }
          const posted = {
            id: `01M3Q2AAAAAAAAAAAAAAAAAAB${threadMessages.length + 1}`,
            author: "user",
            channel: "lab/general",
            thread: body["thread_id"],
            ts: "2026-09-29T10:00:00.000Z",
            mentions: [],
            body: body["body"],
          };
          threadMessages.push(posted);
          if (body["thread_id"] === STAGE_TASK) {
            waitingAsk = false;
          }
          return json(route, posted);
        }
        case "/api/pause":
        case "/api/resume":
          paused = pathname === "/api/pause";
          return json(route, { paused });
        default:
          return json(route, { message: `no fake for ${pathname}` }, 404);
      }
    }
    const ask = asks.get(pathname.slice("/api/threads/".length));
    if (pathname.startsWith("/api/threads/") && ask !== undefined) {
      return json(route, { thread: ask.thread, messages: ask.messages });
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
          channels: ["general", "governance"],
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
        return json(route, archived ? [PROJECT, ARCHIVED_PROJECT] : [PROJECT]);
      case "/api/projects/lab/tasks":
        return json(route, [TASK]);
      case `/api/tasks/${STAGE_TASK}`:
        return json(route, TASK);
      case "/api/projects/iphone/tasks":
      case "/api/projects/iphone/knowledge":
      case "/api/channels/lab/general":
        return json(route, []);
      case "/api/projects/iphone/dashboard":
        return json(route, { data: {}, body: "" });
      case "/api/channels/iphone/general":
        return json(route, [ARCHIVED_POST]);
      case `/api/proposals/${ARCHIVE_PROPOSAL}`:
        return json(route, ARCHIVE);
      case `/api/threads/${ARCHIVE_PROPOSAL}`:
        return json(route, { thread: ARCHIVE_THREAD, messages: [ARCHIVE_PITCH] });
      case "/api/threads":
        return json(route, [
          ...(archived
            ? [{ ...ARCHIVE_THREAD, messages: 1, lastMessageId: ARCHIVE_PITCH.id }]
            : []),
          {
            ...TASK_THREAD,
            messages: threadMessages.length,
            lastMessageId: threadMessages.at(-1)?.["id"] ?? null,
          },
          {
            ...proposalThread(),
            messages: proposalMessages.length,
            lastMessageId: proposalMessages.at(-1)?.["id"] ?? null,
          },
          ...[...asks.values()].map(({ thread, messages }) => ({
            ...thread,
            messages: messages.length,
            lastMessageId: messages.at(-1)?.["id"] ?? null,
            lastAuthor: messages.at(-1)?.["author"] ?? null,
          })),
        ]);
      case `/api/threads/${SKILL_PROPOSAL}`:
        return json(route, { thread: proposalThread(), messages: proposalMessages });
      case "/api/requests":
        return json(route, waitingAsk ? [{ message: ASK, thread: TASK_THREAD }] : []);
      case `/api/threads/${STAGE_TASK}`:
        return json(route, { thread: TASK_THREAD, messages: threadMessages });
      case "/api/skills":
      case "/api/channels/general":
      case "/api/channels/governance":
        return json(route, []);
      case "/api/scheduler":
        return json(route, {
          paused,
          running: answering === null ? [] : [`desk/society/${answering}`],
          pending: [],
          resident: [],
          signals: ["role_gap:lab:referee"],
        });
      case "/api/signals":
        return json(route, SIGNALS);
      case "/api/channels":
        return json(route, [
          channel("general"),
          channel("governance"),
          { ...channel("general"), ref: "lab/general", project: "lab" },
          ...(archived
            ? [{ ...channel("general"), ref: "iphone/general", project: "iphone", messages: 1 }]
            : []),
        ]);
      case "/api/proposals":
        return json(route, archived ? [proposal, ARCHIVE] : [proposal]);
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
