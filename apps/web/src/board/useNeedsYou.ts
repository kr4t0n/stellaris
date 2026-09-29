import { useQueries, useQuery } from "@tanstack/react-query";
import { useSeen } from "../lib/seen.js";
import { useProjects, useProposals, useSession } from "../lib/session.js";
import { needsYou, type Attention } from "./governance.js";

/** What waits on the user, from the reads the board already shares; the navigator and HUD count it. */
export function useNeedsYou(): Attention[] {
  const { api } = useSession();
  const proposals = useProposals();
  const projects = useProjects();
  const tasks = useQueries({
    queries: (projects.data ?? []).map((project) => ({
      queryKey: ["tasks", project.slug],
      queryFn: () => api.tasks(project.slug),
      refetchInterval: 60_000,
    })),
  });
  const decisions = useQuery({
    queryKey: ["channel", "decisions"],
    queryFn: () => api.channel("decisions"),
    refetchInterval: 60_000,
  });
  const seen = useSeen();
  return needsYou({
    proposals: proposals.data ?? [],
    tasks: tasks.flatMap((query) => query.data ?? []),
    decisions: decisions.data ?? [],
    seenDecisions: seen === null ? null : (seen["decisions"] ?? ""),
  });
}
