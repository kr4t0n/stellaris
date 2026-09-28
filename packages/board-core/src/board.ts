import { readFile } from "node:fs/promises";
import path from "node:path";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import {
  AgentSchema,
  canTransition,
  channelRef,
  DecisionSchema,
  MessageFrontmatterSchema,
  OWNER_NAME,
  OWNER_ROLE,
  parseChannelRef,
  PROJECT_DEFAULT_CHANNELS,
  ProjectSchema,
  ProposalCharterSchemas,
  ProposalFrontmatterSchema,
  RoleCharterSchema,
  RunnerSchema,
  SEED_ROLES,
  SOCIETY_CHANNELS,
  SocietySchema,
  TaskFrontmatterSchema,
  VerbInputs,
  type Agent,
  type BoardEvent,
  type ChannelRef,
  type CliKind,
  type Decision,
  type Message,
  type MessageFrontmatter,
  type Name,
  type Project,
  type Proposal,
  type RoleCharter,
  type Runner,
  type Society,
  type Task,
  type TaskFrontmatter,
  type TaskStatus,
  type Ulid,
  type VerbInput,
  type VerbName,
  SessionsFileSchema,
  TurnRecordSchema,
  WakeRequestSchema,
  type BoardEvent as BoardLogEvent,
  type SessionsFile,
  type TurnRecord,
  type WakeRequestInput,
} from "@stellaris/shared";
import { BoardError } from "./errors.js";
import { EventLog } from "./events.js";
import {
  ensureDir,
  exists,
  listDirs,
  listFiles,
  readJson,
  readMarkdown,
  writeJson,
  writeMarkdown,
} from "./fs.js";
import { Mutex } from "./mutex.js";
import { BoardPaths } from "./paths.js";
import { hashToken, mintToken } from "./tokens.js";

/** Who is acting. Resolved by the caller from a bearer token, never taken from verb arguments. */
export interface Actor {
  readonly name: Name;
  readonly role: Name;
}

/** The board itself, for posts and events produced by infrastructure rather than a member. */
export const SYSTEM_ACTOR: Actor = { name: "board", role: OWNER_ROLE };

export interface BoardOptions {
  /** Lease duration for claims. Renewed by every turn that touches the task. */
  readonly leaseMs?: number | undefined;
  /** Clock, injectable for tests. */
  readonly now?: (() => Date) | undefined;
}

export interface InitInput {
  readonly name: string;
}

export interface AddProjectInput {
  readonly slug: Name;
  readonly name?: string | undefined;
  readonly repo?: string | null | undefined;
  readonly defaultBranch?: string | undefined;
  readonly channels?: readonly Name[] | undefined;
  readonly requiredCapabilities?: readonly string[] | undefined;
}

export interface AddAgentInput {
  readonly name: Name;
  readonly role: Name;
  readonly cli: CliKind | null;
  readonly model?: string | undefined;
  readonly homeRunner?: Name | undefined;
  readonly memberships?: readonly Name[] | undefined;
  readonly subscriptions?: readonly ChannelRef[] | undefined;
}

export interface InboxResult {
  readonly messages: Message[];
  readonly cursor: Ulid | null;
}

export interface SearchHit {
  readonly kind: "message" | "task" | "knowledge";
  readonly ref: string;
  readonly snippet: string;
}

export interface TaskLocation {
  readonly project: Name;
  readonly file: string;
  readonly task: Task;
}

const CursorsSchema = z.object({ inbox: z.string().nullable() });
const PausedSchema = z.object({ paused: z.boolean() });

const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const MENTION_PATTERN = /(^|[^\w@])@([a-z0-9][a-z0-9-]{0,31})(?![\w-])/g;
const LOCAL_RUNNER: Name = "local";

const ROLE_KIND_APPROVERS: Readonly<Record<string, readonly Name[]>> = {
  // Tool-set changes and hiring always require the owner; the steward may decide the rest.
  role: [OWNER_ROLE],
  member: [OWNER_ROLE],
  channel: [OWNER_ROLE, "steward"],
  reallocation: [OWNER_ROLE, "steward"],
};

function extractMentions(body: string): Name[] {
  const found = new Set<Name>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const name = match[2];
    if (name !== undefined) {
      found.add(name);
    }
  }
  return [...found].toSorted();
}

