import { crc32, deflateSync } from "node:zlib";
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
  skillFiles?: Record<string, unknown>;
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

/** One post in lab's general, a minute after the task's thread opened there. */
function labPost(minute: number, author: string, body: string, notice?: unknown) {
  return {
    id: `01M3Q2MMMMMMMMMMMMMMMMMM${String(minute).padStart(2, "0")}`,
    author,
    channel: "lab/general",
    ts: new Date(Date.parse(CREATED) + minute * 60_000).toISOString(),
    mentions: [],
    body,
    ...(notice === undefined ? {} : { notice }),
  };
}

const EXPERIMENTS = { kind: "knowledge", topic: "experiments", project: "lab" };

/** lab's general: talk, and the notes knowledge verbs posted. */
const LAB_GENERAL = [
  labPost(1, "ada", "Seeds are fixed at 42 from now on."),
  labPost(2, "ada", "Knowledge written: experiments. It is under knowledge/experiments.md.", {
    ...EXPERIMENTS,
    action: "written",
  }),
  labPost(3, "ref", "Knowledge updated: experiments. It is under knowledge/experiments.md.", {
    ...EXPERIMENTS,
    action: "updated",
  }),
  labPost(4, "ada", "Knowledge updated: experiments. It is under knowledge/experiments.md.", {
    ...EXPERIMENTS,
    action: "updated",
  }),
  labPost(5, "ref", "Thanks, the harness reads it."),
  labPost(
    6,
    "ref",
    "Knowledge removed: old-harness. It is no longer under knowledge/old-harness.md.",
    {
      kind: "knowledge",
      action: "removed",
      topic: "old-harness",
      project: "lab",
    },
  ),
];

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

/** A stage as the fake board keeps it. */
interface FakeStage {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly agent?: string;
  readonly gate: boolean;
  readonly holders: readonly string[];
  readonly completedBy?: string;
  readonly completedAt?: string;
}

const TASK_STAGES: readonly FakeStage[] = [
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
];

/** A study whose gated sign-off stage names the user, landing through its pull request. */
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
  stages: TASK_STAGES,
  stage: "s2",
  stageSince: CREATED,
  stageSeq: 2,
  onDone: "ghpr",
  pullRequest: {
    url: "https://github.com/acme/lab/pull/7",
    number: 7,
    subject: "feat: compare shortest-path algorithms",
    body: "Tabulates twelve methods.\n\nCo-Authored-By: ada <ada@x>",
    linkedBy: "ada",
    linkedAt: CREATED,
  },
  completing: false,
  body: "Survey the field and tabulate the methods.",
};

type FakeTask = Omit<typeof TASK, "pullRequest"> & { pullRequest?: (typeof TASK)["pullRequest"] };

/** The study before its author linked the pull request it lands through. */
function unlinkedTask(): FakeTask {
  const { pullRequest: _linked, ...task } = TASK;
  return task;
}

/** The same, with a check that names the user before Sign off, waiting on the user now. */
function earlyApprovalTask(): FakeTask {
  const check: FakeStage = { id: "s3", name: "Check", agent: "user", gate: true, holders: [] };
  return {
    ...unlinkedTask(),
    stages: [...TASK_STAGES.slice(0, 1), check, ...TASK_STAGES.slice(1)],
    stage: "s3",
  };
}

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

/** An image ada uploaded to the board, and an id that names none. */
export const UPLOADED_IMAGE = "01M3Q2RRRRRRRRRRRRRRRRRRR1";
export const MISSING_IMAGE = "01M3Q2RRRRRRRRRRRRRRRRRRR2";

/** A PNG chunk: its length, its type, its data, and the checksum of type and data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG of the given size, a gradient under a grid, so it reads as a picture once enlarged. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // Eight bits a channel, truecolor, the standard compression, filter, and no interlace.
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const grid = x % 100 < 2 || y % 100 < 2;
      rows.set(
        grid ? [70, 80, 110] : [20 + (x * 60) / width, 30 + (y * 60) / height, 60],
        row + 1 + x * 3,
      );
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The sizes of the screenshot ada uploaded, a window's, and of the one on the web, a phone's. */
export const SCREENSHOT_SIZE = { width: 1600, height: 1000 };
export const PHONE_SIZE = { width: 600, height: 1400 };
export const PHONE_URL = "https://images.example.test/survey-phone.png";

