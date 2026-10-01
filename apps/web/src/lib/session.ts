import type { Task } from "@stellaris/shared";
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";
import type { CliKind, MetricsWindow } from "@stellaris/shared";
import type { Api } from "./api.js";

export interface Session {
  readonly api: Api;
  readonly token: string;
  readonly signOut: () => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) {
    throw new Error("useSession needs a signed-in SessionContext");
  }
  return session;
}

// One query per board read, shared by the sky and the board so both see the same cache. The
// event stream refreshes them; the intervals are the fallback.

export function useSociety() {
  const { api } = useSession();
  return useQuery({ queryKey: ["society"], queryFn: api.society, staleTime: 60_000 });
}

export function useMembers() {
  const { api } = useSession();
  return useQuery({ queryKey: ["members"], queryFn: api.members, refetchInterval: 30_000 });
}

export function useProjects() {
  const { api } = useSession();
  return useQuery({ queryKey: ["projects"], queryFn: api.projects, refetchInterval: 60_000 });
}

export function useRoles() {
  const { api } = useSession();
  return useQuery({ queryKey: ["roles"], queryFn: api.roles, refetchInterval: 60_000 });
}

/** The scheduler's queue changes without an event, so this one polls briskly. */
export function useScheduler() {
  const { api } = useSession();
  return useQuery({ queryKey: ["scheduler"], queryFn: api.scheduler, refetchInterval: 3_000 });
}

/** Questions to the user that wait for an answer; every post and closed thread refreshes them. */
export function useRequests() {
  const { api } = useSession();
  return useQuery({ queryKey: ["requests"], queryFn: api.requests, refetchInterval: 60_000 });
}

/** The operations log; only the logs island reads it, so it loads when that opens. */
export function useSignals(enabled: boolean) {
  const { api } = useSession();
  return useQuery({
    queryKey: ["signals"],
    queryFn: () => api.signals(200),
    enabled,
    refetchInterval: 60_000,
  });
}

/** How the society works over a window; it reads the whole log, so it refreshes on events that change it. */
export function useMetrics(window: MetricsWindow) {
  const { api } = useSession();
  return useQuery({
    queryKey: ["metrics", window],
    queryFn: () => api.metrics(window),
    refetchInterval: 60_000,
  });
}

export function useChannels() {
  const { api } = useSession();
  return useQuery({ queryKey: ["channels"], queryFn: api.channels, refetchInterval: 60_000 });
}

export function useThreads() {
  const { api } = useSession();
  return useQuery({ queryKey: ["threads"], queryFn: api.threads, refetchInterval: 60_000 });
}

export function useTasks(slug: string) {
  const { api } = useSession();
  return useQuery({
    queryKey: ["tasks", slug],
    queryFn: () => api.tasks(slug),
    refetchInterval: 60_000,
  });
}

function everyTask(results: ReadonlyArray<UseQueryResult<Task[]>>): Task[] {
  return results.flatMap((result) => result.data ?? []);
}

/** Every project's tasks, from the same cache the tasks views read. */
export function useAllTasks(): Task[] {
  const { api } = useSession();
  const projects = useProjects();
  return useQueries({
    queries: (projects.data ?? []).map((project) => ({
      queryKey: ["tasks", project.slug],
      queryFn: () => api.tasks(project.slug),
      refetchInterval: 60_000,
    })),
    combine: everyTask,
  });
}

/** One task; `null` reads nothing, for callers that only sometimes have a task in view. */
export function useTask(id: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: ["task", id],
    queryFn: () => api.task(id ?? ""),
    enabled: id !== null,
  });
}

export function useProposals() {
  const { api } = useSession();
  return useQuery({ queryKey: ["proposals"], queryFn: api.proposals, refetchInterval: 60_000 });
}

export function useProposal(id: string) {
  const { api } = useSession();
  return useQuery({ queryKey: ["proposal", id], queryFn: () => api.proposal(id) });
}

/** The society's skills, which a skill proposal may replace. */
export function useSkills() {
  const { api } = useSession();
  return useQuery({ queryKey: ["skills"], queryFn: api.skills, staleTime: 60_000 });
}

/** A citizen's finished turns, oldest first, from the event log. */
export function useTurnHistory(name: string, limit: number) {
  const { api } = useSession();
  return useQuery({
    queryKey: ["turns", name, limit],
    queryFn: () => api.turns(name, limit),
    refetchInterval: 60_000,
  });
}

/** One finished turn's steps; they never change once written, so they are read once. */
export function useTranscript(name: string, turnId: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: ["transcript", name, turnId],
    queryFn: () => api.transcript(name, turnId ?? ""),
    enabled: turnId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useMemoryCore(name: string) {
  const { api } = useSession();
  return useQuery({ queryKey: ["memory", name], queryFn: () => api.memory(name) });
}

/** A citizen's own skills, from its home. */
export function useAgentSkills(name: string) {
  const { api } = useSession();
  return useQuery({ queryKey: ["agent-skills", name], queryFn: () => api.agentSkills(name) });
}

/** Agents edit the dashboard file directly and no event says so, so it polls. */
export function useDashboard(slug: string) {
  const { api } = useSession();
  return useQuery({
    queryKey: ["dashboard", slug],
    queryFn: () => api.dashboard(slug),
    refetchInterval: 60_000,
  });
}

/** Knowledge topics of a project, or of the society for the society scope. */
export function useKnowledge(scope: string) {
  const { api } = useSession();
  return useQuery({
    queryKey: ["knowledge", scope],
    queryFn: () => api.knowledge(scope),
    refetchInterval: 120_000,
  });
}

/** The society's runners and whether each is connected. */
export function useRunners() {
  const { api } = useSession();
  return useQuery({ queryKey: ["runners"], queryFn: () => api.runners(), refetchInterval: 60_000 });
}

/** The models a CLI offers; asking starts the CLI, so the server keeps the list and so does this. */
export function useModels(cli: CliKind | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: ["models", cli],
    queryFn: () => api.models(cli ?? "claude"),
    enabled: cli !== null,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** The current time, refreshed on an interval, for relative times that should not go stale. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
