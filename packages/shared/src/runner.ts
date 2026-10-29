import { z } from "zod";
import {
  CliKindSchema,
  GitIdentityPartSchema,
  ModelOptionSchema,
  ProjectSchema,
  RunnerOsSchema,
  type Project,
} from "./board.js";
import {
  ResumeFailureSchema,
  TranscriptEntrySchema,
  TurnExitReasonSchema,
  TurnStatusSchema,
  UsageSchema,
} from "./events.js";
import { IsoDateTimeSchema, NameSchema, UlidSchema } from "./ids.js";
import { ImagePathSchema, ImageTypeSchema } from "./images.js";
import { CliQuotaSchema } from "./quota.js";

/**
 * The runner protocol of docs/plan.md section 7.1. A runner registers, holds one event stream open
 * for what the server sends it, and posts everything it sends back; the server refuses a runner
 * that speaks another protocol version.
 */
export const RUNNER_PROTOCOL = 1;

/**
 * Places in a turn's instructions and prompt that the runner fills with its own paths before the
 * turn starts, since the board never sees a path: the agent's home, the board mirror, and the
 * turn's working directory.
 */
export const PATH_TOKENS = {
  home: "{{stellaris:home}}",
  board: "{{stellaris:board}}",
  worktree: "{{stellaris:worktree}}",
} as const;

/**
 * The board server's address in a job, which each runner fills with the address it reaches the
 * server at, so runners on different networks each give their agents an address that works there.
 */
export const SERVER_TOKEN = "{{stellaris:server}}";

/**
 * Where a turn's prompt reports the state of its workspace, which only the runner knows once it has
 * prepared it: how far its code is behind, and work it holds on no branch. The runner fills it with
 * that section, or with nothing when there is nothing to report.
 */
export const WORKSPACE_TOKEN = "{{stellaris:workspace}}";

/**
 * The folder inside an agent's home where its turns outside any project work, the working
 * directory of those turns: never committed, never shared, so downloads, environments, and other
 * working files stay on the machine that made them.
 */
export const HOME_SCRATCH = "scratch";

/** The largest file a home keeps: a runner leaves larger ones uncommitted, and the board refuses them. */
export const HOME_FILE_LIMIT_BYTES = 8 * 1024 * 1024;

export const RunnerHelloSchema = z.object({
  protocol: z.number().int().positive(),
  version: z.string().min(1),
  os: RunnerOsSchema,
  clis: z.array(CliKindSchema),
  /** The CLIs whose adapter can keep a session warm between turns. */
  residentClis: z.array(CliKindSchema).default([]),
  /** The CLIs whose adapter can take input into a running turn; the server steers only these. */
  steerableClis: z.array(CliKindSchema).default([]),
  /** The CLIs whose adapter can stop a running turn; the server stops only these. */
  stoppableClis: z.array(CliKindSchema).default([]),
  /** Whether the runner answers file reads on its projects' branches; one from before never does. */
  branchReads: z.boolean().default(false),
  /** Whether the runner lists what a branch changed; one from before never does. */
  branchChanges: z.boolean().default(false),
  /** Whether the runner answers a read of a CLI's quota; one from before never does. */
  quotaReads: z.boolean().default(false),
  /** Whether the runner reads an image a turn running there uploads; one from before never does. */
  imageReads: z.boolean().default(false),
  /**
   * Whether the runner carries a project's repository out to another runner and in from one, and
   * removes its copy once the project has moved; one from before never does.
   */
  projectMoves: z.boolean().default(false),
  capabilities: z.array(z.string()).default([]),
  /**
   * What the runner's account lacks of the git identity citizens' own commits carry, checked
   * before each hello outside any repository; empty when it has both. Absent from a runner from
   * before the check, which no default fills in, so the board marks only what a runner reported.
   */
  gitIdentityMissing: z.array(GitIdentityPartSchema).optional(),
  /** Turns the runner runs at once, or null for no limit. */
  slots: z.number().int().positive().nullable(),
  /** Turns the runner is still running, when it registers again; the server fails the rest of its turns. */
  turns: z.array(UlidSchema).default([]),
});
export type RunnerHello = z.infer<typeof RunnerHelloSchema>;
export type RunnerHelloInput = z.input<typeof RunnerHelloSchema>;

