import type { Ahead, Listed, RemoteSync, WorktreeState } from "./git.js";

/**
 * What a turn's prompt says of its workspace once the runner has prepared it. Code keeps refs and
 * worktrees current where that loses nothing; everything here is left to the agent to decide.
 */
export interface WorkspaceReport {
  readonly defaultBranch: string;
  readonly remote: RemoteSync;
  readonly worktree:
    | {
        /** A task's worktree: what landed on the default branch since its branch forked. */
        readonly kind: "task";
        readonly branch: string;
        readonly state: WorktreeState;
        readonly behind: Ahead;
      }
    | {
        /** The citizen's own worktree, on its own branch, which never lands by itself. */
        readonly kind: "home";
        readonly branch: string;
        readonly state: WorktreeState;
        readonly ownCommits: Listed;
        readonly moved: boolean;
        readonly behind: Ahead;
      }
    | {
        /** A thread's or a channel's worktree, which goes when its conversation ends. */
        readonly kind: "own";
        readonly state: WorktreeState;
        readonly moved: boolean;
        readonly behind: Ahead;
      };
}

function listed(list: Listed): string {
  const more = list.total - list.items.length;
  return `${list.items.map((item) => `\`${item}\``).join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

function commits(n: number): string {
  return n === 1 ? "1 commit" : `${n} commits`;
}

/** The prompt's section on the workspace, or an empty string when there is nothing to say. */
export function renderWorkspaceReport(report: WorkspaceReport): string {
  const { defaultBranch: base, remote, worktree } = report;
  const notes: string[] = [];
  if (remote.fetchError !== undefined) {
    notes.push(
      `Fetching the project's remote failed (${remote.fetchError}), so the code here may be behind it.`,
    );
  }
  if (remote.diverged !== undefined) {
    notes.push(
      `This runner's ${base} and origin/${base} have diverged: ${commits(remote.diverged.here)} only here and ${commits(remote.diverged.there)} only on the remote. Nothing here merges them.`,
    );
  }
  const { state } = worktree;
  if (worktree.kind === "task") {
    if (worktree.behind.commits.total > 0) {
      notes.push(
        `${commits(worktree.behind.commits.total)} landed on ${base} since your branch ${worktree.branch} left it, changing ${listed(worktree.behind.files)}. Merging ${base} into it is your decision.`,
      );
    }
    if (state.onNoBranch.total > 0) {
      notes.push(
        `This worktree holds commits on no branch, so it was left where it is rather than switched to ${worktree.branch}: ${listed(state.onNoBranch)}. Put what matters on ${worktree.branch}.`,
      );
    }
  }
  if (worktree.kind === "home") {
    if (state.branch !== worktree.branch) {
      notes.push(
        `Your worktree is on ${state.branch ?? "a detached commit"}, not on your branch ${worktree.branch}.`,
      );
    }
    if (worktree.ownCommits.total > 0) {
      notes.push(
        `Your branch ${worktree.branch} holds ${commits(worktree.ownCommits.total)} that ${worktree.ownCommits.total === 1 ? "is" : "are"} not on ${base}: ${listed(worktree.ownCommits)}. Nothing lands them by itself: land what matters through a task, by putting it on the task's branch, and drop the rest.`,
      );
    }
  }
  if (worktree.kind !== "task") {
    if (state.uncommitted.total > 0) {
      notes.push(`Uncommitted here: ${listed(state.uncommitted)}.`);
    }
    if (worktree.kind === "own" && state.onNoBranch.total > 0) {
      notes.push(`Commits here on no branch: ${listed(state.onNoBranch)}.`);
    }
    if (worktree.kind === "own" && (state.uncommitted.total > 0 || state.onNoBranch.total > 0)) {
      notes.push(
        "This worktree goes when its conversation ends. Land what matters through a task, by switching this worktree to its branch task/<id> and committing there, and discard the rest.",
      );
    }
    if (!worktree.moved && worktree.behind.commits.total > 0) {
      notes.push(
        `It was not brought up to ${base}, which has ${commits(worktree.behind.commits.total)} it lacks, because of what it holds.`,
      );
    }
  }
  if (notes.length === 0) {
    return "";
  }
  return ["## Your workspace", "", ...notes.map((note) => `- ${note}`)].join("\n");
}

/** Whether a conversation's own workspace holds work no branch does. */
export function holdsLeftovers(state: WorktreeState): boolean {
  return state.uncommitted.total > 0 || state.onNoBranch.total > 0;
}
