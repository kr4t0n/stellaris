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
  runner: string | null = "pod",
  effort: string | null = null,
) {
  return {
    name,
    role: charter,
    cli: "claude",
    ...(model === null ? {} : { model }),
    ...(effort === null ? {} : { effort }),
    lastModel: "claude-opus-5-5",
    ...(runner === null ? {} : { homeRunner: runner }),
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
  runner: "laptop",
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
  body: `Survey done: twelve methods in SURVEY.md, with sources. The write-up is [report.md](/home/tiger/runner-data/worktrees/ada/.tasks/${STAGE_TASK}/docs/report.md); my scratch notes are in [notes](/tmp/ada-notes.md). The [table's citation](/home/tiger/runner-data/worktrees/ada/.tasks/${STAGE_TASK}/docs/report.md:7) points at the numbers.`,
};

/** The branch's newest commit, as the task's runner reports it with every read. */
const TASK_COMMIT = { id: "4f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49", at: CREATED, author: "ada" };

const PLOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function taskFile(path: string, content: string) {
  const bytes = Buffer.from(content, path.endsWith(".png") ? "base64" : "utf8");
  return {
    kind: "file",
    path,
    commit: TASK_COMMIT,
    size: bytes.length,
    content: bytes.toString("base64"),
  };
}

/** What the survey's branch changed since it left main, as the task's runner lists it. */
const TASK_CHANGES = {
  head: TASK_COMMIT,
  total: 4,
  files: [
    { path: "docs/plot.png", status: "added", added: null, removed: null },
    {
      path: "docs/report.md",
      status: "added",
      added: 7,
      removed: 0,
      lastChange: { author: "ada", at: CREATED },
    },
    {
      path: "draft.md",
      status: "deleted",
      added: 0,
      removed: 4,
      lastChange: { author: "ref", at: CREATED },
    },
    {
      path: "results.csv",
      status: "modified",
      added: 2,
      removed: 1,
      lastChange: { author: "ada", at: CREATED },
    },
  ],
};

/** What the survey's turns left on its branch: a report with a figure, and the table it cites. */
const TASK_FILES: Readonly<Record<string, unknown>> = {
  "": {
    kind: "dir",
    path: "",
    commit: TASK_COMMIT,
    entries: [
      { name: "results.csv", kind: "file", size: 44 },
      { name: "docs", kind: "dir", size: null },
    ],
  },
  docs: {
    kind: "dir",
    path: "docs",
    commit: TASK_COMMIT,
    entries: [
      { name: "report.md", kind: "file", size: 140 },
      { name: "plot.png", kind: "file", size: 70 },
    ],
  },
  "docs/report.md": taskFile(
    "docs/report.md",
    "# Shortest paths\n\nDijkstra wins on sparse graphs.\n\n![Runtime by graph size](plot.png)\n\nThe raw numbers are in [the table](../results.csv).\n",
  ),
  "docs/plot.png": taskFile("docs/plot.png", PLOT_PNG),
  "docs/run.log": taskFile("docs/run.log", "first line\nsecond line\nthird line\n"),
  "results.csv": taskFile("results.csv", 'method,runtime\nDijkstra,1.2\n"A*, tuned",0.9\n'),
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
  usage: {
    inputTokens: 18,
    outputTokens: 1_540,
    cacheReadTokens: 146_048,
    cacheWriteTokens: 5_295,
  },
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

const DESK_TURN_COMMIT = "a".repeat(40);
const DESK_HOME_COMMIT = "b".repeat(40);

/** desk's home history: what its turn changed, after the board created the home. */
const DESK_HISTORY = {
  changes: [
    {
      commit: DESK_TURN_COMMIT,
      at: "2026-09-29T09:03:01.000Z",
      kind: "turn",
      author: "desk",
      turnId: DESK_TURN_ID,
      subject: `turn ${DESK_TURN_ID}`,
      files: [
        { path: "memory/core.md", status: "modified", added: 1, removed: 0 },
        { path: "skills/routing/SKILL.md", status: "added", added: 4, removed: 0 },
      ],
    },
    {
      commit: DESK_HOME_COMMIT,
      at: "2026-09-29T08:00:00.000Z",
      kind: "board",
      author: "stellaris-board",
      subject: "home: created by the board",
      files: [{ path: "memory/core.md", status: "added", added: 1, removed: 0 }],
    },
  ],
  more: false,
};

const DESK_TURN_CHANGE = [
  {
    path: "memory/core.md",
    status: "modified",
    patch: "@@ -1 +1,3 @@\n # Core memory\n+\n+- The user writes names plainly.",
    truncated: false,
  },
  {
    path: "skills/routing/SKILL.md",
    status: "added",
    patch:
      "@@ -0,0 +1,4 @@\n+---\n+name: routing\n+description: Send a post to who can act on it.\n+---",
    truncated: false,
  },
];

const LAB_TOPIC = {
  topic: "experiments",
  project: "lab",
  updatedBy: "ada",
  updatedAt: CREATED,
  body: `Every run fixes its seed at 42.\n\nThe harness lives in \`bench/\`.\n\nTask ${STAGE_TASK} settled the seed; its branch is task/${STAGE_TASK}.`,
};

const SOCIETY_TOPIC = {
  topic: "code-comments",
  project: null,
  updatedBy: "stew",
  updatedAt: CREATED,
  body: "Comment only what the code cannot say.",
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
  return { id, author, channel: "asks", thread, ts: CREATED, mentions: [], body };
}

/** Two asks the user made: one desk answered and nobody has read yet, one desk closed. */
function askFixtures(): Map<string, AskFixture> {
  return new Map([
    [
      CLOSED_ASK,
      {
        thread: {
          id: CLOSED_ASK,
          channel: "asks",
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
          channel: "asks",
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

/** A week of metrics, or more decisions over the whole log, so the window switch shows. */
function metrics(window: string) {
  return {
    window,
    since: window === "all" ? null : "2026-09-22T09:00:00.000Z",
    until: "2026-09-29T09:00:00.000Z",
    idle: {
      turns: 12,
      idle: 3,
      unknown: 1,
      byTrigger: [
        { trigger: "heartbeat", turns: 4, idle: 3 },
        { trigger: "stage", turns: 8, idle: 0 },
      ],
      byAgent: [
        { agent: "stew", role: "steward", turns: 4, idle: 3 },
        { agent: "desk", role: "concierge", turns: 8, idle: 0 },
      ],
    },
    sentBack: {
      finished: 2,
      sendBacks: 1,
      tasksSentBack: 1,
      byStage: [{ project: "lab", stage: "Sign off", count: 1 }],
      bySender: [{ agent: "user", count: 1 }],
    },
    messages: {
      finished: 2,
      messages: 9,
      byProject: [{ project: "lab", finished: 2, messages: 9 }],
      busiest: [{ taskId: STAGE_TASK, title: TASK.title, project: "lab", messages: 6 }],
    },
    latency: {
      mentions: 3,
      unanswered: 1,
      medianMs: 30_000,
      slowestMs: 95_000,
      byAgent: [{ agent: "desk", mentions: 3, medianMs: 30_000, slowestMs: 95_000 }],
    },
    decisions: {
      total: window === "all" ? 5 : 2,
      byDay: [
        { day: "2026-09-29", proposals: 1, answers: 1, stages: 0 },
        ...(window === "all" ? [{ day: "2026-09-20", proposals: 2, answers: 0, stages: 1 }] : []),
      ],
    },
    blocked: [
      {
        taskId: STAGE_TASK,
        title: TASK.title,
        project: "lab",
        summary: "needs gpu and no connected runner offers it",
        firstAt: CREATED,
        lastAt: CREATED,
        holds: true,
      },
    ],
  };
}

export interface FakeBoard {
  /** Every write the interface sent, in order. */
  readonly writes: Write[];
  /** Makes the next decision fail as the board would, with this reason. */
  refuseNext(message: string): void;
}

/** A runner on a machine called studio asking to join, which `enrolling` puts on the board. */
export const ENROLLING_CODE = "BCDF-GHJK";

/** The turn desk is in at the society with `inFlight`, which its runner can steer and stop. */
export const DESK_TURN_IN_FLIGHT = "01M3Q2TTTTTTTTTTTTTTTTTTT1";

/** The models Claude Code lists on the pod runner, where desk's turns run. */
const CLAUDE_MODELS = [
  {
    id: "opus",
    name: "Opus 5.5",
    description: "For complex work.",
    isDefault: true,
    efforts: [
      { id: "high", description: "Deep reasoning" },
      { id: "max", description: "Maximum effort" },
    ],
    defaultEffort: "high",
  },
  {
    id: "sonnet",
    name: "Sonnet 5",
    description: "Efficient for routine tasks.",
    efforts: [{ id: "high", description: "Deep reasoning" }],
    defaultEffort: "high",
  },
];

/**
 * A society of the user, a concierge, and a steward, with one skill proposal waiting on the user.
 * Decisions and the pause switch change the fake's state the way the board would. With `archived`,
 * an archived project sits beside lab and desk asks to archive lab too. With `asks`, the user has
 * asked twice before; a new ask opens a thread in asks, and desk is in a turn on it once posted.
 * With `enrolling`, a runner waits for approval under `ENROLLING_CODE`. With `github`, the board
 * offers GitHub sign-in and the token is octocat's sign-in, and with `signedOut` the browser
 * starts with no token. With `inFlight`,
 * desk is in a turn at the society until the user stops it.
 */
export async function fakeBoard(
  page: Page,
  options: {
    asked?: boolean;
    archived?: boolean;
    asks?: boolean;
    enrolling?: boolean;
    github?: boolean;
    signedOut?: boolean;
    inFlight?: boolean;
  } = {},
): Promise<FakeBoard> {
  let inFlight = options.inFlight === true;
  const archived = options.archived === true;
  const asks = options.asks === true ? askFixtures() : new Map<string, AskFixture>();
  let answering: string | null = null;
  const writes: Write[] = [];
  let refusal: string | null = null;
  let paused = false;
  let deskModel: string | null = null;
  let deskRunner: string | null = "pod";
  let deskEffort: string | null = null;
  // Removing a society topic takes it off the list, as the board does.
  let societyTopics = [SOCIETY_TOPIC];
  // Renaming changes the name the board shows, never the slug.
  let lab = PROJECT;
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

  let enrolling = options.enrolling === true;
  const enrollment = {
    userCode: ENROLLING_CODE,
    hostname: "Studio.local",
    os: "darwin",
    clis: ["claude"],
    capabilities: ["gpu"],
    version: "0.1.0",
    requestedAt: CREATED,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  if (options.signedOut !== true) {
    await page.addInitScript((token) => localStorage.setItem("stellaris.token", token), TOKEN);
  }
  await page.route("**/auth/config", (route) => json(route, { github: options.github === true }));
  await page.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: Buffer.from(PLOT_PNG, "base64") }),
  );
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
          return json(
            route,
            member("desk", "concierge", ["lab"], deskModel, deskRunner, deskEffort),
          );
        case "/api/verbs/configure_project":
          lab = {
            ...lab,
            ...(typeof body["name"] === "string" ? { name: body["name"] } : {}),
            ...(typeof body["default_branch"] === "string"
              ? { defaultBranch: body["default_branch"] }
              : {}),
          };
          return json(route, lab);
        case "/api/verbs/remove_knowledge":
          societyTopics = societyTopics.filter((topic) => topic.topic !== body["topic"]);
          return json(route, {
            topic: body["topic"],
            project: null,
            removedBy: "user",
            removedAt: "2026-10-09T10:00:00.000Z",
          });
        case "/api/agents/desk/effort":
          deskEffort = typeof body["effort"] === "string" ? body["effort"] : null;
          return json(
            route,
            member("desk", "concierge", ["lab"], deskModel, deskRunner, deskEffort),
          );
        case "/api/agents/desk/runner":
          deskRunner = typeof body["runner"] === "string" ? body["runner"] : null;
          return json(
            route,
            member("desk", "concierge", ["lab"], deskModel, deskRunner, deskEffort),
          );
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
        case `/api/enrollments/${ENROLLING_CODE}/approve`:
          enrolling = false;
          return json(route, {
            name: body["name"],
            os: "darwin",
            clis: [],
            capabilities: [],
            status: "disconnected",
          });
        case `/api/enrollments/${ENROLLING_CODE}/deny`:
          enrolling = false;
          return json(route, { denied: true });
        case `/api/turns/${DESK_TURN_IN_FLIGHT}/stop`:
          if (!inFlight) {
            return json(route, { message: "the turn is not in flight" }, 404);
          }
          inFlight = false;
          return json(route, { stopped: true });
        default:
          return json(route, { message: `no fake for ${pathname}` }, 404);
      }
    }
    if (pathname === "/api/metrics") {
      return json(route, metrics(new URL(request.url()).searchParams.get("window") ?? "7d"));
    }
    const files = `/api/tasks/${STAGE_TASK}/files`;
    if (pathname === files || pathname.startsWith(`${files}/`)) {
      const file = TASK_FILES[decodeURIComponent(pathname.slice(files.length + 1))];
      return file === undefined
        ? json(route, { error: "NOT_FOUND", message: "not on the branch" }, 404)
        : json(route, file);
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
        return json(route, {
          name: "user",
          role: "user",
          ...(options.github === true
            ? {
                signIn: {
                  login: "octocat",
                  avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
                },
              }
            : {}),
        });
      case "/api/society":
        return json(route, {
          name: "fixture",
          version: 1,
          createdAt: CREATED,
          channels: ["general", "governance", "asks"],
        });
      case "/api/members":
        return json(route, [
          member("desk", "concierge", ["lab"], deskModel, deskRunner, deskEffort),
          member("stew", "steward", [], null, null),
        ]);
      case "/api/runners":
        return json(route, [
          {
            name: "pod",
            os: "linux",
            clis: ["claude", "codex"],
            capabilities: [],
            status: "connected",
          },
          {
            name: "laptop",
            os: "darwin",
            clis: ["claude"],
            capabilities: ["gpu"],
            status: "disconnected",
          },
        ]);
      case "/api/agents/desk/models":
        return json(route, { runner: "pod", cli: "claude", models: CLAUDE_MODELS });
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
      case "/api/agents/desk/history":
        return json(route, DESK_HISTORY);
      case `/api/agents/desk/history/${DESK_TURN_COMMIT}`:
        return json(route, DESK_TURN_CHANGE);
      case "/api/agents/desk/conflicts":
        return json(route, [
          {
            path: "memory/core.md.conflict-0000ABCD",
            file: "memory/core.md",
            since: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          },
        ]);
      case "/api/projects/lab/dashboard":
        return json(route, { data: {}, body: "# Lab dashboard\n\nThroughput is steady." });
      case "/api/projects/lab/knowledge":
        return json(route, [LAB_TOPIC]);
      case "/api/society/knowledge":
        return json(route, societyTopics);
      case "/api/roles":
        return json(route, [
          role("concierge", ["user_post"], true),
          role("steward", ["ops_event"]),
        ]);
      case "/api/projects":
        return json(route, archived ? [lab, ARCHIVED_PROJECT] : [lab]);
      case "/api/projects/lab/tasks":
        return json(route, [TASK]);
      case `/api/tasks/${STAGE_TASK}`:
        return json(route, TASK);
      case `/api/tasks/${STAGE_TASK}/changes`:
        return json(route, TASK_CHANGES);
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
      case "/api/channels/asks":
        return json(route, []);
      case "/api/scheduler":
        return json(route, {
          paused,
          running: [
            ...(answering === null ? [] : [`desk/society/${answering}`]),
            ...(inFlight ? ["desk/society"] : []),
          ],
          pending: [],
          resident: [],
          signals: ["role_gap:lab:referee"],
          turns: inFlight
            ? [
                {
                  turnId: DESK_TURN_IN_FLIGHT,
                  agent: "desk",
                  scope: "society",
                  cli: "claude",
                  channel: "general",
                  steerable: true,
                  stoppable: true,
                },
              ]
            : [],
        });
      case "/api/signals":
        return json(route, SIGNALS);
      case "/api/enrollments":
        return json(route, enrolling ? [enrollment] : []);
      case "/api/channels":
        return json(route, [
          channel("general"),
          channel("governance"),
          channel("asks"),
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