export const RunnerWelcomeSchema = z.object({ name: NameSchema, version: z.string() });
export type RunnerWelcome = z.infer<typeof RunnerWelcomeSchema>;

/**
 * A runner without a token asks to be enrolled, describing its machine, which the user sees when
 * approving it on the board. Nothing in it is trusted: approval is the user's, and the runner
 * reports what it really offers when it registers.
 */
export const RunnerEnrollRequestSchema = z.object({
  protocol: z.number().int().positive(),
  version: z.string().min(1).max(64),
  hostname: z.string().min(1).max(253),
  os: RunnerOsSchema,
  clis: z.array(CliKindSchema).max(8),
  capabilities: z.array(z.string().min(1).max(64)).max(32).default([]),
});
export type RunnerEnrollRequest = z.infer<typeof RunnerEnrollRequestSchema>;
export type RunnerEnrollRequestInput = z.input<typeof RunnerEnrollRequestSchema>;

/**
 * An enrollment the server opened: the device code only the runner knows and polls with, and the
 * short user code the user approves on the board.
 */
export const RunnerEnrollmentSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  expiresAt: IsoDateTimeSchema,
  intervalMs: z.number().int().positive(),
});
export type RunnerEnrollment = z.infer<typeof RunnerEnrollmentSchema>;

export const RunnerEnrollPollSchema = z.object({ deviceCode: z.string().min(1) });

/** Where an enrollment stands; an approved one carries the runner's token, once. */
export const RunnerEnrollStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("approved"), name: NameSchema, token: z.string().min(1) }),
  z.object({ status: z.literal("denied") }),
]);
export type RunnerEnrollStatus = z.infer<typeof RunnerEnrollStatusSchema>;

/** An enrollment waiting for the user, as the board shows it: never the device code. */
export const PendingEnrollmentSchema = z.object({
  userCode: z.string().min(1),
  hostname: z.string(),
  os: RunnerOsSchema,
  clis: z.array(CliKindSchema),
  capabilities: z.array(z.string()),
  version: z.string(),
  requestedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});
export type PendingEnrollment = z.infer<typeof PendingEnrollmentSchema>;

/**
 * Where a project's code is: its slug, the origin its repository is first cloned from, or null for
 * a repository started empty, and its default branch. Today a project's repository lives on its
 * runner; a hub would add the URL to fetch from here.
 */
export const ProjectRepoSchema = z.object({
  slug: NameSchema,
  origin: z.string().nullable(),
  defaultBranch: z.string().min(1),
  /**
   * The board lands finished tasks on the default branch, itself or through their pull requests,
   * so the runner lets nothing else move it.
   */
  boardLands: z.boolean(),
});
export type ProjectRepo = z.infer<typeof ProjectRepoSchema>;

export function projectRepo(project: Project): ProjectRepo {
  return {
    slug: project.slug,
    origin: project.repo,
    defaultBranch: project.defaultBranch,
    boardLands: project.onDone !== "none",
  };
}

/**
 * Where a turn works: the agent's home for a society-scope turn; the agent's own worktree of a
 * project, on `agent/<name>`, with the task branches to make sure of first; or the worktree of one
 * task's conversation, on `task/<id>`. With `thread`, a proposal's or a topic's conversation works
 * in a place of its own instead, and with `channel` a channel's conversation other than general,
 * so it runs beside the citizen's other conversations: a folder under the home's scratch folder,
 * or a worktree detached at the tip of the project's default branch. With `place`, a society-scope
 * turn in a project's channels' conversation works in a folder of its own under the scratch folder.
 */
export const TurnWorkspaceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("home"),
    thread: UlidSchema.optional(),
    channel: NameSchema.optional(),
    place: NameSchema.optional(),
  }),
  z.object({
    kind: z.literal("project"),
    repo: ProjectRepoSchema,
    branches: z.array(z.string().min(1)),
    thread: UlidSchema.optional(),
    channel: NameSchema.optional(),
  }),
  z.object({
    kind: z.literal("task"),
    repo: ProjectRepoSchema,
    taskId: UlidSchema,
    /**
     * The citizen holding the task's current stage, when someone does: a turn of anyone else
     * works detached at the branch's tip, so the holder's turns find the branch free.
     */
    holder: NameSchema.optional(),
  }),
]);
export type TurnWorkspace = z.infer<typeof TurnWorkspaceSchema>;

