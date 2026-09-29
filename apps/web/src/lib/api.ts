import {
  ChannelRefSchema,
  DecisionSchema,
  MemberSchema,
  MessageFrontmatterSchema,
  NameSchema,
  ProjectSchema,
  ProposalFrontmatterSchema,
  RoleCharterSchema,
  SkillSchema,
  SocietySchema,
  TaskFrontmatterSchema,
  ThreadFrontmatterSchema,
  UlidSchema,
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

/** A failed API call. Status 0 means the board server could not be reached at all. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ActorSchema = z.object({ name: NameSchema, role: NameSchema });
const RosterSchema = MemberSchema.extend({ profile: z.string() }).array();
/** Pairs are `agent/scope`, where the scope is a project slug or `society`. */
const SchedulerViewSchema = z.object({
  paused: z.boolean(),
  running: z.array(z.string()),
  pending: z.array(z.string()),
  resident: z.array(z.string()),
  signals: z.array(z.string()),
});
export type SchedulerView = z.infer<typeof SchedulerViewSchema>;

/** The scheduler's `agent/scope` pairs, split. */
export function pairsOf(list: readonly string[]): Array<{ agent: string; scope: string }> {
  return list.flatMap((pair) => {
    const [agent, scope] = pair.split("/");
    return agent === undefined || scope === undefined ? [] : [{ agent, scope }];
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
});
export type ChannelSummary = z.infer<typeof ChannelSummarySchema>;
const ThreadRecordSchema = ThreadFrontmatterSchema.extend({ body: z.string() });
const ThreadSummarySchema = ThreadRecordSchema.extend({
  messages: z.number().int(),
  lastMessageId: UlidSchema.nullable(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
const ThreadDetailSchema = z.object({ thread: ThreadRecordSchema, messages: MessagesSchema });
const TaskSchema = TaskFrontmatterSchema.extend({ body: z.string() });
const ProposalSchema = ProposalFrontmatterSchema.extend({ body: z.string() });

/** A channel ref as a path: `general`, or `lab/general` with each part encoded. */
function channelPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

async function get<T>(path: string, token: string, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new ApiError(0, "The board server is not reachable.");
  }
  if (!response.ok) {
    throw new ApiError(response.status, `${path} answered ${response.status}`);
  }
  return schema.parse(await response.json());
}

const ErrorBodySchema = z.object({ message: z.string() });

/** A write as the signed-in actor; the board's refusal comes back as an ApiError with its reason. */
async function post<T>(
  path: string,
  token: string,
  input: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
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
  return post(`/api/verbs/${verb}`, token, input, schema);
}

const PausedSchema = z.object({ paused: z.boolean() });

/** The board's HTTP API as the signed-in actor, validated against the shared schemas. */
export function createApi(token: string) {
  return {
    me: () => get("/api/me", token, ActorSchema),
    society: () => get("/api/society", token, SocietySchema),
    members: () => get("/api/members", token, RosterSchema),
    projects: () => get("/api/projects", token, ProjectSchema.array()),
    roles: () => get("/api/roles", token, RoleCharterSchema.array()),
    scheduler: () => get("/api/scheduler", token, SchedulerViewSchema),
    channels: () => get("/api/channels", token, ChannelSummarySchema.array()),
    channel: (ref: string) => get(`/api/channels/${channelPath(ref)}`, token, MessagesSchema),
    threads: () => get("/api/threads", token, ThreadSummarySchema.array()),
    thread: (id: string) =>
      get(`/api/threads/${encodeURIComponent(id)}`, token, ThreadDetailSchema),
    tasks: (slug: string) =>
      get(`/api/projects/${encodeURIComponent(slug)}/tasks`, token, TaskSchema.array()),
    task: (id: string) => get(`/api/tasks/${encodeURIComponent(id)}`, token, TaskSchema),
    proposals: () => get("/api/proposals", token, ProposalSchema.array()),
    proposal: (id: string) =>
      get(`/api/proposals/${encodeURIComponent(id)}`, token, ProposalSchema),
    skills: () => get("/api/skills", token, SkillSchema.array()),
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
    setPaused: (paused: boolean) =>
      post(paused ? "/api/pause" : "/api/resume", token, {}, PausedSchema),
  };
}
export type Api = ReturnType<typeof createApi>;
