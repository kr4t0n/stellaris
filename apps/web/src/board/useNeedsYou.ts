import { useAllTasks, useProposals, useRequests } from "../lib/session.js";
import { needsYou, type Attention } from "./governance.js";

/** What waits on the user, from the reads the board already shares; the navigator and HUD count it. */
export function useNeedsYou(): Attention[] {
  const proposals = useProposals();
  const tasks = useAllTasks();
  const requests = useRequests();
  return needsYou({
    proposals: proposals.data ?? [],
    tasks,
    requests: requests.data ?? [],
  });
}
