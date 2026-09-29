import type {
  Agent,
  AgentEvent,
  BoardEvent,
  Knowledge,
  Member,
  Message,
  OpsSignal,
  Project,
  Proposal,
  RoleCharter,
  Runner,
  Skill,
  Society,
  Task,
  VerbInput,
  VerbName,
} from "@stellaris/shared";
import { streamSse, type SseMessage } from "./sse.js";

const TOKEN_KEY = "stellaris.token";

export type PublicAgent = Omit<Agent, "tokenHash">;

export interface SchedulerState {
  readonly paused: boolean;
  readonly running: readonly string[];
  readonly pending: readonly string[];
  readonly resident?: readonly string[] | undefined;
}

export interface LiveTurnEvent {
  readonly seq: number;
  readonly ts: string;
  readonly agent: string;
  readonly project: string;
  readonly event: AgentEvent;
}

export interface Dashboard {
  readonly data: Record<string, unknown>;
  readonly body: string;
}

export interface Inbox {
  readonly messages: readonly Message[];
  readonly cursor: string | null;
}

export interface SignalRecord {
  readonly id: string;
  readonly ts: string;
  readonly signal: OpsSignal;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token === null) {
    window.localStorage.removeItem(TOKEN_KEY);
  } else {
    window.localStorage.setItem(TOKEN_KEY, token);
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token === null ? {} : { authorization: `Bearer ${token}` };
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

/** A structural guard for live turn frames; the event payload itself is trusted from our own server. */
export function isLiveTurnEvent(value: unknown): value is LiveTurnEvent {
  if (typeof value !== "object" || value === null) return false;
  const seq: unknown = Reflect.get(value, "seq");
  const event: unknown = Reflect.get(value, "event");
  return (
    typeof seq === "number" &&
    typeof Reflect.get(value, "agent") === "string" &&
    typeof Reflect.get(value, "project") === "string" &&
    typeof event === "object" &&
    event !== null &&
    typeof Reflect.get(event, "type") === "string"
  );
}

async function request<T>(
  path: string,
  method: "GET" | "POST" | "PUT" = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { ...authHeaders(), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      stringField(payload, "error") ?? "ERROR",
      stringField(payload, "message") ?? response.statusText,
    );
  }
  // Responses come from our own server and match the shared schemas by construction.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return payload as T;
}

export const api = {
  me: () => request<{ name: string; role: string }>("/me"),
  society: () => request<Society>("/society"),
  agents: () => request<PublicAgent[]>("/agents"),
  members: () => request<Member[]>("/members"),
  roles: () => request<RoleCharter[]>("/roles"),
  runners: () => request<Runner[]>("/runners"),
  proposals: () => request<Proposal[]>("/proposals"),
  proposal: (id: string) => request<Proposal>(`/proposals/${id}`),
  signals: (limit = 100) => request<SignalRecord[]>(`/signals?limit=${limit}`),
  retire: (name: string, reason: string) =>
    request<PublicAgent>(`/agents/${name}/retire`, "POST", { reason }),
  setRole: (name: string, charter: RoleCharter) =>
    request<RoleCharter>(`/roles/${name}`, "PUT", charter),
  addChannel: (project: string | null, name: string, purpose: string) =>
    request<{ channel: string }>("/channels", "POST", { project, name, purpose }),
  projects: () => request<Project[]>("/projects"),
  project: (slug: string) => request<Project>(`/projects/${slug}`),
  tasks: (slug: string) => request<Task[]>(`/projects/${slug}/tasks`),
  dashboard: (slug: string) => request<Dashboard>(`/projects/${slug}/dashboard`),
  knowledge: (slug: string | null) =>
    request<Knowledge[]>(slug === null ? "/society/knowledge" : `/projects/${slug}/knowledge`),
  skills: () => request<Skill[]>("/skills"),
  task: (id: string) => request<Task>(`/tasks/${id}`),
  thread: (id: string) => request<Message[]>(`/tasks/${id}/thread`),
  channel: (ref: string) => request<Message[]>(`/channels/${ref}`),
  inbox: (advance = false) =>
    request<Inbox>(`/inbox?limit=100&advance=${advance ? "true" : "false"}`),
  events: (since: string | null, limit = 500) =>
    request<BoardEvent[]>(`/events?limit=${limit}${since === null ? "" : `&since=${since}`}`),
  scheduler: () => request<SchedulerState>("/scheduler"),
  pause: () => request<{ paused: boolean }>("/pause", "POST"),
  resume: () => request<{ paused: boolean }>("/resume", "POST"),
  wake: (
    agent: string,
    project: string,
    reason: string,
    kind: "manual" | "reflection" = "manual",
  ) => request<BoardEvent>("/wake", "POST", { agent, project, reason, kind }),
  recentTurns: (since = 0) =>
    request<{ lastSeq: number; events: LiveTurnEvent[] }>(`/turns/recent?since=${since}`),
  verb: <V extends VerbName>(name: V, input: VerbInput<V>) =>
    request<unknown>(`/verbs/${name}`, "POST", input),
};

/** Subscribes to a server stream with the current token. Returns a function that stops it. */
export function subscribe(path: string, onMessage: (message: SseMessage) => void): () => void {
  const controller = new AbortController();
  void streamSse(`/api${path}`, authHeaders(), onMessage, controller.signal).catch(() => undefined);
  return () => controller.abort();
}