/**
 * ada's screenshots in the task's thread, with `uploads`: one the board has, one it does not, and
 * one on the web.
 */
const SCREENSHOTS = {
  id: "01M3Q2AAAAAAAAAAAAAAAAAAB2",
  author: "ada",
  channel: "lab/general",
  thread: STAGE_TASK,
  ts: CREATED,
  mentions: [],
  body: `The survey page before the change: ![The survey page, before](image:${UPLOADED_IMAGE})\n\nAnd after: ![The survey page, after](image:${MISSING_IMAGE})\n\nOn a phone: ![The survey page on a phone](${PHONE_URL})`,
};

/** Where the web images of ada's other post live: a vector with no size of its own, and nothing. */
export const VECTOR_URL = "https://images.example.test/shape.svg";
export const BROKEN_URL = "https://images.example.test/gone.png";
export const BADGE_TARGET = "https://ci.example.test/runs";

/**
 * ada's other images in the task's thread, with `uploads`: one inside a link, as a README's badge
 * is, a vector, one that fails to load, one with no description, and two inside links to a
 * proposal and to a file on the task's branch.
 */
const IMAGE_EDGES = {
  id: "01M3Q2AAAAAAAAAAAAAAAAAAB3",
  author: "ada",
  channel: "lab/general",
  thread: STAGE_TASK,
  ts: CREATED,
  mentions: [],
  body: `Badge: [![The badge](${PHONE_URL})](${BADGE_TARGET})\n\nVector: ![The vector picture](${VECTOR_URL})\n\nBroken: ![The broken picture](${BROKEN_URL})\n\nUnnamed: ![](${PHONE_URL})\n\nOn the board: [![The proposal's mark](${VECTOR_URL})](/proposal/${SKILL_PROPOSAL}) and [![The report's mark](${VECTOR_URL})](/home/tiger/runner-data/worktrees/ada/.tasks/${STAGE_TASK}/docs/report.md)`,
};

/** The same screenshot in lab's general, with `uploads`. */
const CHANNEL_SCREENSHOT = labPost(
  7,
  "ada",
  `The survey page as it ships: ![The survey page in lab](image:${UPLOADED_IMAGE})`,
);

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

/** What the survey's branch did to each file it changed, as the task's runner reads it. */
const TASK_DIFFS: Readonly<Record<string, unknown>> = {
  "docs/plot.png": {
    head: TASK_COMMIT,
    path: "docs/plot.png",
    status: "added",
    patch: null,
    truncated: false,
  },
  "docs/report.md": {
    head: TASK_COMMIT,
    path: "docs/report.md",
    status: "added",
    patch:
      "@@ -0,0 +1,7 @@\n+# Shortest paths\n+\n+Dijkstra wins on sparse graphs.\n+\n+![Runtime by graph size](plot.png)\n+\n+The raw numbers are in [the table](../results.csv).",
    truncated: false,
  },
  "draft.md": {
    head: TASK_COMMIT,
    path: "draft.md",
    status: "deleted",
    patch: "@@ -1,4 +0,0 @@\n-# Draft\n-\n-Bellman-Ford first.\n-Then the rest.",
    truncated: false,
  },
  "results.csv": {
    head: TASK_COMMIT,
    path: "results.csv",
    status: "modified",
    patch: '@@ -1,2 +1,3 @@\n method,runtime\n-Dijkstra,1.4\n+Dijkstra,1.2\n+"A*, tuned",0.9',
    truncated: false,
  },
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
  revision: 3,
  updatedBy: "ada",
  updatedAt: CREATED,
  body: `Every run fixes its seed at 42.\n\nThe harness lives in \`bench/\`.\n\nTask ${STAGE_TASK} settled the seed; its branch is task/${STAGE_TASK}.`,
};

