import { z } from "zod";
import { CliKindSchema, ModelOptionSchema, RunnerOsSchema, type Project } from "./board.js";
import {
  TranscriptEntrySchema,
  TurnExitReasonSchema,
  TurnStatusSchema,
  UsageSchema,
} from "./events.js";
import { IsoDateTimeSchema, NameSchema, UlidSchema } from "./ids.js";

/**
 * The runner protocol of PLAN.md section 7.1. A runner registers, holds one event stream open for
 * what the server sends it, and posts everything it sends back; the server refuses a runner that
 * speaks another protocol version.
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
  capabilities: z.array(z.string()).default([]),
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
 * or a worktree detached at the tip of the project's default branch.
 */
export const TurnWorkspaceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("home"),
    thread: UlidSchema.optional(),
    channel: NameSchema.optional(),
  }),
  z.object({
    kind: z.literal("project"),
    repo: ProjectRepoSchema,
    branches: z.array(z.string().min(1)),
    thread: UlidSchema.optional(),
    channel: NameSchema.optional(),
  }),
  z.object({ kind: z.literal("task"), repo: ProjectRepoSchema, taskId: UlidSchema }),
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
  /**
   * The session to resume, or null to start one: the CLI's adapter picks a fresh session's id, and
   * the outcome reports it.
   */
  session: z.string().min(1).nullable(),
  /** The running total the session reported after its last turn, which a resumed session starts from. */
  costSoFarUsd: z.number().nonnegative(),
  /** The rendered charter, norms, memory core, and skills index, with `PATH_TOKENS` for places. */
  instructions: z.string(),
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
  /** The session the CLI used, which differs from the job's for CLIs that assign their own ids. */
  session: z.string().min(1),
  /** The model the CLI reported, when it reported one. */
  model: z.string().nullable(),
  work: TurnWorkSchema.nullable(),
  /**
   * Whether the turn's own workspace, a thread's, a channel's, or a task's, holds work on no
   * branch after the hand-back: uncommitted changes, or commits no branch contains.
   */
  leftovers: z.boolean().default(false),
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

/**
 * A conversation with a workspace of its own on a runner: a thread's, a task's included, since a
 * task's thread takes its id, or a channel's beside general in a scope.
 */
export const WorkspaceConversationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), id: UlidSchema }),
  z.object({ kind: z.literal("channel"), scope: NameSchema, name: NameSchema }),
]);
export type WorkspaceConversation = z.infer<typeof WorkspaceConversationSchema>;

/** The conversation with a workspace of its own a turn is in, or null for a home turn. */
export function workspaceConversationOf(turn: {
  readonly scope: string;
  readonly thread?: string | undefined;
  readonly channel?: string | undefined;
}): WorkspaceConversation | null {
  if (turn.thread !== undefined) {
    return { kind: "thread", id: turn.thread };
  }
  return turn.channel === undefined
    ? null
    : { kind: "channel", scope: turn.scope, name: turn.channel };
}

export function sameConversation(a: WorkspaceConversation, b: WorkspaceConversation): boolean {
  return a.kind === "thread"
    ? b.kind === "thread" && a.id === b.id
    : b.kind === "channel" && a.scope === b.scope && a.name === b.name;
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
  /** Answered with a `BranchFile`, or null when the branch or the path does not exist. */
  z.object({ type: z.literal("file"), request: z.string().min(1), read: BranchReadSchema }),
  /** Answered with `BranchChanges`, or null when the repository or the branch does not exist. */
  z.object({
    type: z.literal("changes"),
    request: z.string().min(1),
    read: BranchChangesReadSchema,
  }),
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

/** The board's files as the file API lists them: a relative path, with forward slashes, to its SHA-256. */
export const FileManifestSchema = z.object({ files: z.record(z.string(), z.string()) });
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