/** Everything one turn needs. Policy, the prompt, the limits, the token, and residency, is the server's. */
export const TurnJobSchema = z.object({
  turnId: UlidSchema,
  agent: NameSchema,
  role: NameSchema,
  cli: CliKindSchema,
  model: z.string().optional(),
  /** The reasoning effort set on the agent; absent for the model's own default. */
  effort: z.string().optional(),
  /** A project slug, or the society scope. */
  scope: NameSchema,
  /** The thread whose conversation the turn is in; absent for the home conversation. */
  thread: UlidSchema.optional(),
  /** The channel, never general, whose conversation the turn is in. */
  channel: NameSchema.optional(),
  /** The project whose channels' conversation the turn is in, for a turn in the society scope. */
  place: NameSchema.optional(),
  /**
   * The session to resume, or null to start one: the CLI's adapter picks a fresh session's id, and
   * the outcome reports it.
   */
  session: z.string().min(1).nullable(),
  /** The running total the session reported after its last turn, which a resumed session starts from. */
  costSoFarUsd: z.number().nonnegative(),
  /**
   * The session's running usage after its last turn, which a resumed session's own usage is
   * measured from. Absent when the board holds none for the session, and from a server from before.
   */
  usageSoFar: UsageSchema.optional(),
  /** The rendered charter, norms, memory core, and skills index, with `PATH_TOKENS` for places. */
  instructions: z.string(),
  /**
   * The hash of `instructions` without the first turn's section (`instructionsHash` in
   * `turn-host`): a warm process started on other instructions starts afresh, so a compaction in
   * it puts back the current ones. Absent from a server from before, when the text is compared.
   */
  instructionsHash: z.string().optional(),
  prompt: z.string(),
  mcp: z.object({ url: z.string().min(1), token: z.string().min(1) }),
  limits: z.object({
    timeoutMs: z.number().int().positive().nullable(),
    maxTurns: z.number().int().positive().nullable(),
  }),
  /** Present when the runner keeps the conversation's session warm between turns, under `key`. */
  resident: z.object({ key: z.string().min(1), idleMs: z.number().int().positive() }).optional(),
  workspace: TurnWorkspaceSchema,
});
export type TurnJob = z.infer<typeof TurnJobSchema>;

/** The work a turn left: the task branch and its commit after the hand-back. */
export const TurnWorkSchema = z.object({ branch: z.string().min(1), head: z.string().min(1) });
export type TurnWork = z.infer<typeof TurnWorkSchema>;

/**
 * Commits a task's worktree holds that the task's branch lacks and that the hand-back could not
 * put on it by a fast-forward, whose worktree belongs to `agent`: the first of them and how many.
 */
export const StuckWorkSchema = z.object({
  branch: z.string().min(1),
  agent: NameSchema,
  commits: z.array(z.string()),
  total: z.number().int().positive(),
});
export type StuckWork = z.infer<typeof StuckWorkSchema>;

export const TurnEventsSchema = z.object({ entries: z.array(TranscriptEntrySchema) });
export type TurnEvents = z.infer<typeof TurnEventsSchema>;