const SOCIETY_TOPIC = {
  topic: "code-comments",
  project: null,
  revision: 1,
  updatedBy: "stew",
  updatedAt: CREATED,
  body: "Comment only what the code cannot say.",
};

/** A skill promoted to the society, which opens from the society's overview and is removed from its pane. */
const SOCIETY_SKILL = {
  name: "uv-setup",
  summary: "Set up a uv project with locked dependencies",
  scope: "society",
  path: "/data/society/skills/uv-setup/SKILL.md",
};

/** The society skill's folder as it is published: its SKILL.md, a reference, and a script. */
const SOCIETY_SKILL_FILES = [
  {
    path: "SKILL.md",
    size: 140,
    executable: false,
    text: "---\nname: uv-setup\ndescription: Set up a uv project with locked dependencies\n---\n\n# uv setup\n\nRun scripts/check.sh before the first commit.\n",
    truncated: false,
  },
  {
    path: "references/flags.md",
    size: 18,
    executable: false,
    text: "# Flags\n\n--locked\n",
    truncated: false,
  },
  {
    path: "scripts/check.sh",
    size: 27,
    executable: true,
    text: "#!/bin/sh\nuv sync --locked\n",
    truncated: false,
  },
];

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

/** A skill proposal's folder as the board took it: its SKILL.md and a script beside it. */
const SKILL_FILES = [
  {
    path: "SKILL.md",
    size: 96,
    executable: false,
    text: "---\nname: refereed-research\ndescription: Plan a research task.\n---\n\n# Refereed research\n\nRun scripts/plan.sh first.\n",
    truncated: false,
  },
  {
    path: "scripts/plan.sh",
    size: 31,
    executable: true,
    text: "#!/bin/sh\necho stages: work review\n",
    truncated: false,
  },
];

/** The skill proposal's pitch, which opened its thread in governance. */
const PITCH = {
  id: "01M3Q2CCCCCCCCCCCCCCCCCCC1",
  author: "stew",
  channel: "governance",
  thread: SKILL_PROPOSAL,
  ts: CREATED,
  mentions: [],
  body: `Proposal ${SKILL_PROPOSAL}: skill refereed-research.\n\nThe plan has run on four tasks. It follows ada's message ${HANDOVER.id}.`,
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

/**
 * Each citizen's tokens over a window: desk's one counted turn in the last day, as its Turns tab
 * lists it; over the week two more of its turns without a count, and stew's two with none; over
 * the whole log a second counted turn of each, and in a crowded society hal's two.
 */
function tokens(window: string, crowded: boolean) {
  const counted = DESK_TURN.usage;
  const more = {
    inputTokens: 2_000,
    outputTokens: 40_000,
    cacheReadTokens: 7_200_000,
    cacheWriteTokens: 0,
  };
  const sum = (a: typeof counted, b: typeof counted) => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  });
  const citizens =
    window === "24h"
      ? [{ agent: "desk", turns: 1, withUsage: 1, usage: counted }]
      : window === "7d"
        ? [
            { agent: "desk", turns: 3, withUsage: 1, usage: counted },
            { agent: "stew", turns: 2, withUsage: 0, usage: null },
          ]
        : [
            { agent: "desk", turns: 4, withUsage: 2, usage: sum(counted, more) },
            { agent: "stew", turns: 3, withUsage: 1, usage: more },
            // hal writes more than the others, so its out count is the widest.
            ...(crowded
              ? [
                  {
                    agent: "hal",
                    turns: 2,
                    withUsage: 2,
                    usage: {
                      inputTokens: 10_000,
                      outputTokens: 1_500_000,
                      cacheReadTokens: 940_000,
                      cacheWriteTokens: 0,
                    },
                  },
                ]
              : []),
          ];
  return {
    window,
    since:
      window === "all"
        ? null
        : window === "7d"
          ? "2026-09-22T09:05:00.000Z"
          : "2026-09-28T09:05:00.000Z",
    until: "2026-09-29T09:05:00.000Z",
    citizens,
  };
}

