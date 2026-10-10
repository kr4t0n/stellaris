import {
  ArchivedChannelSchema,
  BoardEventSchema,
  BranchChangesSchema,
  BranchFileSchema,
  ChannelRefSchema,
  DecisionSchema,
  HomeConflictSchema,
  HomeFileDiffSchema,
  HomeHistorySchema,
  KnowledgeSchema,
  AgentSchema,
  MemberSchema,
  MetricsSchema,
  RemovedKnowledgeSchema,
  RunnerModelsSchema,
  MessageFrontmatterSchema,
  NameSchema,
  OpsSignalSchema,
  parseSessionKey,
  PendingEnrollmentSchema,
  ProjectSchema,
  ProposalFrontmatterSchema,
  RoleCharterSchema,
  RunnerSchema,
  RunningTurnSchema,
  SkillSchema,
  SOCIETY_SCOPE,
  SocietySchema,
  TaskFrontmatterSchema,
  ThreadFrontmatterSchema,
  TranscriptEntrySchema,
  TurnHistoryEntrySchema,
  UlidSchema,
  type MetricsWindow,
} from "@stellaris/shared";
import { z } from "zod";

const TOKEN_KEY = "stellaris.token";

export function storedToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

const AuthConfigSchema = z.object({ github: z.boolean() });

/**
 * How this board lets people in. Asked before anyone has a token; a server from before GitHub
 * sign-in serves the interface at `/auth/config`, which reads as tokens only.
 */
export async function authConfig(): Promise<{ github: boolean }> {
  try {
    const parsed = AuthConfigSchema.safeParse(await (await fetch("/auth/config")).json());
    return parsed.success ? parsed.data : { github: false };
  } catch {
    return { github: false };
  }
}

/** A failed API call. Status 0 means the board server could not be reached at all. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ActorSchema = z.object({
  name: NameSchema,
  role: NameSchema,
  /** The GitHub account a sign-in token belongs to; absent for the user's own token. */
  signIn: z.object({ login: z.string().min(1), avatarUrl: z.url() }).optional(),
});
export type SignIn = NonNullable<z.infer<typeof ActorSchema>["signIn"]>;
const RosterSchema = MemberSchema.extend({ profile: z.string() }).array();
/** Pairs are `agent/scope`, where the scope is a project slug or `society`. */
const SchedulerViewSchema = z.object({
  paused: z.boolean(),
  running: z.array(z.string()),
  pending: z.array(z.string()),
  resident: z.array(z.string()),
  signals: z.array(z.string()),
  // Each turn in flight, and whether a post reaches it and Stop ends it; a server from before
  // steering leaves it out.
  turns: z.array(RunningTurnSchema).default([]),
});
export type SchedulerView = z.infer<typeof SchedulerViewSchema>;

/**
 * Sessions as the scheduler lists them: a citizen, a scope, and, for a thread's or a channel's
 * conversation, its thread or channel.
 */
export function pairsOf(
  list: readonly string[],
): Array<{ agent: string; scope: string; thread?: string; channel?: string }> {
  return list.flatMap((key) => {
    const parsed = parseSessionKey(key);
    return parsed === null ? [] : [parsed];
  });
}