export const TurnOutcomeSchema = z.object({
  exitReason: TurnExitReasonSchema,
  status: TurnStatusSchema.nullable(),
  error: z.string().nullable(),
  usage: UsageSchema,
  costUsd: z.number().nonnegative(),
  /** The session's running total after this turn, for CLIs that report one. */
  sessionCostUsd: z.number().nonnegative().optional(),
  /**
   * The session's running usage after this turn, for CLIs that report one, else the job's
   * `usageSoFar`. A runner from before never sends it.
   */
  sessionUsage: UsageSchema.optional(),
  /**
   * The whole input of the turn's latest model call in the session's own thread, cached or not:
   * how large the session had grown. Sub-agents' calls are left out. A turn that made no call,
   * and a runner from before, never send it.
   */
  contextTokens: z.number().int().nonnegative().optional(),
  /**
   * The session the CLI used, which differs from the job's for CLIs that assign their own ids. A
   * turn whose CLI never started, because it failed or was stopped first, reports the job's own,
   * null in a conversation's first turn, so a session never started is not recorded.
   */
  session: z.string().min(1).nullable(),
  /**
   * Set when the CLI could not resume the job's session, which failed the turn before any model
   * call; the server then drops a `lost` session, and one that failed `retry` too often in a row. A
   * runner from before never sends it.
   */
  resumeFailed: ResumeFailureSchema.optional(),
  /**
   * Set when the model service turned the turn away for now, as when it was overloaded or failed
   * on its side, which the scheduler answers by sending the same wake again within minutes. A
   * runner from before never sends it.
   */
  transient: z.boolean().optional(),
  /** The model the CLI reported, when it reported one. */
  model: z.string().nullable(),
  work: TurnWorkSchema.nullable(),
  /**
   * Whether the turn's own workspace, a thread's, a channel's, or a task's, holds work on no
   * branch after the hand-back: uncommitted changes, or commits no branch contains.
   */
  leftovers: z.boolean().default(false),
  /**
   * Commits the hand-back found its task's worktrees holding that no fast-forward of the task's
   * branch can take, each told once; a runner from before never sends it.
   */
  stuck: z.array(StuckWorkSchema).optional(),
  /**
   * The CLI's plan quota as the turn's stream last reported it, when it reported any; a runner from
   * before never sends it.
   */
  quota: CliQuotaSchema.optional(),
});
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;
export type TurnOutcomeInput = z.input<typeof TurnOutcomeSchema>;

/**
 * The server's answer to an outcome: whether the workspace of the turn's own conversation, a
 * task's, a thread's, or a channel's, may go, because the conversation has ended and the workspace
 * holds nothing on no branch, or a closing turn has decided about what it held.
 */
export const TurnAckSchema = z.object({ dropWorkspace: z.boolean() });
export type TurnAck = z.infer<typeof TurnAckSchema>;

/** A request to land a task: merge its branch into the project's default branch. */
export const LandRequestSchema = z.object({
  repo: ProjectRepoSchema,
  branch: z.string().min(1),
  /**
   * For a `ghpr` task, the pull request to merge in place of the branch, which must hold the
   * branch's files, and the merge commit's subject and body, the pull request's title and an
   * empty body when left out.
   */
  pullRequest: z
    .object({
      url: z.string().min(1),
      subject: z.string().min(1).optional(),
      body: z.string().optional(),
    })
    .optional(),
});
export type LandRequest = z.infer<typeof LandRequestSchema>;

/**
 * A request to close an abandoned `ghpr` task's pull request on GitHub with a comment, and to
 * delete its head branch.
 */
export const CloseRequestSchema = z.object({
  repo: ProjectRepoSchema,
  url: z.string().min(1),
  comment: z.string().min(1),
});
export type CloseRequest = z.infer<typeof CloseRequestSchema>;

/** How a landing or a closing went; `detail` says what happened, or why it did not. */
export const MergeOutcomeSchema = z.object({ ok: z.boolean(), detail: z.string() });
export type MergeOutcome = z.infer<typeof MergeOutcomeSchema>;

export const ModelListSchema = z.array(ModelOptionSchema);

/** The largest file a branch read carries; a larger one comes back with its size alone. */
export const BRANCH_FILE_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * A path inside a branch's tree, with forward slashes, or empty for its root. Every segment is a
 * name: nothing absolute, empty, `.`, or `..`, so a read cannot leave the tree.
 */
export const BranchPathSchema = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value === "" ||
      value
        .split("/")
        .every(
          (segment) =>
            segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\0"),
        ),
    { message: "a path inside the branch, with no empty, `.`, or `..` segment" },
  );

/** A branch name a runner looks up under `refs/heads/`; it never starts with a dash. */
export const BranchNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);

