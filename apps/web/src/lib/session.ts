import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";
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

export function useChannels() {
  const { api } = useSession();
  return useQuery({ queryKey: ["channels"], queryFn: api.channels, refetchInterval: 60_000 });
}

export function useThreads() {
  const { api } = useSession();
  return useQuery({ queryKey: ["threads"], queryFn: api.threads, refetchInterval: 60_000 });
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