/** ada's two counted turns, before it retired. */
const RETIRED_TOKENS = {
  agent: "ada",
  turns: 2,
  withUsage: 2,
  usage: { inputTokens: 40, outputTokens: 900, cacheReadTokens: 88_000, cacheWriteTokens: 0 },
};

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
  /** Puts this many citizens in a turn at lab, and this many turns in the queue. */
  setWorking(running: number, queued?: number): void;
}

/** The citizens `setWorking` puts in turns, in order. */
const WORKERS = ["ada", "bo", "cy", "di", "eve", "fay", "gus", "hal", "ivo", "jo"];

/** desk's crons: a morning digest at home, a check in the task's thread whose turns keep failing, and stew's, ended. */
export const DIGEST_CRON = "01M3Q2CRNAAAAAAAAAAAAAAAA1";
export const FAILING_CRON = "01M3Q2CRNAAAAAAAAAAAAAAAA2";
const ENDED_CRON = "01M3Q2CRNAAAAAAAAAAAAAAAA3";

function cronFixtures(): Array<Record<string, unknown>> {
  return [
    {
      id: DIGEST_CRON,
      title: "Morning digest",
      agent: "desk",
      scope: "society",
      schedule: { cron: "0 9 * * 1-5" },
      createdBy: "user",
      createdAt: CREATED,
      since: CREATED,
      lastFiredAt: "2026-10-09T09:00:00.000Z",
      lastRun: { turnId: DESK_TURN_ID, at: "2026-10-09T09:01:00.000Z", outcome: "completed" },
      failures: 0,
      note: "Summarize what changed overnight in **general**, once cron 01M3Q2CRNAAAAAAAAAAAAAAAA2 has run.",
    },
    {
      id: FAILING_CRON,
      title: "Check the build",
      agent: "desk",
      scope: "lab",
      thread: STAGE_TASK,
      schedule: { cron: "0 * * * *", timezone: "Europe/Berlin" },
      createdBy: "desk",
      createdAt: CREATED,
      since: CREATED,
      failures: 3,
      note: "Run the build and say what broke.",
    },
    {
      id: ENDED_CRON,
      title: "Watch the backlog",
      agent: "stew",
      scope: "society",
      schedule: { at: "2026-10-01T09:00:00.000Z" },
      createdBy: "stew",
      createdAt: CREATED,
      since: CREATED,
      failures: 0,
      ended: { at: "2026-10-01T09:00:00.000Z", by: "board", reason: "fired once, as set" },
      note: "Look at the backlog once more.",
    },
  ];
}

/** A time this many minutes from now, or ago when negative, for quota reports. */
function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * Claude's quota as a turn reported it: 5-hour and 7-day windows, used this much, and the weekly
 * window of one model, which the CLI names.
 */
function claudeQuota(observedAgo: number, fiveHour: number, limited = false) {
  const observedAt = minutesFromNow(-observedAgo);
  return {
    observedAt,
    source: "turn",
    status: limited ? "limited" : "allowed",
    limitedUntil: limited ? minutesFromNow(40) : null,
    limitedBy: limited ? "five_hour" : null,
    plan: "max",
    windows: [
      {
        key: "five_hour",
        minutes: 300,
        usedPercent: fiveHour,
        resetsAt: minutesFromNow(limited ? 40 : 290),
        observedAt,
      },
      {
        key: "seven_day",
        minutes: 10_080,
        usedPercent: 12,
        resetsAt: minutesFromNow(8_620),
        observedAt,
      },
      {
        key: "model:Fable",
        label: "Fable",
        minutes: 10_080,
        usedPercent: 9,
        resetsAt: minutesFromNow(8_620),
        observedAt,
      },
    ],
    credits: null,
    extraUsage: null,
  };
}