/** A request to read one path on a branch of a project's repository. */
export const BranchReadSchema = z.object({
  repo: ProjectRepoSchema,
  branch: BranchNameSchema,
  path: BranchPathSchema,
});
export type BranchRead = z.infer<typeof BranchReadSchema>;

/** The branch's newest commit, which a read shows the tree at. */
export const BranchCommitSchema = z.object({
  id: z.string().min(1),
  at: IsoDateTimeSchema,
  author: z.string(),
});
export type BranchCommit = z.infer<typeof BranchCommitSchema>;

/**
 * What a path on a branch holds: a file, base64, or null with its size when it is over
 * `BRANCH_FILE_LIMIT_BYTES`; or a folder's entries, a folder's size null.
 */
export const BranchFileSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: BranchPathSchema,
    commit: BranchCommitSchema,
    size: z.number().int().nonnegative(),
    content: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("dir"),
    path: BranchPathSchema,
    commit: BranchCommitSchema,
    entries: z.array(
      z.object({
        name: z.string().min(1),
        kind: z.enum(["file", "dir"]),
        size: z.number().int().nonnegative().nullable(),
      }),
    ),
  }),
]);
export type BranchFile = z.infer<typeof BranchFileSchema>;

/** A request to list what a branch changed since it left the project's default branch. */
export const BranchChangesReadSchema = z.object({
  repo: ProjectRepoSchema,
  branch: BranchNameSchema,
});
export type BranchChangesRead = z.infer<typeof BranchChangesReadSchema>;

/** The most files a change list carries; `total` says how many there were. */
export const BRANCH_CHANGES_LIMIT = 500;

/** One file a branch changed, with the newest commit on the branch that touched it. */
export const BranchFileChangeSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted"]),
  /** Lines added and removed, or null for a binary file. */
  added: z.number().int().nonnegative().nullable(),
  removed: z.number().int().nonnegative().nullable(),
  /** Absent when the file changed only through a merge of another branch. */
  lastChange: z.object({ author: z.string(), at: IsoDateTimeSchema }).optional(),
});
export type BranchFileChange = z.infer<typeof BranchFileChangeSchema>;

/**
 * What a branch changed since it left the default branch, by path, as of its newest commit: the
 * first `BRANCH_CHANGES_LIMIT` files, and how many there were in all.
 */
export const BranchChangesSchema = z.object({
  head: BranchCommitSchema,
  files: z.array(BranchFileChangeSchema),
  total: z.number().int().nonnegative(),
});
export type BranchChanges = z.infer<typeof BranchChangesSchema>;

/** A request for one file's patch on a branch, counted from where `BranchChanges` counts. */
export const BranchDiffReadSchema = z.object({
  repo: ProjectRepoSchema,
  branch: BranchNameSchema,
  path: BranchPathSchema.min(1),
});
export type BranchDiffRead = z.infer<typeof BranchDiffReadSchema>;

/** The most of one file's patch a diff carries. */
export const BRANCH_PATCH_LIMIT_CHARS = 100_000;

/**
 * What a branch did to one file since it left the default branch: the patch's hunks without its
 * header, or null for a binary file, cut at a line's end past `BRANCH_PATCH_LIMIT_CHARS`.
 */
export const BranchFileDiffSchema = z.object({
  head: BranchCommitSchema,
  path: BranchPathSchema,
  status: BranchFileChangeSchema.shape.status,
  patch: z.string().nullable(),
  truncated: z.boolean(),
});
export type BranchFileDiff = z.infer<typeof BranchFileDiffSchema>;

/** The hunks of a one-file patch without its header, cut at `limit`, or null for a binary file. */
export function patchHunks(
  patch: string,
  limit: number,
): { patch: string | null; truncated: boolean } {
  if (/^Binary files .* differ$/m.test(patch)) {
    return { patch: null, truncated: false };
  }
  const start = patch.search(/^@@/m);
  const hunks = start === -1 ? "" : patch.slice(start);
  if (hunks.length <= limit) {
    return { patch: hunks, truncated: false };
  }
  const cut = hunks.lastIndexOf("\n", limit);
  return { patch: hunks.slice(0, cut === -1 ? limit : cut), truncated: true };
}

