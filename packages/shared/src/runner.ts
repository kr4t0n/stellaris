import { z } from "zod";
import { CliKindSchema, ModelOptionSchema, RunnerOsSchema } from "./board.js";
import {
  TranscriptEntrySchema,
  TurnExitReasonSchema,
  TurnStatusSchema,
  UsageSchema,
} from "./events.js";
import { NameSchema, UlidSchema } from "./ids.js";

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
 * Where a project's code is: its slug, the origin its repository is first cloned from, or null for
 * a repository started empty, and its default branch. Today a project's repository lives on its
 * runner; a hub would add the URL to fetch from here.
 */
export const ProjectRepoSchema = z.object({
  slug: NameSchema,
  origin: z.string().nullable(),
  defaultBranch: z.string().min(1),
});
export type ProjectRepo = z.infer<typeof ProjectRepoSchema>;

/**
 * Where a turn works: the agent's home for a society-scope turn; the agent's own worktree of a
 * project, on `agent/<name>`, with the task branches to make sure of first; or the worktree of one
 * task's conversation, on `task/<id>`.
 */
export const TurnWorkspaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("home") }),
  z.object({
    kind: z.literal("project"),
    repo: ProjectRepoSchema,
    branches: z.array(z.string().min(1)),
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
  /** A project slug, or the society scope. */
  scope: NameSchema,
  /** The thread whose conversation the turn is in; absent for the home conversation. */
  thread: UlidSchema.optional(),
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
});
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

/** The server's answer to an outcome: whether the task the turn worked on has ended, so its worktree may go. */
export const TurnAckSchema = z.object({ dropWorktree: z.boolean() });
export type TurnAck = z.infer<typeof TurnAckSchema>;

/** A request to land a task: merge its branch into the project's default branch. */
export const LandRequestSchema = z.object({
  repo: ProjectRepoSchema,
  branch: z.string().min(1),
});
export type LandRequest = z.infer<typeof LandRequestSchema>;

export const MergeOutcomeSchema = z.object({ ok: z.boolean(), detail: z.string() });
export type MergeOutcome = z.infer<typeof MergeOutcomeSchema>;

export const ModelListSchema = z.array(ModelOptionSchema);

/** What the server sends a runner on its event stream, by event name. */
export const RunnerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn"), job: TurnJobSchema }),
  z.object({ type: z.literal("land"), request: z.string().min(1), land: LandRequestSchema }),
  z.object({ type: z.literal("models"), request: z.string().min(1), cli: CliKindSchema }),
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
