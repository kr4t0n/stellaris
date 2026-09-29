import { useQueries, useQuery } from "@tanstack/react-query";
import type { Task } from "@stellaris/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import type { Activity, WorldSnapshot } from "../world/types.js";
import { useLiveTurns } from "./useLiveTurns.js";

/** A clock that ticks once a second, so time-based facts (leases, fresh activity) age on screen. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function localMidnight(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : null;
}

interface TaskTables {
  readonly ready: boolean;
  readonly byProject: Readonly<Record<string, readonly Task[]>>;
}

/**
 * The snapshot the world is projected from: every query the drawers already use, plus what the
 * live stream says each citizen did last. Board events keep the queries fresh through the shell.
 */
export function useWorldSnapshot(): WorldSnapshot | null {
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const members = useQuery({ queryKey: ["members"], queryFn: api.members });
  const scheduler = useQuery({
    queryKey: ["scheduler"],
    queryFn: api.scheduler,
    refetchInterval: 2_000,
  });
  const proposals = useQuery({ queryKey: ["proposals"], queryFn: api.proposals });
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => api.inbox(false) });
  const events = useQuery({ queryKey: ["events"], queryFn: () => api.events(null, 2000) });
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const knowledge = useQuery({
    queryKey: ["knowledge", "society"],
    queryFn: () => api.knowledge(null),
  });
  const slugs = useMemo(
    () => (projects.data ?? []).map((project) => project.slug),
    [projects.data],
  );
  const tasks: TaskTables = useQueries({
    queries: slugs.map((slug) => ({ queryKey: ["tasks", slug], queryFn: () => api.tasks(slug) })),
    combine: (results) => {
      const byProject: Record<string, readonly Task[]> = {};
      results.forEach((result, index) => {
        const slug = slugs[index];
        if (slug !== undefined && result.data !== undefined) byProject[slug] = result.data;
      });
      return { ready: results.every((result) => result.data !== undefined), byProject };
    },
  });
  const live = useLiveTurns();
  const now = useNow(1_000);

  const activity = useMemo(() => {
    const latest: Record<string, Activity> = {};
    for (const item of live) {
      const { event } = item;
      const at = Date.parse(item.ts);
      if (event.type === "tool_call") {
        const talking = event.name.endsWith("post_message");
        latest[item.agent] = {
          kind: talking ? "talking" : "working",
          text: talking ? stringField(event.input, "body") : null,
          at,
        };
      } else if (event.type === "text") {
        latest[item.agent] = { kind: "working", text: null, at };
      } else if (event.type === "turn_completed" || event.type === "error") {
        delete latest[item.agent];
      }
    }
    return latest;
  }, [live]);

  return useMemo(() => {
    if (
      projects.data === undefined ||
      members.data === undefined ||
      scheduler.data === undefined ||
      !tasks.ready
    ) {
      return null;
    }
    return {
      projects: projects.data,
      members: members.data,
      tasks: tasks.byProject,
      scheduler: {
        paused: scheduler.data.paused,
        running: scheduler.data.running,
        pending: scheduler.data.pending,
        resident: scheduler.data.resident ?? [],
        signals: scheduler.data.signals ?? [],
      },
      proposals: proposals.data ?? [],
      // What needs the owner: mentions of it and decisions, not every post in a followed channel.
      unread: (inbox.data?.messages ?? []).filter(
        (message) => message.mentions.includes("owner") || message.channel === "decisions",
      ).length,
      events: events.data ?? [],
      activity,
      library: { skills: skills.data?.length ?? 0, knowledge: knowledge.data?.length ?? 0 },
      now,
      dayStart: localMidnight(now),
    };
  }, [
    projects.data,
    members.data,
    scheduler.data,
    proposals.data,
    inbox.data,
    events.data,
    skills.data,
    knowledge.data,
    activity,
    now,
    tasks,
  ]);
}