/**
 * A request to read the image file a turn running on the runner names in `upload_image`: a path
 * on that machine, absolute or relative to the turn's working directory.
 */
export const TurnImageReadSchema = z.object({
  turnId: UlidSchema,
  path: ImagePathSchema,
});
export type TurnImageRead = z.infer<typeof TurnImageReadSchema>;

/** Why a runner would not hand over a file as an image. */
export const ImageRefusalSchema = z.enum(["missing", "outside", "not_image", "too_big"]);
export type ImageRefusal = z.infer<typeof ImageRefusalSchema>;

/**
 * What a runner read for `upload_image`: the image, base64, or why it refused, in words for the
 * citizen who named the file.
 */
export const TurnImageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    type: ImageTypeSchema,
    size: z.number().int().positive(),
    content: z.string(),
  }),
  z.object({ kind: z.literal("refused"), why: ImageRefusalSchema, detail: z.string() }),
]);
export type TurnImage = z.infer<typeof TurnImageSchema>;

/**
 * A conversation with a workspace of its own on a runner: a thread's, a task's included, since a
 * task's thread takes its id, a channel's beside general in a scope, or a project's channels' in
 * the society scope, which ends when the project is archived.
 */
export const WorkspaceConversationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), id: UlidSchema }),
  z.object({ kind: z.literal("channel"), scope: NameSchema, name: NameSchema }),
  z.object({ kind: z.literal("place"), project: NameSchema }),
]);
export type WorkspaceConversation = z.infer<typeof WorkspaceConversationSchema>;

/** The conversation with a workspace of its own a turn is in, or null for a home turn. */
export function workspaceConversationOf(turn: {
  readonly scope: string;
  readonly thread?: string | undefined;
  readonly channel?: string | undefined;
  readonly place?: string | undefined;
}): WorkspaceConversation | null {
  if (turn.thread !== undefined) {
    return { kind: "thread", id: turn.thread };
  }
  if (turn.channel !== undefined) {
    return { kind: "channel", scope: turn.scope, name: turn.channel };
  }
  return turn.place === undefined ? null : { kind: "place", project: turn.place };
}

export function sameConversation(a: WorkspaceConversation, b: WorkspaceConversation): boolean {
  if (a.kind === "thread") {
    return b.kind === "thread" && a.id === b.id;
  }
  if (a.kind === "channel") {
    return b.kind === "channel" && a.scope === b.scope && a.name === b.name;
  }
  return b.kind === "place" && a.project === b.project;
}

/** One citizen's workspace for a conversation on a runner, in the scope its turns ran in. */
export const HeldWorkspaceSchema = z.object({
  agent: NameSchema,
  scope: NameSchema,
  conversation: WorkspaceConversationSchema,
});
export type HeldWorkspace = z.infer<typeof HeldWorkspaceSchema>;

/** The workspaces a runner holds, which it reports when its stream opens so ended ones go. */
export const HeldWorkspacesSchema = z.object({ workspaces: z.array(HeldWorkspaceSchema) });

/** A sweep's answer: the workspaces kept because they hold work on no branch. */
export const SweepResultSchema = z.object({ kept: z.array(HeldWorkspaceSchema) });
export type SweepResult = z.infer<typeof SweepResultSchema>;

/**
 * The most a move carries: the repository's packs as the old runner measures them before it
 * pushes, and what the server's git route for a move takes of one request as it streams it to git.
 */
export const MOVE_PACK_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * The slowest a move's transfer may run on average and still finish: half the 34 KB/s that the
 * slowest measured push between two runners' sites ran at.
 */
export const MOVE_FLOOR_BYTES_PER_SECOND = 16 * 1024;

/**
 * How long a move's push or clone of `bytes` may take before its clock cuts it: the ten minutes any
 * transfer had before, plus the bytes at the floor rate, so a pack at the cap gets about four hours
 * and forty minutes. A transfer that stops moving ends far sooner, at git's low-speed limit.
 */
export function moveTransferMs(bytes: number): number {
  return 10 * 60_000 + Math.ceil(bytes / MOVE_FLOOR_BYTES_PER_SECOND) * 1000;
}