function snippetAround(text: string, query: string, radius = 80): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) {
    return text
      .slice(0, radius * 2)
      .replace(/\s+/g, " ")
      .trim();
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * The board's single writer. Every mutation goes through one mutex in one process, validates its
 * input against the shared verb schemas, checks the actor's role charter, and appends an event.
 */
export class Board {
  readonly paths: BoardPaths;
  private readonly mutex = new Mutex();
  private readonly newId = monotonicFactory();
  private readonly events: EventLog;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private readonly roleCache = new Map<Name, RoleCharter>();
  private readonly tokenIndex = new Map<string, Actor>();
  private readonly turnTokens = new Map<string, { actor: Actor; expiresAt: number }>();

  private constructor(dataDir: string, options: BoardOptions) {
    this.paths = new BoardPaths(dataDir);
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? (() => new Date());
    this.events = new EventLog(this.paths.eventLog(), () => this.newId(), this.now);
  }

  /** Creates a society: channels, seed roles, the local runner, and the owner. Returns the owner token once. */
  static async init(
    dataDir: string,
    input: InitInput,
    options: BoardOptions = {},
  ): Promise<{ board: Board; ownerToken: string }> {
    const board = new Board(dataDir, options);
    if (await exists(board.paths.societyFile())) {
      throw new BoardError("ALREADY_EXISTS", `a society already exists in ${dataDir}`);
    }
    const ownerToken = await board.mutex.run(() => board.initialize(input));
    return { board, ownerToken };
  }

  static async open(dataDir: string, options: BoardOptions = {}): Promise<Board> {
    const board = new Board(dataDir, options);
    if (!(await exists(board.paths.societyFile()))) {
      throw new BoardError("NOT_FOUND", `no society found in ${dataDir}; run init first`);
    }
    await board.loadTokenIndex();
    return board;
  }

  // ---------------------------------------------------------------------------------------------
  // Identity and authorization
  // ---------------------------------------------------------------------------------------------

  /** Maps a bearer token to an actor, or null when unknown. Constant work per call after load. */
  resolveToken(token: string): Actor | null {
    const hash = hashToken(token);
    const persistent = this.tokenIndex.get(hash);
    if (persistent !== undefined) {
      return persistent;
    }
    const temporary = this.turnTokens.get(hash);
    if (temporary === undefined) {
      return null;
    }
    if (temporary.expiresAt <= this.now().getTime()) {
      this.turnTokens.delete(hash);
      return null;
    }
    return temporary.actor;
  }

  /**
   * A short-lived token for one turn, handed to the CLI by the runner. Only its hash is kept,
   * in memory, until it expires, so no raw agent token ever needs to exist at rest.
   */
  issueTurnToken(agent: Name, role: Name, ttlMs: number): string {
    const token = mintToken();
    this.turnTokens.set(hashToken(token), {
      actor: { name: agent, role },
      expiresAt: this.now().getTime() + ttlMs,
    });
    return token;
  }

  ownerActor(): Actor {
    return { name: OWNER_NAME, role: OWNER_ROLE };
  }

  async actorFor(name: Name): Promise<Actor> {
    const agent = await this.readAgent(name);
    return { name: agent.name, role: agent.role };
  }

  private async authorize(actor: Actor, verb: VerbName): Promise<void> {
    if (actor.role === OWNER_ROLE) {
      return;
    }
    const charter = await this.readRole(actor.role);
    if (!charter.verbs.includes(verb)) {
      throw new BoardError("FORBIDDEN", `role ${actor.role} may not ${verb}`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  async society(): Promise<Society> {
    return (await readMarkdown(this.paths.societyFile(), SocietySchema)).data;
  }

  async listProjects(): Promise<Project[]> {
    const slugs = await listDirs(this.paths.projects());
    return Promise.all(slugs.map((slug) => this.readProject(slug)));
  }

  async readProject(slug: Name): Promise<Project> {
    const file = this.paths.projectFile(slug);
    if (!(await exists(file))) {
      throw new BoardError("NOT_FOUND", `project ${slug} not found`);
    }
    return (await readMarkdown(file, ProjectSchema)).data;
  }

  async listAgents(): Promise<Agent[]> {
    const names = await listDirs(this.paths.agents());
    const agents: Agent[] = [];
    for (const name of names) {
      if (await exists(this.paths.agentFile(name))) {
        agents.push(await this.readAgent(name));
      }
    }
    return agents;
  }

  async readAgent(name: Name): Promise<Agent> {
    const file = this.paths.agentFile(name);
    if (!(await exists(file))) {
      throw new BoardError("NOT_FOUND", `agent ${name} not found`);
    }
    return readJson(file, AgentSchema);
  }

  async readRole(name: Name): Promise<RoleCharter> {
    const cached = this.roleCache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const file = this.paths.role(name);
    if (!(await exists(file))) {
      throw new BoardError("NOT_FOUND", `role ${name} not found`);
    }
    const charter = (await readMarkdown(file, RoleCharterSchema)).data;
    this.roleCache.set(name, charter);
    return charter;
  }

  async listRoles(): Promise<RoleCharter[]> {
    const files = await listFiles(this.paths.roles());
    return Promise.all(files.map((file) => this.readRole(file.replace(/\.md$/, ""))));
  }

  async listTasks(project: Name): Promise<Task[]> {
    await this.readProject(project);
    const files = await listFiles(this.paths.tasks(project));
    const tasks: Task[] = [];
    for (const file of files) {
      const doc = await readMarkdown(
        path.join(this.paths.tasks(project), file),
        TaskFrontmatterSchema,
      );
      tasks.push({ ...doc.data, body: doc.body });
    }
    return tasks;
  }

  async findTask(id: Ulid): Promise<TaskLocation> {
    for (const project of await listDirs(this.paths.projects())) {
      const file = this.paths.task(project, id);
      if (await exists(file)) {
        const doc = await readMarkdown(file, TaskFrontmatterSchema);
        return { project, file, task: { ...doc.data, body: doc.body } };
      }
    }
    throw new BoardError("NOT_FOUND", `task ${id} not found`);
  }

  async listProposals(): Promise<Proposal[]> {
    const files = await listFiles(this.paths.proposals());
    const proposals: Proposal[] = [];
    for (const file of files) {
      const doc = await readMarkdown(
        path.join(this.paths.proposals(), file),
        ProposalFrontmatterSchema,
      );
      proposals.push({ ...doc.data, body: doc.body });
    }
    return proposals;
  }

  async readProposal(id: Ulid): Promise<Proposal> {
    const file = this.paths.proposal(id);
    if (!(await exists(file))) {
      throw new BoardError("NOT_FOUND", `proposal ${id} not found`);
    }
    const doc = await readMarkdown(file, ProposalFrontmatterSchema);
    return { ...doc.data, body: doc.body };
  }

  async readEvents(since: Ulid | null, limit?: number): Promise<BoardEvent[]> {
    return this.events.readSince(since, limit);
  }

  async isPaused(): Promise<boolean> {
    const file = this.paths.pausedFile();
    if (!(await exists(file))) {
      return false;
    }
    return (await readJson(file, PausedSchema)).paused;
  }

  /** Every message in a channel, oldest first. Thread messages are listed with `listThread`. */
  async listChannel(ref: ChannelRef, limit = 200): Promise<Message[]> {
    await this.assertChannelExists(ref);
    const messages = await this.readMessagesIn(this.paths.channelDir(ref), null);
    return messages.slice(-limit);
  }

  async listThread(taskId: Ulid): Promise<Message[]> {
    const location = await this.findTask(taskId);
    return this.readMessagesIn(this.paths.thread(location.project, taskId), null);
  }

  // ---------------------------------------------------------------------------------------------
  // Administration (owner and steward)
  // ---------------------------------------------------------------------------------------------

  async addProject(actor: Actor, input: AddProjectInput): Promise<Project> {
    this.assertAdmin(actor);
    return this.mutex.run(async () => {
      const file = this.paths.projectFile(input.slug);
      if (await exists(file)) {
        throw new BoardError("ALREADY_EXISTS", `project ${input.slug} already exists`);
      }
      const project: Project = ProjectSchema.parse({
        slug: input.slug,
        name: input.name ?? input.slug,
        repo: input.repo ?? null,
        defaultBranch: input.defaultBranch ?? "main",
        channels: [...(input.channels ?? PROJECT_DEFAULT_CHANNELS)],
        members: [],
        approvers: [OWNER_NAME],
        requiredCapabilities: [...(input.requiredCapabilities ?? [])],
        createdAt: this.now().toISOString(),
      });
      await writeMarkdown(file, project, `# ${project.name}\n`);
      for (const channel of project.channels) {
        await ensureDir(this.paths.projectChannel(project.slug, channel));
      }
      await ensureDir(this.paths.tasks(project.slug));
      await ensureDir(this.paths.threads(project.slug));
      await ensureDir(this.paths.projectKnowledge(project.slug));
      await writeMarkdown(
        this.paths.dashboard(project.slug),
        { project: project.slug, updatedAt: this.now().toISOString() },
        `# ${project.name} dashboard\n\nAgents may edit this file. It is rendered by the board UI.\n`,
      );
      // The owner follows every project's general channel by default.
      await this.updateAgent(OWNER_NAME, (owner) => ({
        ...owner,
        memberships: [...new Set([...owner.memberships, project.slug])],
        subscriptions: [...new Set([...owner.subscriptions, channelRef(project.slug, "general")])],
      }));
      await this.events.append("project.added", actor.name, {
        slug: project.slug,
        name: project.name,
      });
      return project;
    });
  }

  /** Adds a member. Returns the bearer token once; only its hash is stored. */
  async addAgent(actor: Actor, input: AddAgentInput): Promise<{ agent: Agent; token: string }> {
    this.assertAdmin(actor);
    return this.mutex.run(async () => {
      if (await exists(this.paths.agentFile(input.name))) {
        throw new BoardError("ALREADY_EXISTS", `agent ${input.name} already exists`);
      }
      const charter = await this.readRole(input.role);
      const memberships = [...(input.memberships ?? [])];
      for (const slug of memberships) {
        await this.readProject(slug);
      }
      const defaultSubscriptions: ChannelRef[] = [
        "general",
        ...memberships.map((slug) => channelRef(slug, "general")),
      ];
      const subscriptions = [...new Set([...defaultSubscriptions, ...(input.subscriptions ?? [])])];
      for (const ref of subscriptions) {
        await this.assertChannelExists(ref);
      }
      const token = mintToken();
      const agent: Agent = AgentSchema.parse({
        name: input.name,
        role: input.role,
        cli: input.cli,
        ...(input.model === undefined ? {} : { model: input.model }),
        homeRunner: input.homeRunner ?? LOCAL_RUNNER,
        memberships,
        subscriptions,
        status: "active",
        createdAt: this.now().toISOString(),
        tokenHash: hashToken(token),
      });
      await this.writeAgentHome(agent, charter);
      for (const slug of memberships) {
        await this.updateProjectMembers(slug, agent.name);
      }
      await this.events.append("agent.added", actor.name, {
        name: agent.name,
        role: agent.role,
        cli: agent.cli,
        memberships,
      });
      return { agent, token };
    });
  }

  async setPaused(actor: Actor, paused: boolean): Promise<void> {
    if (actor.role !== OWNER_ROLE) {
      throw new BoardError("FORBIDDEN", "only the owner may pause or resume the society");
    }
    await this.mutex.run(async () => {
      await writeJson(this.paths.pausedFile(), { paused });
      await this.events.append("paused.changed", actor.name, { paused });
    });
  }

  /** Releases every claim whose lease has expired. Called by the scheduler on its tick. */
  async expireLeases(): Promise<Task[]> {
    return this.mutex.run(async () => {
      const expired: Task[] = [];
      const now = this.now();
      for (const project of await listDirs(this.paths.projects())) {
        for (const task of await this.listTasks(project)) {
          if (task.status === "claimed" && this.leaseExpired(task, now)) {
            const released = await this.writeTask(project, {
              ...task,
              status: "open",
              claimedBy: undefined,
              leaseExpiresAt: undefined,
              updatedAt: now.toISOString(),
            });
            await this.events.append("lease.expired", task.claimedBy ?? OWNER_NAME, {
              taskId: task.id,
              project,
            });
            expired.push(released);
          }
        }
      }
      return expired;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Verbs
  // ---------------------------------------------------------------------------------------------

  async postMessage(actor: Actor, input: VerbInput<"post_message">): Promise<Message> {
    const args = VerbInputs.post_message.parse(input);
    await this.authorize(actor, "post_message");
    return this.mutex.run(async () => {
      await this.assertChannelExists(args.channel);
      let dir = this.paths.channelDir(args.channel);
      if (args.thread_id !== undefined) {
        const location = await this.findTask(args.thread_id);
        if (location.task.thread !== "open") {
          throw new BoardError("INVALID_STATE", `thread for task ${args.thread_id} is not open`);
        }
        dir = this.paths.thread(location.project, args.thread_id);
      }
      const frontmatter: MessageFrontmatter = MessageFrontmatterSchema.parse({
        id: this.newId(),
        author: actor.name,
        channel: args.channel,
        ...(args.thread_id === undefined ? {} : { thread: args.thread_id }),
        ts: this.now().toISOString(),
        mentions: extractMentions(args.body),
      });
      await writeMarkdown(
        this.paths.messageFile(dir, frontmatter.id, actor.name),
        frontmatter,
        args.body,
      );
      await this.events.append("message.posted", actor.name, {
        id: frontmatter.id,
        channel: frontmatter.channel,
        thread: frontmatter.thread ?? null,
        mentions: frontmatter.mentions,
      });
      return { ...frontmatter, body: args.body };
    });
  }

  async readInbox(actor: Actor, input: VerbInput<"read_inbox"> = {}): Promise<InboxResult> {
    const args = VerbInputs.read_inbox.parse(input);
    await this.authorize(actor, "read_inbox");
    return this.mutex.run(async () => {
      const agent = await this.readAgent(actor.name);
      const cursorFile = this.paths.agentCursors(actor.name);
      const stored = (await exists(cursorFile))
        ? await readJson(cursorFile, CursorsSchema)
        : { inbox: null };
      const since = args.since_cursor === undefined ? stored.inbox : args.since_cursor;
      const subscribed = new Set(agent.subscriptions);
      const threadParticipation = new Map<Ulid, boolean>();
      const collected: Message[] = [];

      for await (const message of this.iterateMessages(since)) {
        let include = message.mentions.includes(actor.name);
        if (!include && message.thread === undefined) {
          include = subscribed.has(message.channel);
        }
        if (!include && message.thread !== undefined) {
          let participates = threadParticipation.get(message.thread);
          if (participates === undefined) {
            participates = await this.participatesInThread(actor, message.thread);
            threadParticipation.set(message.thread, participates);
          }
          include = participates;
        }
        if (include && message.author !== actor.name) {
          collected.push(message);
        }
      }

      collected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const messages = collected.slice(0, args.limit);
      const last = messages.at(-1);
      const cursor = last === undefined ? since : last.id;
      if (args.advance && cursor !== stored.inbox) {
        await writeJson(cursorFile, { inbox: cursor });
      }
      return { messages, cursor };
    });
  }

  async search(actor: Actor, input: VerbInput<"search">): Promise<SearchHit[]> {
    const args = VerbInputs.search.parse(input);
    await this.authorize(actor, "search");
    const needle = args.query.toLowerCase();
    const hits: SearchHit[] = [];
    const projectFilter =
      args.project ??
      (args.channel === undefined ? undefined : parseChannelRef(args.channel).project);

    for await (const message of this.iterateMessages(null, projectFilter ?? undefined)) {
      if (args.channel !== undefined && message.channel !== args.channel) {
        continue;
      }
      if (message.body.toLowerCase().includes(needle)) {
        hits.push({
          kind: "message",
          ref: `${message.channel}#${message.id}`,
          snippet: snippetAround(message.body, args.query),
        });
        if (hits.length >= args.limit) {
          return hits;
        }
      }
    }
    const projects =
      projectFilter === undefined || projectFilter === null
        ? await listDirs(this.paths.projects())
        : [projectFilter];
    for (const project of projects) {
      for (const task of await this.listTasks(project)) {
        const haystack = `${task.title}\n${task.body}`;
        if (haystack.toLowerCase().includes(needle)) {
          hits.push({
            kind: "task",
            ref: `${project}/tasks/${task.id}`,
            snippet: snippetAround(haystack, args.query),
          });
          if (hits.length >= args.limit) {
            return hits;
          }
        }
      }
      for (const file of await listFiles(this.paths.projectKnowledge(project))) {
        const content = await readFile(
          path.join(this.paths.projectKnowledge(project), file),
          "utf8",
        );
        if (content.toLowerCase().includes(needle)) {
          hits.push({
            kind: "knowledge",
            ref: `${project}/knowledge/${file}`,
            snippet: snippetAround(content, args.query),
          });
          if (hits.length >= args.limit) {
            return hits;
          }
        }
      }
    }
    return hits;
  }

  async openThread(actor: Actor, input: VerbInput<"open_thread">): Promise<Task> {
    const args = VerbInputs.open_thread.parse(input);
    await this.authorize(actor, "open_thread");
    return this.mutex.run(async () => {
      const location = await this.findTask(args.task_id);
      if (location.task.thread !== "none") {
        throw new BoardError(
          "INVALID_STATE",
          `thread for task ${args.task_id} is already ${location.task.thread}`,
        );
      }
      await ensureDir(this.paths.thread(location.project, args.task_id));
      const task = await this.writeTask(location.project, {
        ...location.task,
        thread: "open",
        updatedAt: this.now().toISOString(),
      });
      await this.events.append("thread.opened", actor.name, {
        taskId: task.id,
        project: location.project,
      });
      return task;
    });
  }

  async closeThread(actor: Actor, input: VerbInput<"close_thread">): Promise<Message> {
    const args = VerbInputs.close_thread.parse(input);
    await this.authorize(actor, "close_thread");
    return this.mutex.run(async () => {
      const location = await this.findTask(args.thread_id);
      if (location.task.thread !== "open") {
        throw new BoardError("INVALID_STATE", `thread for task ${args.thread_id} is not open`);
      }
      const mayClose =
        location.task.claimedBy === actor.name ||
        ["reviewer", "steward", OWNER_ROLE].includes(actor.role);
      if (!mayClose) {
        throw new BoardError(
          "FORBIDDEN",
          "only the claimer, a reviewer, the steward, or the owner may close a thread",
        );
      }
      const channel = channelRef(location.project, "general");
      const frontmatter: MessageFrontmatter = MessageFrontmatterSchema.parse({
        id: this.newId(),
        author: actor.name,
        channel,
        task: args.thread_id,
        ts: this.now().toISOString(),
        mentions: extractMentions(args.summary),
      });
      const body = `Thread closed for task ${location.task.id} "${location.task.title}".\n\n${args.summary}`;
      await writeMarkdown(
        this.paths.messageFile(this.paths.channelDir(channel), frontmatter.id, actor.name),
        frontmatter,
        body,
      );
      await this.writeTask(location.project, {
        ...location.task,
        thread: "closed",
        updatedAt: this.now().toISOString(),
      });
      await this.events.append("thread.closed", actor.name, {
        taskId: location.task.id,
        project: location.project,
      });
      await this.events.append("message.posted", actor.name, {
        id: frontmatter.id,
        channel,
        thread: null,
        mentions: frontmatter.mentions,
      });
      return { ...frontmatter, body };
    });
  }

  async createTask(actor: Actor, input: VerbInput<"create_task">): Promise<Task> {
    const args = VerbInputs.create_task.parse(input);
    await this.authorize(actor, "create_task");
    return this.mutex.run(async () => {
      await this.readProject(args.project);
      if (args.parent_id !== undefined) {
        const parent = await this.findTask(args.parent_id);
        if (parent.project !== args.project) {
          throw new BoardError("VALIDATION", "a subtask must belong to its parent's project");
        }
      }
      const ts = this.now().toISOString();
      const frontmatter: TaskFrontmatter = TaskFrontmatterSchema.parse({
        id: this.newId(),
        project: args.project,
        title: args.title,
        status: "open",
        thread: "none",
        createdBy: actor.name,
        createdAt: ts,
        updatedAt: ts,
        ...(args.parent_id === undefined ? {} : { parentId: args.parent_id }),
        blockedBy: [],
        requiredCapabilities: args.required_capabilities,
      });
      const task = await this.writeTask(args.project, { ...frontmatter, body: args.body });
      await this.events.append("task.created", actor.name, {
        taskId: task.id,
        project: task.project,
        title: task.title,
        parentId: task.parentId ?? null,
      });
      return task;
    });
  }

  async claimTask(actor: Actor, input: VerbInput<"claim_task">): Promise<Task> {
    const args = VerbInputs.claim_task.parse(input);
    await this.authorize(actor, "claim_task");
    return this.mutex.run(async () => {
      const location = await this.findTask(args.task_id);
      const current = location.task;
      const now = this.now();
      if (
        current.status === "claimed" &&
        current.claimedBy === actor.name &&
        !this.leaseExpired(current, now)
      ) {
        return this.writeTask(location.project, {
          ...current,
          leaseExpiresAt: this.leaseEnd(now),
          updatedAt: now.toISOString(),
        });
      }
      if (current.status === "claimed" && this.leaseExpired(current, now)) {
        await this.events.append("lease.expired", current.claimedBy ?? OWNER_NAME, {
          taskId: current.id,
          project: location.project,
        });
      } else if (current.status === "claimed") {
        throw new BoardError(
          "CLAIM_CONFLICT",
          `task ${current.id} is held by ${current.claimedBy ?? "someone"}`,
        );
      } else if (current.status !== "open") {
        throw new BoardError(
          "INVALID_TRANSITION",
          `task ${current.id} is ${current.status}, not open`,
        );
      }
      const task = await this.writeTask(location.project, {
        ...current,
        status: "claimed",
        claimedBy: actor.name,
        leaseExpiresAt: this.leaseEnd(now),
        updatedAt: now.toISOString(),
      });
      await this.events.append("task.claimed", actor.name, {
        taskId: task.id,
        project: location.project,
      });
      return task;
    });
  }

  async releaseTask(actor: Actor, input: VerbInput<"release_task">): Promise<Task> {
    const args = VerbInputs.release_task.parse(input);
    await this.authorize(actor, "release_task");
    return this.mutex.run(async () => {
      const location = await this.findTask(args.task_id);
      const current = location.task;
      if (current.status !== "claimed") {
        throw new BoardError(
          "INVALID_TRANSITION",
          `task ${current.id} is ${current.status}, not claimed`,
        );
      }
      if (current.claimedBy !== actor.name && !["steward", OWNER_ROLE].includes(actor.role)) {
        throw new BoardError(
          "FORBIDDEN",
          "only the claimer, the steward, or the owner may release a task",
        );
      }
      const task = await this.writeTask(location.project, {
        ...current,
        status: "open",
        claimedBy: undefined,
        leaseExpiresAt: undefined,
        updatedAt: this.now().toISOString(),
      });
      await this.events.append("task.released", actor.name, {
        taskId: task.id,
        project: location.project,
      });
      return task;
    });
  }

  async updateTask(actor: Actor, input: VerbInput<"update_task">): Promise<Task> {
    const args = VerbInputs.update_task.parse(input);
    await this.authorize(actor, "update_task");
    return this.mutex.run(async () => {
      const location = await this.findTask(args.task_id);
      const current = location.task;
      const now = this.now();
      let next: Task = { ...current, updatedAt: now.toISOString() };

      if (args.status !== undefined && args.status !== current.status) {
        this.assertTransition(actor, current, args.status);
        next = { ...next, status: args.status };
        if (args.status === "done" || args.status === "abandoned" || args.status === "open") {
          next = { ...next, leaseExpiresAt: undefined };
          if (args.status === "open") {
            next = { ...next, claimedBy: undefined };
          }
        }
      }
      if (args.blocked_by !== undefined) {
        for (const id of args.blocked_by) {
          await this.findTask(id);
        }
        next = { ...next, blockedBy: [...args.blocked_by] };
      }
      if (args.note !== undefined) {
        const heading =
          next.body.includes("\n## Notes") || next.body.startsWith("## Notes")
            ? ""
            : "\n## Notes\n";
        const base =
          next.body.length === 0 ? "" : next.body.endsWith("\n") ? next.body : `${next.body}\n`;
        next = {
          ...next,
          body: `${base}${heading}- ${now.toISOString()} @${actor.name}: ${args.note}\n`,
        };
      }
      if (next.status === "claimed" && next.claimedBy === actor.name) {
        next = { ...next, leaseExpiresAt: this.leaseEnd(now) };
      }

      const task = await this.writeTask(location.project, next);
      await this.events.append("task.updated", actor.name, {
        taskId: task.id,
        project: location.project,
        from: current.status,
        to: task.status,
        note: args.note ?? null,
      });
      return task;
    });
  }

  async getTask(actor: Actor, input: VerbInput<"get_task">): Promise<Task> {
    const args = VerbInputs.get_task.parse(input);
    await this.authorize(actor, "get_task");
    return (await this.findTask(args.task_id)).task;
  }

  async subscribe(actor: Actor, input: VerbInput<"subscribe">): Promise<Agent> {
    const args = VerbInputs.subscribe.parse(input);
    await this.authorize(actor, "subscribe");
    return this.mutex.run(async () => {
      await this.assertChannelExists(args.channel);
      const agent = await this.updateAgent(actor.name, (a) => ({
        ...a,
        subscriptions: [...new Set([...a.subscriptions, args.channel])],
      }));
      await this.events.append("subscription.changed", actor.name, {
        channel: args.channel,
        subscribed: true,
      });
      return agent;
    });
  }

  async unsubscribe(actor: Actor, input: VerbInput<"unsubscribe">): Promise<Agent> {
    const args = VerbInputs.unsubscribe.parse(input);
    await this.authorize(actor, "unsubscribe");
    return this.mutex.run(async () => {
      const agent = await this.updateAgent(actor.name, (a) => ({
        ...a,
        subscriptions: a.subscriptions.filter((ref) => ref !== args.channel),
      }));
      await this.events.append("subscription.changed", actor.name, {
        channel: args.channel,
        subscribed: false,
      });
      return agent;
    });
  }

  async propose(actor: Actor, input: VerbInput<"propose">): Promise<Proposal> {
    const args = VerbInputs.propose.parse(input);
    await this.authorize(actor, "propose");
    const schema = ProposalCharterSchemas[args.kind];
    const parsed = schema.safeParse(args.charter);
    if (!parsed.success) {
      throw new BoardError("VALIDATION", `invalid ${args.kind} charter: ${parsed.error.message}`);
    }
    return this.mutex.run(async () => {
      const proposal: Proposal = {
        ...ProposalFrontmatterSchema.parse({
          id: this.newId(),
          kind: args.kind,
          proposedBy: actor.name,
          status: "proposed",
          createdAt: this.now().toISOString(),
          charter: parsed.data,
        }),
        body: args.rationale,
      };
      await this.writeProposal(proposal);
      await this.events.append("proposal.created", actor.name, {
        proposalId: proposal.id,
        kind: proposal.kind,
      });
      return proposal;
    });
  }

  async approve(actor: Actor, input: VerbInput<"approve">): Promise<Decision> {
    const args = VerbInputs.approve.parse(input);
    await this.authorize(actor, "approve");
    return this.decide(actor, args.proposal_id, "approved", args.reason);
  }

  async reject(actor: Actor, input: VerbInput<"reject">): Promise<Decision> {
    const args = VerbInputs.reject.parse(input);
    await this.authorize(actor, "reject");
    return this.decide(actor, args.proposal_id, "rejected", args.reason);
  }

  // ---------------------------------------------------------------------------------------------
  // Runtime support for the scheduler and runners: dispatch, wakes, turns, sessions, state
  // ---------------------------------------------------------------------------------------------

  /** Dispatches any verb by name. Shared by the HTTP route and the MCP endpoint. */
  async invoke(actor: Actor, verb: VerbName, input: unknown): Promise<unknown> {
    switch (verb) {
      case "post_message":
        return this.postMessage(actor, VerbInputs.post_message.parse(input));
      case "read_inbox":
        return this.readInbox(actor, VerbInputs.read_inbox.parse(input));
      case "search":
        return this.search(actor, VerbInputs.search.parse(input));
      case "open_thread":
        return this.openThread(actor, VerbInputs.open_thread.parse(input));
      case "close_thread":
        return this.closeThread(actor, VerbInputs.close_thread.parse(input));
      case "create_task":
        return this.createTask(actor, VerbInputs.create_task.parse(input));
      case "claim_task":
        return this.claimTask(actor, VerbInputs.claim_task.parse(input));
      case "release_task":
        return this.releaseTask(actor, VerbInputs.release_task.parse(input));
      case "update_task":
        return this.updateTask(actor, VerbInputs.update_task.parse(input));
      case "get_task":
        return this.getTask(actor, VerbInputs.get_task.parse(input));
      case "subscribe":
        return this.subscribe(actor, VerbInputs.subscribe.parse(input));
      case "unsubscribe":
        return this.unsubscribe(actor, VerbInputs.unsubscribe.parse(input));
      case "propose":
        return this.propose(actor, VerbInputs.propose.parse(input));
      case "approve":
        return this.approve(actor, VerbInputs.approve.parse(input));
      case "reject":
        return this.reject(actor, VerbInputs.reject.parse(input));
      default:
        throw new BoardError("VALIDATION", `unknown verb ${String(verb)}`);
    }
  }

  /** The admin CLI's manual wake. It becomes a `wake.requested` event the scheduler consumes. */
  async requestWake(actor: Actor, input: WakeRequestInput): Promise<BoardLogEvent> {
    this.assertAdmin(actor);
    const args = WakeRequestSchema.parse(input);
    const agent = await this.readAgent(args.agent);
    await this.readProject(args.project);
    if (!agent.memberships.includes(args.project)) {
      throw new BoardError("VALIDATION", `${args.agent} is not a member of ${args.project}`);
    }
    return this.mutex.run(() =>
      this.events.append("wake.requested", actor.name, {
        agent: args.agent,
        project: args.project,
        reason: args.reason,
      }),
    );
  }

  async projectMembers(project: Name): Promise<Agent[]> {
    const agents = await this.listAgents();
    return agents.filter(
      (agent) => agent.status === "active" && agent.memberships.includes(project),
    );
  }

  async membersWithRole(project: Name, role: Name): Promise<Agent[]> {
    return (await this.projectMembers(project)).filter((agent) => agent.role === role);
  }

  /** Tasks an agent currently holds, across every project. */
  async heldClaims(agent: Name): Promise<Task[]> {
    const held: Task[] = [];
    for (const project of await listDirs(this.paths.projects())) {
      for (const task of await this.listTasks(project)) {
        if (task.status === "claimed" && task.claimedBy === agent) {
          held.push(task);
        }
      }
    }
    return held;
  }

  async openTasks(project: Name): Promise<Task[]> {
    return (await this.listTasks(project)).filter((task) => task.status === "open");
  }

  async readAgentRoleBody(agent: Name): Promise<string> {
    const file = this.paths.agentRole(agent);
    return (await exists(file))
      ? (await readMarkdown(file, z.record(z.string(), z.unknown()))).body
      : "";
  }

  async readMemoryCore(agent: Name): Promise<string> {
    const file = this.paths.agentMemoryCore(agent);
    return (await exists(file))
      ? (await readMarkdown(file, z.record(z.string(), z.unknown()))).body
      : "";
  }

  async setInboxCursor(agent: Name, cursor: Ulid | null): Promise<void> {
    await this.mutex.run(() => writeJson(this.paths.agentCursors(agent), { inbox: cursor }));
  }

  async readSessions(agent: Name, project: Name): Promise<SessionsFile> {
    const file = path.join(this.paths.agentProject(agent, project), "sessions.json");
    return (await exists(file)) ? readJson(file, SessionsFileSchema) : {};
  }

  async writeSession(agent: Name, project: Name, cli: CliKind, sessionId: string): Promise<void> {
    await this.mutex.run(async () => {
      const dir = this.paths.agentProject(agent, project);
      await ensureDir(dir);
      const file = path.join(dir, "sessions.json");
      const current = (await exists(file)) ? await readJson(file, SessionsFileSchema) : {};
      await writeJson(file, { ...current, [cli]: sessionId });
    });
  }

  async readLastTurn(agent: Name, project: Name): Promise<TurnRecord | null> {
    const file = path.join(this.paths.agentProject(agent, project), "last-turn.json");
    return (await exists(file)) ? readJson(file, TurnRecordSchema) : null;
  }

  /** Records a turn's start so a crash leaves evidence for the next turn. */
  async beginTurn(record: TurnRecord): Promise<void> {
    const parsed = TurnRecordSchema.parse(record);
    await this.mutex.run(async () => {
      await this.writeTurnRecord(parsed);
      await this.events.append("turn.started", parsed.agent, {
        project: parsed.project,
        trigger: parsed.trigger.kind,
        session: parsed.session,
        runner: parsed.runner,
      });
    });
  }

  /** Records a turn's end. Timeouts and errors become `turn.failed`; everything else `turn.completed`. */
  async finishTurn(record: TurnRecord): Promise<void> {
    const parsed = TurnRecordSchema.parse(record);
    const failed = parsed.exitReason === "error" || parsed.exitReason === "timeout";
    await this.mutex.run(async () => {
      await this.writeTurnRecord(parsed);
      await this.events.append(failed ? "turn.failed" : "turn.completed", parsed.agent, {
        project: parsed.project,
        trigger: parsed.trigger.kind,
        session: parsed.session,
        exitReason: parsed.exitReason,
        costUsd: parsed.costUsd,
        toolCalls: parsed.toolCalls,
        summary: parsed.status?.summary ?? null,
        needsOwnerDecision: parsed.status?.needsOwnerDecision ?? false,
        error: parsed.error,
      });
    });
  }

  async recordMerge(
    actor: Actor,
    input: { project: Name; taskId: Ulid; branch: string; ok: boolean; detail: string },
  ): Promise<void> {
    await this.mutex.run(async () => {
      await this.events.append(input.ok ? "merge.completed" : "merge.failed", actor.name, {
        project: input.project,
        taskId: input.taskId,
        branch: input.branch,
        detail: input.detail,
      });
    });
  }

  /** Small named state files under data/state, for cursors the scheduler must keep across restarts. */
  async readState<T>(name: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
    const file = path.join(this.paths.state(), `${name}.json`);
    return (await exists(file)) ? readJson(file, schema) : fallback;
  }

  async writeState(name: string, value: unknown): Promise<void> {
    await this.mutex.run(() => writeJson(path.join(this.paths.state(), `${name}.json`), value));
  }

  private async writeTurnRecord(record: TurnRecord): Promise<void> {
    const dir = this.paths.agentProject(record.agent, record.project);
    await ensureDir(dir);
    await writeJson(path.join(dir, "last-turn.json"), record);
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  private async initialize(input: InitInput): Promise<string> {
    const createdAt = this.now().toISOString();
    const society: Society = SocietySchema.parse({
      name: input.name,
      version: 1,
      createdAt,
      channels: [...SOCIETY_CHANNELS],
    });
    for (const dir of [
      this.paths.roles(),
      this.paths.proposals(),
      this.paths.decisions(),
      this.paths.runners(),
      this.paths.societyKnowledge(),
      this.paths.projects(),
      this.paths.agents(),
      this.paths.events(),
      this.paths.state(),
      this.paths.worktrees(),
    ]) {
      await ensureDir(dir);
    }
    for (const channel of society.channels) {
      await ensureDir(this.paths.societyChannel(channel));
    }
    await writeMarkdown(this.paths.societyFile(), society, `# ${society.name}\n`);
    for (const charter of SEED_ROLES) {
      await writeMarkdown(
        this.paths.role(charter.name),
        charter,
        `# ${charter.name}\n\n${charter.purpose}\n`,
      );
      this.roleCache.set(charter.name, charter);
    }
    const runner: Runner = RunnerSchema.parse({
      name: LOCAL_RUNNER,
      os:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "darwin"
            : "linux",
      clis: [],
      capabilities: [],
      status: "disconnected",
    });
    await writeMarkdown(
      this.paths.runner(runner.name),
      runner,
      `# ${runner.name}\n\nThe board server's own machine.\n`,
    );
    await writeJson(this.paths.pausedFile(), { paused: false });

    const ownerToken = mintToken();
    const ownerCharter = await this.readRole(OWNER_ROLE);
    const owner: Agent = AgentSchema.parse({
      name: OWNER_NAME,
      role: OWNER_ROLE,
      cli: null,
      homeRunner: LOCAL_RUNNER,
      memberships: [],
      subscriptions: [...society.channels],
      status: "active",
      createdAt,
      tokenHash: hashToken(ownerToken),
    });
    await this.writeAgentHome(owner, ownerCharter);
    await this.events.append("society.initialized", OWNER_NAME, { name: society.name });
    return ownerToken;
  }

  private async writeAgentHome(agent: Agent, charter: RoleCharter): Promise<void> {
    await writeJson(this.paths.agentFile(agent.name), agent);
    await writeMarkdown(
      this.paths.agentRole(agent.name),
      { role: charter.name, agent: agent.name },
      `# ${agent.name}, ${charter.name}\n\n${charter.purpose}\n\n` +
        `Route every lesson with one question: about me, my craft, or the owner, it goes in memory/core.md; ` +
        `about this codebase, it goes in the project's knowledge directory; something everyone should know, post it.\n`,
    );
    await ensureDir(this.paths.agentMemory(agent.name));
    if (!(await exists(this.paths.agentMemoryCore(agent.name)))) {
      await writeMarkdown(
        this.paths.agentMemoryCore(agent.name),
        { agent: agent.name, updatedAt: agent.createdAt },
        `# Core memory\n\nShort, curated, loaded on every turn. Keep entries that change future behavior and hold across tasks.\n`,
      );
    }
    await ensureDir(this.paths.agentSkills(agent.name));
    for (const slug of agent.memberships) {
      const dir = this.paths.agentProject(agent.name, slug);
      await ensureDir(dir);
      if (!(await exists(path.join(dir, "sessions.json")))) {
        await writeJson(path.join(dir, "sessions.json"), {});
      }
      if (!(await exists(path.join(dir, "notes.md")))) {
        await writeMarkdown(
          path.join(dir, "notes.md"),
          { project: slug },
          `# Working notes for ${slug}\n`,
        );
      }
    }
    this.tokenIndex.set(agent.tokenHash, { name: agent.name, role: agent.role });
  }

  private async loadTokenIndex(): Promise<void> {
    this.tokenIndex.clear();
    for (const agent of await this.listAgents()) {
      if (agent.status === "active") {
        this.tokenIndex.set(agent.tokenHash, { name: agent.name, role: agent.role });
      }
    }
  }

  private async updateAgent(name: Name, mutate: (agent: Agent) => Agent): Promise<Agent> {
    const current = await this.readAgent(name);
    const next = AgentSchema.parse(mutate(current));
    await writeJson(this.paths.agentFile(name), next);
    return next;
  }

  private async updateProjectMembers(slug: Name, member: Name): Promise<void> {
    const project = await this.readProject(slug);
    const next: Project = { ...project, members: [...new Set([...project.members, member])] };
    const doc = await readMarkdown(this.paths.projectFile(slug), ProjectSchema);
    await writeMarkdown(this.paths.projectFile(slug), next, doc.body);
  }

  private assertAdmin(actor: Actor): void {
    if (actor.role !== OWNER_ROLE && actor.role !== "steward") {
      throw new BoardError("FORBIDDEN", "only the owner or the steward may administer the society");
    }
  }

  private async assertChannelExists(ref: ChannelRef): Promise<void> {
    const parsed = parseChannelRef(ref);
    if (parsed.project === null) {
      const society = await this.society();
      if (!society.channels.includes(parsed.channel)) {
        throw new BoardError("NOT_FOUND", `society channel ${ref} not found`);
      }
      return;
    }
    const project = await this.readProject(parsed.project);
    if (!project.channels.includes(parsed.channel)) {
      throw new BoardError("NOT_FOUND", `channel ${ref} not found`);
    }
  }

  private assertTransition(actor: Actor, task: Task, to: TaskStatus): void {
    if (!canTransition(task.status, to)) {
      throw new BoardError(
        "INVALID_TRANSITION",
        `cannot move task ${task.id} from ${task.status} to ${to}`,
      );
    }
    const isClaimer = task.claimedBy === actor.name;
    const isOwner = actor.role === OWNER_ROLE;
    const isReviewer = actor.role === "reviewer" || isOwner;
    const isSteward = actor.role === "steward" || isOwner;
    const allowed = (() => {
      switch (`${task.status}->${to}`) {
        case "open->claimed":
          throw new BoardError("INVALID_TRANSITION", "use claim_task to claim an open task");
        case "claimed->in_review":
        case "claimed->blocked":
        case "blocked->claimed":
          return isClaimer;
        case "claimed->open":
          return isClaimer || isSteward;
        case "in_review->done":
          return isReviewer && !isClaimer;
        case "in_review->claimed":
          return isReviewer || isClaimer;
        case "open->abandoned":
        case "claimed->abandoned":
          return isClaimer || isSteward;
        default:
          return false;
      }
    })();
    if (!allowed) {
      throw new BoardError(
        "FORBIDDEN",
        `${actor.name} (${actor.role}) may not move task ${task.id} from ${task.status} to ${to}`,
      );
    }
  }

  private leaseEnd(now: Date): string {
    return new Date(now.getTime() + this.leaseMs).toISOString();
  }

  private leaseExpired(task: Task, now: Date): boolean {
    return (
      task.leaseExpiresAt !== undefined && new Date(task.leaseExpiresAt).getTime() <= now.getTime()
    );
  }

  private async writeTask(project: Name, task: Task): Promise<Task> {
    const { body, ...frontmatter } = task;
    const clean = Object.fromEntries(
      Object.entries(frontmatter).filter(([, value]) => value !== undefined),
    );
    const data = TaskFrontmatterSchema.parse(clean);
    await writeMarkdown(this.paths.task(project, task.id), data, body);
    return { ...data, body };
  }

  private async writeProposal(proposal: Proposal): Promise<void> {
    const { body, ...frontmatter } = proposal;
    const clean = Object.fromEntries(
      Object.entries(frontmatter).filter(([, value]) => value !== undefined),
    );
    await writeMarkdown(
      this.paths.proposal(proposal.id),
      ProposalFrontmatterSchema.parse(clean),
      body,
    );
  }

  private async decide(
    actor: Actor,
    proposalId: Ulid,
    outcome: "approved" | "rejected",
    reason?: string,
  ): Promise<Decision> {
    return this.mutex.run(async () => {
      const proposal = await this.readProposal(proposalId);
      if (proposal.status !== "proposed") {
        throw new BoardError(
          "INVALID_STATE",
          `proposal ${proposalId} is already ${proposal.status}`,
        );
      }
      if (proposal.proposedBy === actor.name) {
        throw new BoardError("FORBIDDEN", "a proposer never decides its own proposal");
      }
      const approvers = ROLE_KIND_APPROVERS[proposal.kind] ?? [OWNER_ROLE];
      if (!approvers.includes(actor.role)) {
        throw new BoardError(
          "FORBIDDEN",
          `a ${proposal.kind} proposal requires one of: ${approvers.join(", ")}`,
        );
      }
      const ts = this.now().toISOString();
      const decision: Decision = DecisionSchema.parse({
        id: this.newId(),
        proposalId,
        decidedBy: actor.name,
        outcome,
        ...(reason === undefined ? {} : { reason }),
        ts,
      });
      await writeMarkdown(this.paths.decision(decision.id), decision, reason ?? "");
      await this.writeProposal({
        ...proposal,
        status: outcome,
        decidedBy: actor.name,
        decidedAt: ts,
        ...(reason === undefined ? {} : { reason }),
      });
      await this.events.append("proposal.decided", actor.name, {
        proposalId,
        outcome,
        kind: proposal.kind,
      });
      return decision;
    });
  }

  private async participatesInThread(actor: Actor, taskId: Ulid): Promise<boolean> {
    let location: TaskLocation;
    try {
      location = await this.findTask(taskId);
    } catch {
      return false;
    }
    if (location.task.claimedBy === actor.name || location.task.createdBy === actor.name) {
      return true;
    }
    const files = await listFiles(this.paths.thread(location.project, taskId));
    return files.some((file) => file.endsWith(`-${actor.name}.md`));
  }

  private async readMessagesIn(dir: string, since: Ulid | null): Promise<Message[]> {
    const messages: Message[] = [];
    for (const file of await listFiles(dir)) {
      const id = file.slice(0, 26);
      if (since !== null && id <= since) {
        continue;
      }
      const doc = await readMarkdown(path.join(dir, file), MessageFrontmatterSchema);
      messages.push({ ...doc.data, body: doc.body });
    }
    return messages;
  }

  /** Every message newer than `since` across society channels, project channels, and threads. */
  private async *iterateMessages(since: Ulid | null, project?: Name): AsyncGenerator<Message> {
    if (project === undefined) {
      for (const channel of await listDirs(this.paths.societyChannels())) {
        yield* await this.readMessagesIn(this.paths.societyChannel(channel), since);
      }
    }
    const projects = project === undefined ? await listDirs(this.paths.projects()) : [project];
    for (const slug of projects) {
      for (const channel of await listDirs(this.paths.projectChannels(slug))) {
        yield* await this.readMessagesIn(this.paths.projectChannel(slug, channel), since);
      }
      for (const taskId of await listDirs(this.paths.threads(slug))) {
        yield* await this.readMessagesIn(this.paths.thread(slug, taskId), since);
      }
    }
  }
}
