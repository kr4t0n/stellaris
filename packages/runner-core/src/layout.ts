import path from "node:path";
import type { Name } from "@stellaris/shared";

/**
 * Every path in a runner's own data directory: the board mirror, agent homes, project
 * repositories and worktrees, and what the runner last synced. The root is made absolute, since
 * paths reach git commands that run inside a repository and CLIs that run inside a worktree.
 */
export class RunnerLayout {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** The read-only mirror of the board's projection that agents read with their file tools. */
  get board(): string {
    return path.join(this.root, "board");
  }

  /** The runner's copy of an agent's home, and the agent's working directory in the society scope. */
  agent(name: Name): string {
    return path.join(this.root, "agents", name);
  }

  /** The repository of a project that lives on this runner. */
  repo(slug: Name): string {
    return path.join(this.root, "repos", slug);
  }

  worktree(agent: Name, slug: Name): string {
    return path.join(this.root, "worktrees", agent, slug);
  }

  /** A task conversation's own worktree. The dot keeps it apart from every project slug. */
  taskWorktree(agent: Name, taskId: string): string {
    return path.join(this.root, "worktrees", agent, ".tasks", taskId);
  }

  /** A proposal's or a topic's conversation's own worktree in a project. */
  threadWorktree(agent: Name, threadId: string): string {
    return path.join(this.root, "worktrees", agent, ".threads", threadId);
  }

  /** The name and token an enrollment returned, with the server they belong to. */
  get credentials(): string {
    return path.join(this.root, "credentials.json");
  }

  /** The hashes a copied tree last agreed on with the server. */
  syncState(tree: string): string {
    return path.join(this.root, "sync", `${tree}.json`);
  }
}
