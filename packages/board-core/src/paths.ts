import path from "node:path";
import { parseChannelRef, type ChannelRef, type Name, type Ulid } from "@stellaris/shared";

/**
 * Every path under the data directory. The data directory is made absolute: paths reach git
 * commands that run inside a project's clone and CLI processes that run inside a worktree, where
 * a relative path would resolve against those directories instead of the server's.
 */
export class BoardPaths {
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
  }

  // Board projection, also the storage of record; only the core library writes it.
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
  /** Threads whose channel is a society channel; project channels' threads live under the project. */
  societyThreads(): string {
    return path.join(this.society, "threads");
  }
  societyKnowledge(): string {
    return path.join(this.society, "knowledge");
  }
  societyKnowledgeFile(topic: Name): string {
    return path.join(this.societyKnowledge(), `${topic}.md`);
  }
  /** Skills promoted to the society, one directory per skill holding SKILL.md. */
  societySkills(): string {
    return path.join(this.society, "skills");
  }
  societySkill(name: Name): string {
    return path.join(this.societySkills(), name);
  }
  societySkillFile(name: Name): string {
    return path.join(this.societySkill(name), "SKILL.md");
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
  members(): string {
    return path.join(this.society, "members");
  }
  member(name: Name): string {
    return path.join(this.members(), `${name}.md`);
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
  tasks(slug: Name): string {
    return path.join(this.project(slug), "tasks");
  }
  task(slug: Name, id: Ulid): string {
    return path.join(this.tasks(slug), `${id}.md`);
  }
  projectKnowledge(slug: Name): string {
    return path.join(this.project(slug), "knowledge");
  }
  projectKnowledgeFile(slug: Name, topic: Name): string {
    return path.join(this.projectKnowledge(slug), `${topic}.md`);
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

  /** The threads directory of a channel's scope: its project's, or the society's. */
  threadsOf(ref: ChannelRef): string {
    const { project } = parseChannelRef(ref);
    return project === null ? this.societyThreads() : this.threads(project);
  }
  /** A thread's record, `<id>.md`, beside the directory of its messages, `<id>/`. */
  threadFile(threads: string, id: Ulid): string {
    return path.join(threads, `${id}.md`);
  }
  threadMessages(threads: string, id: Ulid): string {
    return path.join(threads, id);
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
  agentProfile(name: Name): string {
    return path.join(this.agent(name), "profile.md");
  }
  agentMemory(name: Name): string {
    return path.join(this.agent(name), "memory");
  }
  agentMemoryCore(name: Name): string {
    return path.join(this.agentMemory(name), "core.md");
  }
  /** Transcripts of the agent's finished turns, one JSON line per step. */
  agentTurns(name: Name): string {
    return path.join(this.agent(name), "turns");
  }
  agentTranscript(name: Name, turnId: string): string {
    return path.join(this.agentTurns(name), `${turnId}.jsonl`);
  }
  agentSkills(name: Name): string {
    return path.join(this.agent(name), "skills");
  }
  agentSkill(name: Name, skill: Name): string {
    return path.join(this.agentSkills(name), skill);
  }
  agentSkillFile(name: Name, skill: Name): string {
    return path.join(this.agentSkill(name, skill), "SKILL.md");
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