/** Codex's quota as a read gave it: one weekly window, the plan, and credits. */
function codexQuota(observedAgo: number) {
  const observedAt = minutesFromNow(-observedAgo);
  return {
    observedAt,
    source: "read",
    status: "allowed",
    limitedUntil: null,
    limitedBy: null,
    plan: "pro",
    windows: [
      {
        key: "primary",
        minutes: 10_080,
        usedPercent: 2,
        resetsAt: minutesFromNow(9_670),
        observedAt,
      },
    ],
    credits: { hasCredits: true, unlimited: false, balance: "1250.5" },
    extraUsage: null,
  };
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
 * desk is in a turn at the society until the user stops it. The skill proposal is a folder the
 * board took from stew's home, with a script beside its SKILL.md. Each runner's CLIs
 * reported their quotas minutes ago, laptop's Claude with the same numbers as pod's and studio's
 * with its own; with
 * `quotas: "reads"`, pod's Claude numbers are old and its Codex never reported, so opening the
 * runners view reads both, and pod answers Codex's read as a runner from before quota reads; with
 * `quotas: "limited"`, pod's Claude is limited for 40 minutes. With `uploads`, ada shows three
 * screenshots in the task's thread, one of them an image the board does not have and one on the
 * web, a post of web images in shapes that stay plain or size themselves, and the screenshot the
 * board has in lab's general.
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
    quotas?: "reads" | "limited";
    uploads?: boolean;
    /** Links no pull request to the study whose sign-off names the user. */
    unlinked?: boolean;
    /** Links none either, and puts a check naming the user before Sign off, current. */
    earlyApproval?: boolean;
    /** Adds ada, a researcher retired after two counted turns. */
    retired?: boolean;
    /**
     * Gives desk a model set apart from the one it reports, an effort, four projects, and turns on
     * two runners named as the chart names its pods, stew one of them, and adds hal, an
     * investigator, on the other, whose counts over all time are the widest out, so rows in the
     * Citizens list run out of room.
     */
    crowded?: boolean;
  } = {},
): Promise<FakeBoard> {
  let inFlight = options.inFlight === true;
  const archived = options.archived === true;
  const asks = options.asks === true ? askFixtures() : new Map<string, AskFixture>();
  let answering: string | null = null;
  const writes: Write[] = [];
  let refusal: string | null = null;
  let paused = false;
  let working: string[] = [];
  let queued: string[] = [];
  const podQuotas: Record<string, unknown> =
    options.quotas === "reads"
      ? { claude: claudeQuota(20, 35) }
      : options.quotas === "limited"
        ? { claude: claudeQuota(3, 100, true), codex: codexQuota(3) }
        : { claude: claudeQuota(3, 35), codex: codexQuota(3) };
  // studio's own login, with numbers of its own, reported as fresh as pod's.
  const studioQuotas: Record<string, unknown> = { claude: claudeQuota(4, 20) };
  // laptop's, taken with pod's, so their resets match to the minute whenever the view asks.
  const laptopQuotas = { claude: claudeQuota(120, 35) };
  const crowded = options.crowded === true;
  const deskProjects = crowded ? ["lab", "atlas", "beacon", "comet"] : ["lab"];
  let deskModel: string | null = crowded ? "opus" : null;
  let deskRunner: string | null = crowded ? "stellaris-runner-0" : "pod";
  let deskEffort: string | null = crowded ? "xhigh" : null;
  // Removing a society topic or skill takes it off the list, as the board does.
  let societyTopics = [SOCIETY_TOPIC];
  let societySkills = [SOCIETY_SKILL];
  // Crons pause, resume, end, and are set as the board would, and the society's zone is the user's.
  const crons = cronFixtures();
  let timezone = "UTC";
  const cronById = (id: unknown) => crons.find((each) => each["id"] === id);
  // Renaming changes the name the board shows, never the slug.
  let lab = crowded ? { ...PROJECT, runner: "stellaris-runner-1" } : PROJECT;
  // Approving its last stage sets the task landing, as the board does for a ghpr task.
  let task: FakeTask =
    options.earlyApproval === true
      ? earlyApprovalTask()
      : options.unlinked === true
        ? unlinkedTask()
        : TASK;
  // Channels opened in lab beside its general, and their archives, as the board keeps them.
  const labChannels: Array<{
    name: string;
    archived?: { name: string; at: string; by: string; reason: string };
  }> = [];
  // With `asked`, ada's question waits in the task's thread until the user writes there.
  let waitingAsk = options.asked === true;
  const screenshot =
    options.uploads === true ? png(SCREENSHOT_SIZE.width, SCREENSHOT_SIZE.height) : Buffer.alloc(0);
  const threadMessages: Array<Record<string, unknown>> = [
    HANDOVER,
    ...(options.uploads === true ? [SCREENSHOTS, IMAGE_EDGES] : []),
    ...(waitingAsk ? [ASK] : []),
  ];
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
    },
    skillFiles: {
      commit: "4f1c2d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e",
      takenAt: CREATED,
      files: SKILL_FILES.map(({ text: _text, truncated: _cut, ...file }) => file),
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
  if (options.uploads === true) {
    const phone = png(PHONE_SIZE.width, PHONE_SIZE.height);
    await page.route(PHONE_URL, (route) =>
      route.fulfill({ contentType: "image/png", body: phone }),
    );
    await page.route(VECTOR_URL, (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="teal"/></svg>',
      }),
    );
    await page.route(BROKEN_URL, (route) => route.fulfill({ status: 404, body: "" }));
  }
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() !== "GET") {
      const body: Record<string, unknown> = request.postDataJSON() ?? {};
      writes.push({ path: pathname, body });
      switch (pathname) {
        case "/api/runners/pod/quota/claude":
          podQuotas["claude"] = { ...claudeQuota(0, 41), source: "read" };
          return json(route, podQuotas["claude"]);
        case "/api/runners/studio/quota/claude":
          studioQuotas["claude"] = { ...claudeQuota(0, 20), source: "read" };
          return json(route, studioQuotas["claude"]);
        case "/api/runners/pod/quota/codex":
          if (options.quotas === "reads") {
            return json(
              route,
              { error: "INVALID_STATE", message: "runner pod cannot read quotas yet; upgrade it" },
              409,
            );
          }
          podQuotas["codex"] = codexQuota(0);
          return json(route, podQuotas["codex"]);
        case "/api/verbs/approve":
          return decide(route, "approved", body);
        case "/api/verbs/reject":
          return decide(route, "rejected", body);
        case "/api/agents/desk/model":
          deskModel = typeof body["model"] === "string" ? body["model"] : null;
          return json(
            route,
            member("desk", "concierge", deskProjects, deskModel, deskRunner, deskEffort),
          );
        case "/api/verbs/advance_task":
          task = {
            ...task,
            stages: task.stages.map((stage) =>
              stage.id === task.stage
                ? { ...stage, holders: ["user"], completedBy: "user", completedAt: CREATED }
                : stage,
            ),
            completing: true,
          };
          return json(route, task);
        case "/api/verbs/configure_project":
          lab = {
            ...lab,
            ...(typeof body["name"] === "string" ? { name: body["name"] } : {}),
            ...(typeof body["default_branch"] === "string"
              ? { defaultBranch: body["default_branch"] }
              : {}),
          };
          return json(route, lab);
        case "/api/verbs/create_channel": {
          if (refusal !== null) {
            const message = refusal;
            refusal = null;
            return json(route, { message }, 409);
          }
          labChannels.push({ name: String(body["name"]) });
          return json(route, `lab/${String(body["name"])}`);
        }
        case "/api/verbs/archive_channel": {
          const name = String(body["channel"]).slice("lab/".length);
          const ended = {
            name,
            at: "2026-10-09T10:00:00.000Z",
            by: "user",
            reason: String(body["reason"]),
          };
          labChannels.splice(
            labChannels.findIndex((each) => each.name === name),
            1,
            { name, archived: ended },
          );
          return json(route, ended);
        }
        case "/api/verbs/create_cron": {
          const { cron, timezone: zone, at, project, ...rest } = body;
          const created = {
            ...rest,
            id: `01M3Q2CRNBBBBBBBBBBBBBBBB${crons.length}`,
            scope: project ?? "society",
            schedule:
              typeof at === "string"
                ? { at }
                : { cron, ...(typeof zone === "string" ? { timezone: zone } : {}) },
            createdBy: "user",
            createdAt: "2026-10-10T10:00:00.000Z",
            since: "2026-10-10T10:00:00.000Z",
            failures: 0,
          };
          crons.push(created);
          return json(route, created);
        }
        case "/api/verbs/update_cron": {
          const cron = cronById(body["cron_id"]);
          if (cron === undefined) {
            return json(route, { message: "no such cron" }, 404);
          }
          if (body["paused"] === true) {
            cron["paused"] = { at: "2026-10-10T10:00:00.000Z", by: "user" };
          } else {
            delete cron["paused"];
            cron["since"] = "2026-10-10T10:00:00.000Z";
          }
          return json(route, cron);
        }
        case "/api/verbs/remove_cron": {
          const cron = cronById(body["cron_id"]);
          if (cron === undefined) {
            return json(route, { message: "no such cron" }, 404);
          }
          cron["ended"] = { at: "2026-10-10T10:00:00.000Z", by: "user", reason: body["reason"] };
          return json(route, cron);
        }
        case "/api/society/timezone":
          timezone = String(body["timezone"]);
          return json(route, {
            name: "fixture",
            version: 1,
            createdAt: CREATED,
            channels: ["general", "governance", "asks"],
            timezone,
          });
        case "/api/verbs/remove_knowledge":
          societyTopics = societyTopics.filter((topic) => topic.topic !== body["topic"]);
          return json(route, {
            topic: body["topic"],
            project: null,
            removedBy: "user",
            removedAt: "2026-10-09T10:00:00.000Z",
          });
        case "/api/verbs/remove_skill":
          societySkills = societySkills.filter((skill) => skill.name !== body["name"]);
          return json(route, {
            name: body["name"],
            reason: body["reason"],
            removedBy: "user",
            removedAt: "2026-10-09T10:00:00.000Z",
          });
        case "/api/agents/desk/effort":
          deskEffort = typeof body["effort"] === "string" ? body["effort"] : null;
          return json(
            route,
            member("desk", "concierge", deskProjects, deskModel, deskRunner, deskEffort),
          );
        case "/api/agents/desk/runner":
          deskRunner = typeof body["runner"] === "string" ? body["runner"] : null;
          return json(
            route,
            member("desk", "concierge", deskProjects, deskModel, deskRunner, deskEffort),
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
    if (pathname === "/api/messages") {
      // Where each message the text names is, as the board finds it.
      const ids = (new URL(request.url()).searchParams.get("ids") ?? "").split(",");
      const known: Array<{
        id: string;
        author: string;
        channel: string;
        ts: string;
        thread?: string;
      }> = [HANDOVER, PITCH, ...LAB_GENERAL];
      return json(
        route,
        known
          .filter((message) => ids.includes(message.id))
          .map((message) => ({
            id: message.id,
            author: message.author,
            channel: message.channel,
            ...(message.thread === undefined ? {} : { thread: message.thread }),
            ts: message.ts,
          })),
      );
    }
    if (pathname === "/api/tokens") {
      const use = tokens(new URL(request.url()).searchParams.get("window") ?? "24h", crowded);
      return json(
        route,
        options.retired === true && use.window === "all"
          ? { ...use, citizens: [RETIRED_TOKENS, ...use.citizens] }
          : use,
      );
    }
    if (pathname === "/api/metrics") {
      return json(route, metrics(new URL(request.url()).searchParams.get("window") ?? "7d"));
    }
    if (pathname.startsWith("/api/images/")) {
      return pathname === `/api/images/${UPLOADED_IMAGE}`
        ? route.fulfill({ contentType: "image/png", body: screenshot })
        : json(route, { error: "NOT_FOUND", message: "image not found" }, 404);
    }
    const files = `/api/tasks/${STAGE_TASK}/files`;
    if (pathname === files || pathname.startsWith(`${files}/`)) {
      const file = TASK_FILES[decodeURIComponent(pathname.slice(files.length + 1))];
      return file === undefined
        ? json(route, { error: "NOT_FOUND", message: "not on the branch" }, 404)
        : json(route, file);
    }
    const diffs = `/api/tasks/${STAGE_TASK}/diff/`;
    if (pathname.startsWith(diffs)) {
      const diff = TASK_DIFFS[decodeURIComponent(pathname.slice(diffs.length))];
      return diff === undefined
        ? json(route, { error: "NOT_FOUND", message: "the branch did not change it" }, 404)
        : json(route, diff);
    }
    if (labChannels.some((each) => pathname === `/api/channels/lab/${each.name}`)) {
      return json(route, []);
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
          timezone,
        });
      case "/api/crons":
        return json(route, crons);
      case "/api/members":
        return json(route, [
          member("desk", "concierge", deskProjects, deskModel, deskRunner, deskEffort),
          member("stew", "steward", [], null, crowded ? "stellaris-runner-0" : null),
          ...(crowded ? [member("hal", "investigator", [], null, "stellaris-runner-1")] : []),
          ...(options.retired === true
            ? [{ ...member("ada", "researcher"), status: "retired", retiredAt: CREATED }]
            : []),
        ]);
      case "/api/version":
        return json(route, { version: "0.3.11" });
      case "/api/runners":
        return json(route, [
          {
            name: "pod",
            os: "linux",
            clis: ["claude", "codex"],
            capabilities: [],
            version: "0.3.11",
            gitIdentityMissing: ["email"],
            status: "connected",
            quotas: podQuotas,
          },
          {
            name: "studio",
            os: "darwin",
            clis: ["claude"],
            capabilities: [],
            version: "0.3.11",
            gitIdentityMissing: [],
            status: "connected",
            quotas: studioQuotas,
          },
          {
            name: "laptop",
            os: "darwin",
            clis: ["claude"],
            capabilities: ["gpu"],
            version: "0.3.10",
            status: "disconnected",
            quotas: laptopQuotas,
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
        return json(route, {
          project: "lab",
          revision: 3,
          body: "# Lab dashboard\n\nThroughput is steady.",
        });
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
        return json(route, [task]);
      case `/api/tasks/${STAGE_TASK}`:
        return json(route, task);
      case `/api/tasks/${STAGE_TASK}/changes`:
        return json(route, TASK_CHANGES);
      case "/api/projects/iphone/tasks":
      case "/api/projects/iphone/knowledge":
        return json(route, []);
      case "/api/channels/lab/general":
        return json(
          route,
          options.uploads === true ? [...LAB_GENERAL, CHANNEL_SCREENSHOT] : LAB_GENERAL,
        );
      case "/api/projects/iphone/dashboard":
        return json(route, { project: "iphone", revision: 0, body: "" });
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
        return json(route, societySkills);
      case `/api/skills/${SOCIETY_SKILL.name}/files`:
        return societySkills.some((skill) => skill.name === SOCIETY_SKILL.name)
          ? json(route, SOCIETY_SKILL_FILES)
          : json(route, { error: "NOT_FOUND", message: "the society has no skill uv-setup" }, 404);
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
            ...working,
          ],
          pending: queued,
          resident: [],
          signals: ["role_gap:lab:referee"],
          turns: inFlight
            ? [
                {
                  turnId: DESK_TURN_IN_FLIGHT,
                  agent: "desk",
                  scope: "society",
                  cli: "claude",
                  askedIn: "general",
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
          ...labChannels.map((each) => ({
            ...channel(each.name),
            ref: `lab/${each.name}`,
            project: "lab",
            ...(each.archived === undefined ? {} : { archived: each.archived }),
          })),
          ...(archived
            ? [{ ...channel("general"), ref: "iphone/general", project: "iphone", messages: 1 }]
            : []),
        ]);
      case "/api/proposals":
        return json(route, archived ? [proposal, ARCHIVE] : [proposal]);
      case `/api/proposals/${SKILL_PROPOSAL}`:
        return json(route, proposal);
      case `/api/proposals/${SKILL_PROPOSAL}/files`:
        return json(route, SKILL_FILES);
      default:
        return json(route, { message: `no fake for ${pathname}` }, 404);
    }
  });
  return {
    writes,
    refuseNext: (message) => {
      refusal = message;
    },
    setWorking: (running, waiting = 0) => {
      working = WORKERS.slice(0, running).map((name) => `${name}/lab`);
      queued = WORKERS.slice(running, running + waiting).map((name) => `${name}/lab`);
    },
  };
}