/** A repository's branches and tags by full name (`refs/heads/…`, `refs/tags/…`), each at its object. */
export const RepoRefsSchema = z.record(
  z.string().regex(/^refs\/(heads|tags)\/\S+$/),
  z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
);
export type RepoRefs = z.infer<typeof RepoRefsSchema>;

/**
 * A project's repository leaving this runner for another: every branch and tag goes to the
 * move's repository on the server, once no worktree of the project holds work no branch does.
 */
export const ProjectExportSchema = z.object({ move: UlidSchema, repo: ProjectRepoSchema });
export type ProjectExport = z.infer<typeof ProjectExportSchema>;

/**
 * Work in one of a project's worktrees that no branch holds, which keeps the project from moving:
 * files not committed and commits on no branch. A citizen's own worktree on `agent/<name>` has no
 * conversation.
 */
export const HeldWorkSchema = z.object({
  agent: NameSchema,
  conversation: WorkspaceConversationSchema.nullable(),
  uncommitted: z.number().int().nonnegative(),
  onNoBranch: z.number().int().nonnegative(),
});
export type HeldWork = z.infer<typeof HeldWorkSchema>;

/**
 * How an export went: the branches and tags pushed, at their objects, and the size of the packs
 * measured before; or what kept it from starting, the work no branch holds or a repository too
 * large to carry.
 */
export const ProjectExportedSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    refs: RepoRefsSchema,
    bytes: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    held: z.array(HeldWorkSchema),
    bytes: z.number().int().nonnegative(),
  }),
]);
export type ProjectExported = z.infer<typeof ProjectExportedSchema>;

/**
 * A project's repository arriving on this runner: a clone of the move's repository on the server
 * with every carried branch made local, its remote the project's own, which must answer a fetch,
 * and for a project that lands through pull requests a `gh` signed in to the remote's host.
 */
export const ProjectImportSchema = z.object({
  move: UlidSchema,
  repo: ProjectRepoSchema,
  pullRequests: z.boolean(),
  /** The packs' size the old runner measured, which the clone's clock is sized from; the cap if unsaid. */
  bytes: z.number().int().nonnegative().optional(),
});
export type ProjectImport = z.infer<typeof ProjectImportSchema>;

/** What an import left in `repos/<slug>`: its branches and tags at their objects. */
export const ProjectImportedSchema = z.object({ refs: RepoRefsSchema });
export type ProjectImported = z.infer<typeof ProjectImportedSchema>;

/** A project that moved to another runner: this one removes its worktrees and its clone. */
export const ProjectReleaseSchema = z.object({ slug: NameSchema });
export type ProjectRelease = z.infer<typeof ProjectReleaseSchema>;

/** What a release removed: the project's worktrees, and whether its clone was there to remove. */
export const ProjectReleasedSchema = z.object({
  worktrees: z.number().int().nonnegative(),
  clone: z.boolean(),
});
export type ProjectReleased = z.infer<typeof ProjectReleasedSchema>;

/**
 * How a move the user asked for ended: the project where it lives now; how many branches and tags
 * travelled, or null when its old runner was away and nothing did; and whether the old runner
 * removed its copy, or null when it was not asked to.
 */
export const ProjectMovedSchema = z.object({
  project: ProjectSchema,
  carried: z.number().int().nonnegative().nullable(),
  released: z.object({ ok: z.boolean(), detail: z.string() }).nullable(),
});
export type ProjectMoved = z.infer<typeof ProjectMovedSchema>;

/** Input for a running turn: what arrived in its conversation since it was last shown anything. */
export const TurnSteerSchema = z.object({ id: z.uuid(), text: z.string().min(1) });
export type TurnSteer = z.infer<typeof TurnSteerSchema>;

