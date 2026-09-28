import path from "node:path";
import { parseChannelRef, type ChannelRef, type Name, type Ulid } from "@stellaris/shared";

/** Every path under the data directory, in one place, matching the layout in PLAN.md section 4.2. */
export class BoardPaths {
  constructor(readonly dataDir: string) {}

  // Board projection. In v1 this is also the storage of record; only the core library writes it.
  get board(): string {
    return path.join(this.dataDir, "board");
  }
  get society(): string {
    return path.join(this.board, "society");
  }
  societyFile(): string {
    return path.join(this.society, "society.md");
  }
  societyChannels(): string {
    return path.join(this.society, "channels");
  }
  societyChannel(name: Name): string {
    return path.join(this.societyChannels(), name);
  }
  societyKnowledge(): string {
    return path.join(this.society, "knowledge");
  }
  roles(): string {
    return path.join(this.society, "roles");
  }
  role(name: Name): string {
    return path.join(this.roles(), `${name}.md`);
  }
  proposals(): string {
    return path.join(this.society, "proposals");
  }
  proposal(id: Ulid): string {
    return path.join(this.proposals(), `${id}.md`);
  }
  decisions(): string {
    return path.join(this.society, "decisions");
  }
  decision(id: Ulid): string {
    return path.join(this.decisions(), `${id}.md`);
  }
  runners(): string {
    return path.join(this.society, "runners");
  }
  runner(name: Name): string {
    return path.join(this.runners(), `${name}.md`);
  }

  projects(): string {
    return path.join(this.board, "projects");
  }
  project(slug: Name): string {
    return path.join(this.projects(), slug);
  }
  projectFile(slug: Name): string {
    return path.join(this.project(slug), "project.md");
  }
  projectChannels(slug: Name): string {
    return path.join(this.project(slug), "channels");
  }
  projectChannel(slug: Name, name: Name): string {
    return path.join(this.projectChannels(slug), name);
  }
  threads(slug: Name): string {
    return path.join(this.project(slug), "threads");
  }
  thread(slug: Name, taskId: Ulid): string {
    return path.join(this.threads(slug), taskId);
  }
  tasks(slug: Name): string {
    return path.join(this.project(slug), "tasks");
  }
  task(slug: Name, id: Ulid): string {
    return path.join(this.tasks(slug), `${id}.md`);
  }
  projectKnowledge(slug: Name): string {
    return path.join(this.project(slug), "knowledge");
  }
  dashboard(slug: Name): string {
    return path.join(this.project(slug), "dashboard.md");
  }

  channelDir(ref: ChannelRef): string {
    const parsed = parseChannelRef(ref);
    return parsed.project === null
      ? this.societyChannel(parsed.channel)
      : this.projectChannel(parsed.project, parsed.channel);
  }

  messageFile(dir: string, id: Ulid, author: Name): string {
    return path.join(dir, `${id}-${author}.md`);
  }

  // Agent homes: authored by the agent, source of truth on the board server.
  agents(): string {
    return path.join(this.dataDir, "agents");
  }
  agent(name: Name): string {
    return path.join(this.agents(), name);
  }
  agentFile(name: Name): string {
    return path.join(this.agent(name), "agent.json");
  }
  agentRole(name: Name): string {
    return path.join(this.agent(name), "role.md");
  }
  agentMemory(name: Name): string {
    return path.join(this.agent(name), "memory");
  }
  agentMemoryCore(name: Name): string {
    return path.join(this.agentMemory(name), "core.md");
  }
  agentSkills(name: Name): string {
    return path.join(this.agent(name), "skills");
  }
  agentProjects(name: Name): string {
    return path.join(this.agent(name), "projects");
  }
  agentProject(name: Name, slug: Name): string {
    return path.join(this.agentProjects(name), slug);
  }
  agentCursors(name: Name): string {
    return path.join(this.agent(name), "cursors.json");
  }

  // Canonical clones, one per project, owned by the runner. Worktrees hang off these.
  repos(): string {
    return path.join(this.dataDir, "repos");
  }
  repo(slug: Name): string {
    return path.join(this.repos(), slug);
  }

  worktrees(): string {
    return path.join(this.dataDir, "worktrees");
  }
  worktree(agent: Name, slug: Name): string {
    return path.join(this.worktrees(), agent, slug);
  }

  events(): string {
    return path.join(this.dataDir, "events");
  }
  eventLog(): string {
    return path.join(this.events(), "log.jsonl");
  }

  state(): string {
    return path.join(this.dataDir, "state");
  }
  pausedFile(): string {
    return path.join(this.state(), "paused.json");
  }
}