const MessageSchema = MessageFrontmatterSchema.extend({ body: z.string() });
const MessagesSchema = MessageSchema.array();
const ChannelSummarySchema = z.object({
  ref: ChannelRefSchema,
  project: NameSchema.nullable(),
  name: NameSchema,
  messages: z.number().int(),
  lastMessageId: UlidSchema.nullable(),
  lastAt: z.string().nullable(),
  /** Set for an archived channel, listed for its history. */
  archived: ArchivedChannelSchema.optional(),
});
export type ChannelSummary = z.infer<typeof ChannelSummarySchema>;
const ThreadRecordSchema = ThreadFrontmatterSchema.extend({ body: z.string() });
const ThreadSummarySchema = ThreadRecordSchema.extend({
  messages: z.number().int(),
  lastMessageId: UlidSchema.nullable(),
  // A server from before it was listed leaves it out.
  lastAuthor: NameSchema.nullable().default(null),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
const ThreadDetailSchema = z.object({ thread: ThreadRecordSchema, messages: MessagesSchema });
/** A message that asks the user something, unanswered, with the thread it is in. */
const UserRequestSchema = z.object({
  message: MessageSchema,
  thread: ThreadRecordSchema.nullable(),
});
export type UserRequest = z.infer<typeof UserRequestSchema>;
const TaskSchema = TaskFrontmatterSchema.extend({ body: z.string() });
const ProposalSchema = ProposalFrontmatterSchema.extend({ body: z.string() });
const TopicSchema = KnowledgeSchema.extend({ body: z.string() });
export type Topic = z.infer<typeof TopicSchema>;
const BodySchema = z.object({ body: z.string() });
const DashboardSchema = z.object({ data: z.record(z.string(), z.unknown()), body: z.string() });

/** A channel ref as a path: `general`, or `lab/general` with each part encoded. */
function channelPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/** Why the board refused a request, when it said. */
const ErrorBodySchema = z.object({ message: z.string() });

async function get<T>(path: string, token: string, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new ApiError(0, "The board server is not reachable.");
  }
  if (!response.ok) {
    const detail = ErrorBodySchema.safeParse(await response.json().catch(() => null));
    throw new ApiError(
      response.status,
      detail.success ? detail.data.message : `${path} answered ${response.status}`,
    );
  }
  return schema.parse(await response.json());
}

/** A write as the signed-in actor; the board's refusal comes back as an ApiError with its reason. */
async function write<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  token: string,
  input: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new ApiError(0, "The board server is not reachable.");
  }
  if (!response.ok) {
    const detail = ErrorBodySchema.safeParse(await response.json().catch(() => null));
    throw new ApiError(
      response.status,
      detail.success ? detail.data.message : `${path} answered ${response.status}`,
    );
  }
  return schema.parse(await response.json());
}

/** A verb, run as the signed-in actor through the same route agents' verbs take. */
function invoke<T>(
  verb: string,
  token: string,
  input: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  return write("POST", `/api/verbs/${verb}`, token, input, schema);
}

const PausedSchema = z.object({ paused: z.boolean() });
const VersionSchema = z.object({ version: z.string() });
const SignalRecordSchema = z.object({ id: UlidSchema, ts: z.string(), signal: OpsSignalSchema });
export type SignalRecord = z.infer<typeof SignalRecordSchema>;
const AgentRecordSchema = AgentSchema.omit({ tokenHash: true });
const SignedOutSchema = z.object({ signedOut: z.boolean() });
const DeniedSchema = z.object({ denied: z.boolean() });
const StoppedSchema = z.object({ stopped: z.boolean() });