/** What the server sends a runner on its event stream, by event name. */
export const RunnerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn"), job: TurnJobSchema }),
  z.object({ type: z.literal("land"), request: z.string().min(1), land: LandRequestSchema }),
  /** Answered with a `MergeOutcome`. */
  z.object({ type: z.literal("close"), request: z.string().min(1), close: CloseRequestSchema }),
  z.object({ type: z.literal("models"), request: z.string().min(1), cli: CliKindSchema }),
  /**
   * Answered with a `CliQuota` read from the CLI without a turn, or null when its adapter cannot
   * read one. Sent only to runners whose hello says `quotaReads`.
   */
  z.object({ type: z.literal("quota"), request: z.string().min(1), cli: CliKindSchema }),
  /** Answered with a `BranchFile`, or null when the branch or the path does not exist. */
  z.object({ type: z.literal("file"), request: z.string().min(1), read: BranchReadSchema }),
  /** Answered with `BranchChanges`, or null when the repository or the branch does not exist. */
  z.object({
    type: z.literal("changes"),
    request: z.string().min(1),
    read: BranchChangesReadSchema,
  }),
  /** Answered with a `BranchFileDiff`, or null when the branch does not exist or left the path alone. */
  z.object({ type: z.literal("diff"), request: z.string().min(1), read: BranchDiffReadSchema }),
  /**
   * Answered with a `TurnImage`, or null when the turn is not running there. Sent only to runners
   * whose hello says `imageReads`.
   */
  z.object({ type: z.literal("image"), request: z.string().min(1), read: TurnImageReadSchema }),
  /** Answered with whether the CLI accepted it; that it took it comes as a `steered` event. */
  z.object({
    type: z.literal("steer"),
    request: z.string().min(1),
    turnId: UlidSchema,
    steer: TurnSteerSchema,
  }),
  /** Answered with whether the turn was there to stop; it ends `stopped`. */
  z.object({ type: z.literal("stop"), request: z.string().min(1), turnId: UlidSchema }),
  /**
   * Answered with a `ProjectExported`. Sent only to runners whose hello says `projectMoves`, as are
   * the import and the release.
   */
  z.object({ type: z.literal("export"), request: z.string().min(1), export: ProjectExportSchema }),
  /** Answered with a `ProjectImported`. */
  z.object({ type: z.literal("import"), request: z.string().min(1), import: ProjectImportSchema }),
  /** Answered with a `ProjectReleased`. */
  z.object({
    type: z.literal("release"),
    request: z.string().min(1),
    release: ProjectReleaseSchema,
  }),
  /**
   * A conversation ended: the runner removes every citizen's workspace for it but those a turn
   * still uses, and answers with a `SweepResult` naming those it kept for holding work on no branch.
   */
  z.object({
    type: z.literal("sweep"),
    request: z.string().min(1),
    conversation: WorkspaceConversationSchema,
  }),
]);
export type RunnerMessage = z.infer<typeof RunnerMessageSchema>;

/** A runner's answer to a request it was sent. */
export const RunnerAnswerSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type RunnerAnswer = z.infer<typeof RunnerAnswerSchema>;

/** The conversations a runner keeps warm right now, by session key. */
export const WarmSessionsSchema = z.object({ warm: z.array(z.string()) });

/**
 * The board's files as the file API lists them: a relative path, with forward slashes, to its
 * version, `fileVersion` of its content's SHA-256 and whether it is executable.
 */
export const FileManifestSchema = z.object({ files: z.record(z.string(), z.string()) });

/** A file's version in a manifest: its SHA-256, marked `+x` when it is executable, so a mode change is a change. */
export function fileVersion(sha: string, executable: boolean): string {
  return executable ? `${sha}+x` : sha;
}

/** Whether a manifest's version names an executable file. */
export function isExecutableVersion(version: string): boolean {
  return version.endsWith("+x");
}
export type FileManifest = z.infer<typeof FileManifestSchema>;

export const FileReadSchema = z.object({ paths: z.array(z.string()) });

/** File contents by relative path, base64. */
export const FileContentsSchema = z.object({ files: z.record(z.string(), z.string()) });
export type FileContents = z.infer<typeof FileContentsSchema>;

/**
 * A relative path the file API accepts: forward slashes, no empty, `.`, or `..` segment, nothing
 * absolute. Anything else is refused on both sides.
 */
export function isSafeRelativePath(file: string): boolean {
  if (file.length === 0 || file.startsWith("/") || file.includes("\\") || file.includes("\0")) {
    return false;
  }
  return file.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