/** The board's HTTP API as the signed-in actor, validated against the shared schemas. */
export function createApi(token: string) {
  return {
    me: () => get("/api/me", token, ActorSchema),
    /** Ends a GitHub sign-in on the board; the user's own token is not one and stays valid. */
    signOut: () => write("DELETE", "/api/sign-in", token, {}, SignedOutSchema),
    society: () => get("/api/society", token, SocietySchema),
    /** The board server's release. */
    version: async () => (await get("/api/version", token, VersionSchema)).version,
    members: () => get("/api/members", token, RosterSchema),
    projects: () => get("/api/projects", token, ProjectSchema.array()),
    roles: () => get("/api/roles", token, RoleCharterSchema.array()),
    scheduler: () => get("/api/scheduler", token, SchedulerViewSchema),
    /** The operations log, oldest first. */
    signals: (limit: number) =>
      get(`/api/signals?limit=${limit}`, token, SignalRecordSchema.array()),
    metrics: (window: MetricsWindow) => get(`/api/metrics?window=${window}`, token, MetricsSchema),
    channels: () => get("/api/channels", token, ChannelSummarySchema.array()),
    channel: (ref: string) => get(`/api/channels/${channelPath(ref)}`, token, MessagesSchema),
    threads: () => get("/api/threads", token, ThreadSummarySchema.array()),
    /** What citizens asked the user and the user has not answered, wherever they asked. */
    requests: () => get("/api/requests", token, UserRequestSchema.array()),
    thread: (id: string) =>
      get(`/api/threads/${encodeURIComponent(id)}`, token, ThreadDetailSchema),
    tasks: (slug: string) =>
      get(`/api/projects/${encodeURIComponent(slug)}/tasks`, token, TaskSchema.array()),
    task: (id: string) => get(`/api/tasks/${encodeURIComponent(id)}`, token, TaskSchema),
    /** One path on a task's branch, read from its project's runner: a file, base64, or a folder. */
    taskFile: (id: string, path: string) =>
      get(
        `/api/tasks/${encodeURIComponent(id)}/files${path
          .split("/")
          .filter((segment) => segment !== "")
          .map((segment) => `/${encodeURIComponent(segment)}`)
          .join("")}`,
        token,
        BranchFileSchema,
      ),
    /** What a task's branch changed since it left the default branch, file by file. */
    taskChanges: (id: string) =>
      get(`/api/tasks/${encodeURIComponent(id)}/changes`, token, BranchChangesSchema),
    proposals: () => get("/api/proposals", token, ProposalSchema.array()),
    proposal: (id: string) =>
      get(`/api/proposals/${encodeURIComponent(id)}`, token, ProposalSchema),
    skills: () => get("/api/skills", token, SkillSchema.array()),
    turns: (name: string, limit: number) =>
      get(
        `/api/agents/${encodeURIComponent(name)}/turns?limit=${limit}`,
        token,
        TurnHistoryEntrySchema.array(),
      ),
    transcript: (name: string, turnId: string) =>
      get(
        `/api/agents/${encodeURIComponent(name)}/turns/${encodeURIComponent(turnId)}`,
        token,
        TranscriptEntrySchema.array(),
      ),
    memory: (name: string) =>
      get(`/api/agents/${encodeURIComponent(name)}/memory`, token, BodySchema),
    agentSkills: (name: string) =>
      get(`/api/agents/${encodeURIComponent(name)}/skills`, token, SkillSchema.array()),
    /** The newest changes to a citizen's home. */
    history: (name: string, limit: number) =>
      get(
        `/api/agents/${encodeURIComponent(name)}/history?limit=${limit}`,
        token,
        HomeHistorySchema,
      ),
    /** One change to a citizen's home, file by file with its patch. */
    change: (name: string, commit: string) =>
      get(
        `/api/agents/${encodeURIComponent(name)}/history/${encodeURIComponent(commit)}`,
        token,
        HomeFileDiffSchema.array(),
      ),
    /** Conflict copies waiting in a citizen's home for it to reconcile. */
    conflicts: (name: string) =>
      get(`/api/agents/${encodeURIComponent(name)}/conflicts`, token, HomeConflictSchema.array()),
    dashboard: (slug: string) =>
      get(`/api/projects/${encodeURIComponent(slug)}/dashboard`, token, DashboardSchema),
    /** A project's knowledge topics, or the society's for the society scope. */
    knowledge: (scope: string) =>
      get(
        scope === SOCIETY_SCOPE
          ? "/api/society/knowledge"
          : `/api/projects/${encodeURIComponent(scope)}/knowledge`,
        token,
        TopicSchema.array(),
      ),
    sendMessage: (input: { channel?: string; thread_id?: string; body: string }) =>
      invoke("post_message", token, input, MessageSchema),
    openThread: (input: {
      task_id?: string;
      proposal_id?: string;
      channel?: string;
      title?: string;
    }) => invoke("open_thread", token, input, ThreadRecordSchema),
    closeThread: (input: { thread_id: string; summary: string }) =>
      invoke("close_thread", token, input, MessageSchema),
    approve: (input: { proposal_id: string; reason?: string }) =>
      invoke("approve", token, input, DecisionSchema),
    reject: (input: { proposal_id: string; reason: string }) =>
      invoke("reject", token, input, DecisionSchema),
    /** Changes a project's display name, default branch, or both; its slug stays. */
    configureProject: (project: string, changes: { name?: string; default_branch?: string }) =>
      invoke("configure_project", token, { project, ...changes }, ProjectSchema),
    /** Opens a channel in a project, or the society with project null, which the project's members follow. */
    createChannel: (input: { project: string | null; name: string; purpose: string }) =>
      invoke("create_channel", token, input, ChannelRefSchema),
    /** Ends a channel whose workstream is done; its history stays readable. */
    archiveChannel: (input: { channel: string; reason: string }) =>
      invoke("archive_channel", token, input, ArchivedChannelSchema),
    /** Takes a topic off the board; the server keeps its text aside. */
    removeKnowledge: (input: { project: string | null; topic: string }) =>
      invoke("remove_knowledge", token, input, RemovedKnowledgeSchema),
    /** A manual or reflection turn for a citizen in one of its scopes, queued by the scheduler. */
    wake: (input: {
      agent: string;
      project: string;
      reason?: string;
      kind: "manual" | "reflection";
    }) => write("POST", "/api/wake", token, input, BoardEventSchema),
    setPaused: (paused: boolean) =>
      write("POST", paused ? "/api/pause" : "/api/resume", token, {}, PausedSchema),
    /** Ends a turn in flight; it ends `stopped`, and what it was shown counts as read. */
    stopTurn: (turnId: string) =>
      write("POST", `/api/turns/${encodeURIComponent(turnId)}/stop`, token, {}, StoppedSchema),
    /** The models a CLI offers, from its own listing. */
    /** A citizen's choices, from the runner its turns run on, which the answer names. */
    agentModels: (name: string) =>
      get(`/api/agents/${encodeURIComponent(name)}/models`, token, RunnerModelsSchema),
    /** The runners the society has, connected or not, with what each offers. */
    runners: () => get("/api/runners", token, RunnerSchema.array()),
    /** Runners that asked to join and wait for the user's approval, newest first. */
    enrollments: () => get("/api/enrollments", token, PendingEnrollmentSchema.array()),
    /** Registers a waiting runner under `name`; the runner picks up its token on its next poll. */
    approveEnrollment: (code: string, name: string) =>
      write(
        "POST",
        `/api/enrollments/${encodeURIComponent(code)}/approve`,
        token,
        { name },
        RunnerSchema,
      ),
    denyEnrollment: (code: string) =>
      write("POST", `/api/enrollments/${encodeURIComponent(code)}/deny`, token, {}, DeniedSchema),
    /**
     * Sets the runner a citizen's work outside any project runs on, from its next turn, or null to
     * pin it again on that turn.
     */
    setRunner: (name: string, runner: string | null) =>
      write(
        "PUT",
        `/api/agents/${encodeURIComponent(name)}/runner`,
        token,
        { runner },
        AgentRecordSchema,
      ),
    /** Sets the model a citizen's turns run with from its next turn, or null for its CLI's default. */
    setModel: (name: string, model: string | null) =>
      write(
        "PUT",
        `/api/agents/${encodeURIComponent(name)}/model`,
        token,
        { model },
        AgentRecordSchema,
      ),
    /** Sets the reasoning effort a citizen's turns run with from its next turn, or null for the model's default. */
    setEffort: (name: string, effort: string | null) =>
      write(
        "PUT",
        `/api/agents/${encodeURIComponent(name)}/effort`,
        token,
        { effort },
        AgentRecordSchema,
      ),
  };
}
export type Api = ReturnType<typeof createApi>;
