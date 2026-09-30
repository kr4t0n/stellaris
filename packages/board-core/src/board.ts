import { readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { decodeTime, monotonicFactory } from "ulid";
import { z } from "zod";
import {
  AgentSchema,
  currentStage,
  channelRef,
  ChannelProposalSchema,
  DecisionSchema,
  describeCharter,
  KnowledgeSchema,
  mayHoldStage,
  MemberProposalSchema,
  MemberSchema,
  ModelNameSchema,
  MessageFrontmatterSchema,
  NameSchema,
  OpsSignalSchema,
  USER_NAME,
  USER_ROLE,
  parseChannelRef,
  PROJECT_DEFAULT_CHANNELS,
  ProjectSchema,
  ProposalCharterSchemas,
  ProposalFrontmatterSchema,
  RetirementProposalSchema,
  ROLE_KIND_APPROVERS,
  RoleCharterSchema,
  RunnerSchema,
  SEED_ROLES,
  SERVER_RUNNER,
  SkillProposalSchema,
  stageIndex,
  SOCIETY_CHANNELS,
  SOCIETY_SCOPE,
  SocietySchema,
  TaskFrontmatterSchema,
  ThreadFrontmatterSchema,
  VerbInputs,
  type Agent,
  type BoardEvent,
  type ChannelRef,
  type CompletionEffect,
  type CliKind,
  type Decision,
  type Knowledge,
  type Member,
  type MemberProposal,
  type Message,
  type MessageFrontmatter,
  type Name,
  type OpsSignal,
  type PlanEditStage,
  type PlanStage,
  type Project,
  type Proposal,
  type ProposalKind,
  type ProposalStatus,
  type RoleCharter,
  type RoleCharterInput,
  type Runner,
  type Skill,
  type SkillProposal,
  type Stage,
  type StageId,
  type Society,
  type Task,
  type TaskFrontmatter,
  type Thread,
  type ThreadSubject,
  type Ulid,
  type VerbArgs,
  type VerbInput,
  type VerbName,
  SessionsFileSchema,
  TurnRecordSchema,
  WakeRequestSchema,
  type BoardEvent as BoardLogEvent,
  type SessionsFile,
  TranscriptEntrySchema,
  UlidSchema,
  type TranscriptEntry,
  type TurnHistoryEntry,
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
  writeFileAtomic,
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
export const SYSTEM_ACTOR: Actor = { name: "board", role: USER_ROLE };

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
  readonly defaultPlan?: readonly PlanStage[] | undefined;
  readonly onDone?: CompletionEffect | undefined;
}

export interface AddAgentInput {
  readonly name: Name;
  readonly role: Name;
  readonly cli: CliKind | null;
  readonly model?: string | undefined;
  readonly homeRunner?: Name | undefined;
  readonly memberships?: readonly Name[] | undefined;
  readonly subscriptions?: readonly ChannelRef[] | undefined;
  /** Direction from a member proposal, written into the agent's role file under the charter. */
  readonly seedInstructions?: string | undefined;
}

export interface RetireAgentInput {
  readonly name: Name;
  readonly reason: string;
}

export interface AddChannelInput {
  /** The project, or null for a society channel. */
  readonly project: Name | null;
  readonly name: Name;
  readonly purpose: string;
}

export interface AddReplicaInput {
  readonly project: Name;
  readonly role: Name;
}

export interface RunnerPatch {
  readonly status?: Runner["status"] | undefined;
  readonly clis?: readonly CliKind[] | undefined;
  readonly capabilities?: readonly string[] | undefined;
}

export interface SignalRecord {
  readonly id: Ulid;
  readonly ts: string;
  readonly signal: OpsSignal;
}

const TurnHistoryPayloadSchema = z.object({
  project: NameSchema,
  trigger: z.string().default("manual"),
  exitReason: z.string().nullable().default(null),
  costUsd: z.number().default(0),
  model: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  toolCalls: z.number().int().nonnegative().optional(),
  turnId: UlidSchema.optional(),
});
const TurnStartPayloadSchema = z.object({ project: NameSchema });

export interface DigestResult {
  readonly messages: Message[];
  readonly cursor: Ulid | null;
}

/** A thread as a list shows it: the record, how many messages it holds, and its newest one. */
export interface ThreadSummary extends Thread {
  readonly messages: number;
  readonly lastMessageId: Ulid | null;
}

/** A channel as a navigator lists it: where it is and when it last spoke. */
export interface ChannelSummary {
  readonly ref: ChannelRef;
  readonly project: Name | null;
  readonly name: Name;
  readonly messages: number;
  readonly lastMessageId: Ulid | null;
  readonly lastAt: string | null;
}

export interface SearchHit {
  readonly kind: "message" | "task" | "knowledge" | "skill" | "memory";
  readonly ref: string;
  readonly snippet: string;
}

export interface TaskLocation {
  readonly project: Name;
  readonly file: string;
  readonly task: Task;
}

const CursorsSchema = z.object({ digest: z.string().nullable() });
const PausedSchema = z.object({ paused: z.boolean() });

const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const MENTION_PATTERN = /(^|[^\w@])@([a-z0-9][a-z0-9-]{0,31})(?![\w-])/g;

/** Roles that may write society knowledge. */
const CURATING_ROLES: readonly Name[] = [USER_ROLE, "steward"];

/** The heading under which a member's own seed instructions live in its role file. */
const SEED_INSTRUCTIONS_HEADING = "## Seed instructions";

/** The wake trigger that marks a role as a reader of operations signals, such as the steward. */
const OPS_WAKE_TRIGGER = "ops_event";

/** Where readers of operations signals follow signals, proposals, and their decisions. */
const OPS_CHANNELS: readonly ChannelRef[] = ["ops", "governance", "decisions"];

/** One-time changes an existing society receives on open, by name, remembered once applied. */
const AlignmentsSchema = z.object({ applied: z.array(z.string()).default([]) });
const FOLLOW_DECISIONS = "ops-readers-follow-decisions";
const THREAD_RECORDS = "threads-as-records";
const DIGEST_CURSORS = "digest-replaces-inbox";
const TASK_RETURNS = "task-returns-recorded";

/** Roles that may change gates and completion effects, move work back, and release or abandon it for others. */
const PLANNING_ROLES: readonly Name[] = [USER_ROLE, "steward", "concierge"];

/** Roles that may add a citizen to a project or remove one, beyond the citizen itself. */
const REALLOCATING_ROLES: readonly Name[] = [USER_ROLE, "steward", "concierge"];

const PROFILE_TEMPLATE =
  "# Profile\n\nOne short paragraph, kept current: what I do well, what I am working on, and what to send my way. The board projects this into the roster the front desk reads.\n";

/** A plain rendering of a provisioning summary value for a post, without falling back to `[object Object]`. */
function plain(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(plain).join(", ");
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** A summary without its trailing period, for sentences that add their own. */
function sentence(summary: string): string {
  return summary.trim().replace(/\.+$/, "");
}

/** A skill's one-line summary: `description`, else a legacy `summary`, else the body's first plain line. */
function skillSummary(data: Record<string, unknown>, body: string): string {
  const fromFrontmatter = data["description"] ?? data["summary"];
  if (typeof fromFrontmatter === "string" && fromFrontmatter.trim().length > 0) {
    return fromFrontmatter.trim();
  }
  return (
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#")) ?? ""
  );
}

function memberToAgentInput(member: MemberProposal): AddAgentInput {
  return {
    name: member.name,
    role: member.role,
    cli: member.cli,
    ...(member.model === undefined ? {} : { model: member.model }),
    homeRunner: member.homeRunner,
    memberships: member.memberships,
    subscriptions: member.subscriptions,
    ...(member.seedInstructions === undefined ? {} : { seedInstructions: member.seedInstructions }),
  };
}

/** A stored stage from a planned one, built without undefined keys, which the YAML writer rejects. */
function stageFrom(planned: PlanStage, id: StageId): Stage {
  return {
    id,
    name: planned.name,
    ...(planned.role === undefined ? {} : { role: planned.role }),
    ...(planned.agent === undefined ? {} : { agent: planned.agent }),
    gate: planned.gate,
    holders: [],
  };
}

/** An existing stage as a plan edit restates it; its holders and any completion are kept. */
function restage(existing: Stage, edit: PlanEditStage): Stage {
  const { role: _role, agent: _agent, ...kept } = existing;
  return {
    ...kept,
    name: edit.name,
    gate: edit.gate,
    ...(edit.role === undefined ? {} : { role: edit.role }),
    ...(edit.agent === undefined ? {} : { agent: edit.agent }),
  };
}

/** A stage opened for another pass: its completion is cleared, its holders are kept. */
function reopenStage(stage: Stage): Stage {
  const { completedBy: _by, completedAt: _at, ...open } = stage;
  return open;
}

/**
 * What a plan edit does to gates, as phrases for the refusal: a gate added, removed, cleared,
 * reassigned, or moved. A gated stage moves when the set of kept stages before it changes.
 */
function gateChanges(before: readonly Stage[], after: readonly Stage[]): string[] {
  const changes: string[] = [];
  const beforeIds = new Set(before.map((stage) => stage.id));
  const afterById = new Map(after.map((stage) => [stage.id, stage]));
  for (const stage of after) {
    if (stage.gate && !beforeIds.has(stage.id)) {
      changes.push(`add the gated stage "${stage.name}"`);
    }
  }
  const keptBefore = before.filter((stage) => afterById.has(stage.id)).map((stage) => stage.id);
  const keptAfter = after.filter((stage) => beforeIds.has(stage.id)).map((stage) => stage.id);
  for (const stage of before) {
    const now = afterById.get(stage.id);
    if (!stage.gate) {
      if (now?.gate === true) {
        changes.push(`gate stage ${stage.id}`);
      }
      continue;
    }
    if (now === undefined) {
      changes.push(`remove the gated stage ${stage.id}`);
      continue;
    }
    if (!now.gate) {
      changes.push(`ungate stage ${stage.id}`);
    }
    if (now.role !== stage.role || now.agent !== stage.agent) {
      changes.push(`reassign the gated stage ${stage.id}`);
    }
    const priorBefore = keptBefore.slice(0, keptBefore.indexOf(stage.id));
    const priorAfter = new Set(keptAfter.slice(0, keptAfter.indexOf(stage.id)));
    if (priorBefore.length !== priorAfter.size || priorBefore.some((id) => !priorAfter.has(id))) {
      changes.push(`move the gated stage ${stage.id}`);
    }
  }
  return changes;
}

/** Appends a timestamped note under the task body's Notes heading. */
function appendNote(body: string, ts: string, author: Name, note: string): string {
  const heading = body.includes("\n## Notes") || body.startsWith("## Notes") ? "" : "\n## Notes\n";
  const base = body.length === 0 ? "" : body.endsWith("\n") ? body : `${body}\n`;
  return `${base}${heading}- ${ts} @${author}: ${note}\n`;
}

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

  /** Creates a society: channels, seed roles, the local runner, and the user. Returns the user token once. */
  static async init(
    dataDir: string,
    input: InitInput,
    options: BoardOptions = {},
  ): Promise<{ board: Board; userToken: string }> {
    const board = new Board(dataDir, options);
    if (await exists(board.paths.societyFile())) {
      throw new BoardError("ALREADY_EXISTS", `a society already exists in ${dataDir}`);
    }
    const userToken = await board.mutex.run(() => board.initialize(input));
    return { board, userToken };
  }

  static async open(dataDir: string, options: BoardOptions = {}): Promise<Board> {
    const board = new Board(dataDir, options);
    if (!(await exists(board.paths.societyFile()))) {
      throw new BoardError("NOT_FOUND", `no society found in ${dataDir}; run init first`);
    }
    await board.mutex.run(() => board.ensureSeedRoles());
    await board.mutex.run(() => board.applyAlignments());
    await board.loadTokenIndex();
    return board;
  }

  /**
   * Applies each one-time alignment an existing society has not had yet. Once applied it is not
   * repeated, so a member that later chooses otherwise keeps its choice.
   */
  private async applyAlignments(): Promise<void> {
    const file = path.join(this.paths.state(), "alignments.json");
    const { applied } = (await exists(file))
      ? await readJson(file, AlignmentsSchema)
      : { applied: [] };
    const pending = [FOLLOW_DECISIONS, THREAD_RECORDS, DIGEST_CURSORS, TASK_RETURNS].filter(
      (name) => !applied.includes(name),
    );
    if (pending.length === 0) {
      return;
    }
    if (pending.includes(FOLLOW_DECISIONS)) {
      await this.followDecisions();
    }
    if (pending.includes(THREAD_RECORDS)) {
      await this.recordTaskThreads();
    }
    if (pending.includes(DIGEST_CURSORS)) {
      await this.renameInboxCursors();
    }
    if (pending.includes(TASK_RETURNS)) {
      await this.recordTaskReturns();
    }
    await writeJson(file, { applied: [...applied, ...pending] });
  }

  /**
   * A task sent back before tasks recorded it kept no trace outside the event log. A task still
   * short of the stage its latest `task.moved` came from is in that rework, and records it.
   */
  private async recordTaskReturns(): Promise<void> {
    const moves = new Map<string, BoardEvent>();
    for (const event of await this.events.readSince(null, Number.POSITIVE_INFINITY)) {
      const taskId = event.payload["taskId"];
      if (event.type === "task.moved" && typeof taskId === "string") {
        moves.set(taskId, event);
      }
    }
    for (const slug of await listDirs(this.paths.projects())) {
      for (const task of await this.listTasks(slug)) {
        const move = moves.get(task.id);
        const from = move?.payload["from"];
        if (
          move === undefined ||
          typeof from !== "string" ||
          task.returned !== undefined ||
          task.completing ||
          (task.status !== "open" && task.status !== "claimed")
        ) {
          continue;
        }
        const back = stageIndex(task, from);
        if (back > stageIndex(task, task.stage)) {
          await this.writeTask(slug, {
            ...task,
            returned: { from, by: move.actor, at: move.ts },
          });
        }
      }
    }
  }

  /** Members that predate `decisions` among the ops channels read proposals without their outcome. */
  private async followDecisions(): Promise<void> {
    for (const agent of await this.listAgents()) {
      if (agent.status !== "active" || agent.subscriptions.includes("decisions")) {
        continue;
      }
      if (!(await this.readRole(agent.role)).wakeTriggers.includes(OPS_WAKE_TRIGGER)) {
        continue;
      }
      await this.updateAgent(agent.name, (a) => ({
        ...a,
        subscriptions: [...a.subscriptions, "decisions"],
      }));
      await this.refreshMember(agent.name);
      await this.events.append("subscription.changed", agent.name, {
        channel: "decisions",
        subscribed: true,
        aligned: true,
      });
    }
  }

  /**
   * Threads were once a state field on their task. Each becomes a record under the task's project,
   * on its general channel, closed if its task has ended, and the field leaves the task file.
   */
  private async recordTaskThreads(): Promise<void> {
    const opened = new Map<string, BoardEvent>();
    const closed = new Map<string, BoardEvent>();
    for (const event of await this.events.readSince(null, Number.POSITIVE_INFINITY)) {
      const taskId = event.payload["taskId"];
      if (typeof taskId !== "string") {
        continue;
      }
      if (event.type === "thread.opened") {
        opened.set(taskId, event);
      } else if (event.type === "thread.closed") {
        closed.set(taskId, event);
      }
    }
    for (const slug of await listDirs(this.paths.projects())) {
      const threads = this.paths.threads(slug);
      const summaries = new Map<string, string>();
      for (const message of await this.readMessagesIn(
        this.paths.projectChannel(slug, "general"),
        null,
      )) {
        if (message.task !== undefined) {
          summaries.set(message.task, message.body.replace(/^Thread closed[^\n]*\n\n/, ""));
        }
      }
      for (const file of await listFiles(this.paths.tasks(slug))) {
        const raw = await readMarkdown(
          path.join(this.paths.tasks(slug), file),
          z.record(z.string(), z.unknown()),
        );
        const legacy = raw.data["thread"];
        if (legacy === undefined) {
          continue;
        }
        const task: Task = { ...TaskFrontmatterSchema.parse(raw.data), body: raw.body };
        if (
          (legacy === "open" || legacy === "closed") &&
          !(await exists(this.paths.threadFile(threads, task.id)))
        ) {
          const ended = task.status === "done" || task.status === "abandoned";
          const open = legacy === "open" && !ended;
          const openedBy = opened.get(task.id);
          const closedBy = closed.get(task.id);
          await this.writeThread(threads, {
            id: task.id,
            channel: channelRef(slug, "general"),
            title: task.title,
            subject: { kind: "task", id: task.id },
            state: open ? "open" : "closed",
            openedBy: openedBy?.actor ?? task.createdBy,
            openedAt: openedBy?.ts ?? task.createdAt,
            ...(open
              ? {}
              : {
                  closedBy: closedBy?.actor ?? SYSTEM_ACTOR.name,
                  closedAt: closedBy?.ts ?? this.now().toISOString(),
                }),
            body: summaries.get(task.id) ?? "",
          });
        }
        await this.writeTask(slug, task);
      }
    }
  }

  /**
   * The digest was once called the inbox: each cursor file keyed its cursor `inbox`, and the user
   * followed every society channel and project general channel to read one. The user takes no
   * turns, so it follows nothing now.
   */
  private async renameInboxCursors(): Promise<void> {
    const Legacy = z.object({ inbox: z.string().nullable() });
    for (const agent of await this.listAgents()) {
      const file = this.paths.agentCursors(agent.name);
      if (await exists(file)) {
        const legacy = Legacy.safeParse(JSON.parse(await readFile(file, "utf8")));
        if (legacy.success) {
          await writeJson(file, { digest: legacy.data.inbox });
        }
      }
    }
    await this.updateAgent(USER_NAME, (user) => ({ ...user, subscriptions: [] }));
    await this.refreshMember(USER_NAME);
  }

  /** Writes every missing seed charter and aligns the existing ones with their seed. */
  private async ensureSeedRoles(): Promise<void> {
    await ensureDir(this.paths.roles());
    await ensureDir(this.paths.members());
    await ensureDir(this.paths.societySkills());
    await ensureDir(this.paths.societyKnowledge());
    for (const charter of SEED_ROLES) {
      if (await exists(this.paths.role(charter.name))) {
        await this.alignSeedRole(charter);
        continue;
      }
      await writeMarkdown(
        this.paths.role(charter.name),
        charter,
        `# ${charter.name}\n\n${charter.purpose}\n`,
      );
      this.roleCache.set(charter.name, charter);
      await this.events.append("role.added", USER_NAME, {
        name: charter.name,
        replaced: false,
        verbs: charter.verbs,
        maxReplicas: charter.maxReplicas,
        backlogThreshold: charter.backlogThreshold,
        seeded: true,
      });
    }
  }

  /**
   * Verbs the seed grants and the copy lacks are added, and fields absent from the copy's file take
   * the seed's value rather than the schema default; fields the file sets stand. The user charter
   * is replaced by the seed in full.
   */
  private async alignSeedRole(seed: RoleCharter): Promise<void> {
    const file = this.paths.role(seed.name);
    const raw = await readMarkdown(file, z.record(z.string(), z.unknown()));
    const current = RoleCharterSchema.parse(raw.data);
    const verbsAdded = seed.verbs.filter((verb) => !current.verbs.includes(verb));
    // Keys the seed leaves unset are not aligned; the YAML writer refuses undefined values anyway.
    const fieldsAligned = RoleCharterSchema.keyof().options.filter((key) =>
      key === "verbs" || seed[key] === undefined
        ? false
        : seed.name === USER_ROLE
          ? JSON.stringify(seed[key]) !== JSON.stringify(current[key])
          : !(key in raw.data),
    );
    if (verbsAdded.length === 0 && fieldsAligned.length === 0) {
      return;
    }
    const charter = RoleCharterSchema.parse({
      ...current,
      ...Object.fromEntries(fieldsAligned.map((key) => [key, seed[key]])),
      verbs: [...current.verbs, ...verbsAdded],
    });
    await writeMarkdown(file, charter, `# ${charter.name}\n\n${charter.purpose}\n`);
    this.roleCache.set(charter.name, charter);
    await this.events.append("role.added", USER_NAME, {
      name: charter.name,
      replaced: true,
      verbs: charter.verbs,
      verbsAdded,
      fieldsAligned,
      maxReplicas: charter.maxReplicas,
      backlogThreshold: charter.backlogThreshold,
      seeded: true,
    });
    await this.refreshAgentRoles(charter);
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

  /** Pushes a turn token's expiry out, for a resident session that keeps using it across turns. */
  extendTurnToken(token: string, ttlMs: number): boolean {
    const entry = this.turnTokens.get(hashToken(token));
    if (entry === undefined) {
      return false;
    }
    entry.expiresAt = this.now().getTime() + ttlMs;
    return true;
  }

  revokeTurnToken(token: string): void {
    this.turnTokens.delete(hashToken(token));
  }

  userActor(): Actor {
    return { name: USER_NAME, role: USER_ROLE };
  }

  async actorFor(name: Name): Promise<Actor> {
    const agent = await this.readAgent(name);
    return { name: agent.name, role: agent.role };
  }

  private async authorize(actor: Actor, verb: VerbName): Promise<void> {
    if (actor.role === USER_ROLE) {
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

  async latestEventId(): Promise<Ulid | null> {
    return this.events.lastId();
  }

  /** The roster as projected: every citizen with identity, reach, availability, and profile. */
  async listMembers(): Promise<Member[]> {
    const members: Member[] = [];
    for (const file of await listFiles(this.paths.members())) {
      const doc = await readMarkdown(path.join(this.paths.members(), file), MemberSchema);
      members.push({ ...doc.data, profile: doc.body });
    }
    return members;
  }

  async readProfile(name: Name): Promise<string> {
    const file = this.paths.agentProfile(name);
    return (await exists(file))
      ? (await readMarkdown(file, z.record(z.string(), z.unknown()))).body
      : "";
  }

  /** The society's norms, the one knowledge topic every turn loads. Empty until the steward writes it. */
  async readSocietyNorms(): Promise<string> {
    const file = this.paths.societyKnowledgeFile("norms");
    return (await exists(file))
      ? (await readMarkdown(file, z.record(z.string(), z.unknown()))).body
      : "";
  }

  /** Knowledge topics of a project, or of the society when the project is null. */
  async listKnowledge(project: Name | null): Promise<Knowledge[]> {
    const dir =
      project === null ? this.paths.societyKnowledge() : this.paths.projectKnowledge(project);
    const topics: Knowledge[] = [];
    for (const file of await listFiles(dir)) {
      const doc = await readMarkdown(path.join(dir, file), z.record(z.string(), z.unknown()));
      const parsed = KnowledgeSchema.safeParse({
        ...doc.data,
        project,
        topic: file.replace(/\.md$/, ""),
      });
      // A topic file without valid frontmatter still counts; its mtime stands in for the update.
      const data = parsed.success
        ? parsed.data
        : {
            topic: file.replace(/\.md$/, ""),
            project,
            updatedBy: SYSTEM_ACTOR.name,
            updatedAt: (await stat(path.join(dir, file))).mtime.toISOString(),
          };
      topics.push({ ...data, body: doc.body });
    }
    return topics;
  }

  /** Skills promoted to the society: every citizen may read them. */
  async listSocietySkills(): Promise<Skill[]> {
    return this.listSkillsIn(this.paths.societySkills(), "society");
  }

  /** A citizen's own skills, procedural memory it wrote itself. */
  async listAgentSkills(name: Name): Promise<Skill[]> {
    return this.listSkillsIn(this.paths.agentSkills(name), "own");
  }

  private async listSkillsIn(dir: string, scope: Skill["scope"]): Promise<Skill[]> {
    const skills: Skill[] = [];
    for (const entry of await listDirs(dir)) {
      const file = path.join(dir, entry, "SKILL.md");
      if (!(await exists(file))) {
        continue;
      }
      const name = NameSchema.safeParse(entry);
      if (!name.success) {
        continue;
      }
      const doc = await readMarkdown(file, z.record(z.string(), z.unknown()));
      skills.push({
        name: name.data,
        summary: skillSummary(doc.data, doc.body),
        scope,
        path: file,
      });
    }
    return skills;
  }

  async isPaused(): Promise<boolean> {
    const file = this.paths.pausedFile();
    if (!(await exists(file))) {
      return false;
    }
    return (await readJson(file, PausedSchema)).paused;
  }

  /** Every message in a channel, oldest first. Thread messages are listed with `listThread`. */
  /** Every channel, the society's first, with how many messages it holds and its newest one. */
  async listChannels(): Promise<ChannelSummary[]> {
    const summaries: ChannelSummary[] = [];
    const scopes: Array<{ project: Name | null; names: readonly Name[] }> = [
      { project: null, names: (await this.society()).channels },
      ...(await this.listProjects()).map((project) => ({
        project: project.slug,
        names: project.channels,
      })),
    ];
    for (const { project, names } of scopes) {
      for (const name of names) {
        const ref = channelRef(project, name);
        const files = await listFiles(this.paths.channelDir(ref));
        const last = files.at(-1)?.slice(0, 26) ?? null;
        summaries.push({
          ref,
          project,
          name,
          messages: files.length,
          lastMessageId: last,
          lastAt: last === null ? null : new Date(decodeTime(last)).toISOString(),
        });
      }
    }
    return summaries;
  }

  async listChannel(ref: ChannelRef, limit = 200): Promise<Message[]> {
    await this.assertChannelExists(ref);
    const messages = await this.readMessagesIn(this.paths.channelDir(ref), null);
    return messages.slice(-limit);
  }

  /** A thread's messages, oldest first. */
  async listThread(id: Ulid): Promise<Message[]> {
    const { threads } = await this.findThread(id);
    return this.readMessagesIn(this.paths.threadMessages(threads, id), null);
  }

  async readThread(id: Ulid): Promise<Thread> {
    return (await this.findThread(id)).thread;
  }

  /** Every thread record with its message count and newest message, the society's first. */
  async listThreads(): Promise<ThreadSummary[]> {
    const all: ThreadSummary[] = [];
    for (const threads of await this.threadScopes()) {
      for (const file of await listFiles(threads)) {
        const doc = await readMarkdown(path.join(threads, file), ThreadFrontmatterSchema);
        const messages = await listFiles(this.paths.threadMessages(threads, doc.data.id));
        all.push({
          ...doc.data,
          body: doc.body,
          messages: messages.length,
          lastMessageId: messages.at(-1)?.slice(0, 26) ?? null,
        });
      }
    }
    return all;
  }

  // ---------------------------------------------------------------------------------------------
  // Administration (user and steward)
  // ---------------------------------------------------------------------------------------------

  async addProject(actor: Actor, input: AddProjectInput): Promise<Project> {
    this.assertAdmin(actor);
    return this.mutex.run(() => this.createProjectUnlocked(actor.name, input));
  }

  private async createProjectUnlocked(by: Name, input: AddProjectInput): Promise<Project> {
    if (input.slug === SOCIETY_SCOPE) {
      throw new BoardError("VALIDATION", `${SOCIETY_SCOPE} is the society scope, not a project`);
    }
    const file = this.paths.projectFile(input.slug);
    if (await exists(file)) {
      throw new BoardError("ALREADY_EXISTS", `project ${input.slug} already exists`);
    }
    await this.validateAssignees(input.defaultPlan ?? []);
    const project: Project = ProjectSchema.parse({
      slug: input.slug,
      name: input.name ?? input.slug,
      repo: input.repo ?? null,
      defaultBranch: input.defaultBranch ?? "main",
      channels: [...(input.channels ?? PROJECT_DEFAULT_CHANNELS)],
      members: [],
      approvers: [USER_NAME],
      requiredCapabilities: [...(input.requiredCapabilities ?? [])],
      createdAt: this.now().toISOString(),
      defaultPlan: [...(input.defaultPlan ?? [])],
      onDone: input.onDone ?? "none",
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
    await this.updateAgent(USER_NAME, (user) => ({
      ...user,
      memberships: [...new Set([...user.memberships, project.slug])],
    }));
    await this.refreshMember(USER_NAME);
    await this.events.append("project.added", by, {
      slug: project.slug,
      name: project.name,
    });
    return project;
  }

  /** Adds a member. Returns the bearer token once; only its hash is stored. */
  async addAgent(actor: Actor, input: AddAgentInput): Promise<{ agent: Agent; token: string }> {
    this.assertAdmin(actor);
    return this.mutex.run(async () => {
      await this.validateAddAgent(input);
      return this.addAgentUnlocked(actor.name, input, {});
    });
  }

  /** Retires a member: no more wakes, claims released, token revoked, sessions archived. */
  async retireAgent(actor: Actor, input: RetireAgentInput): Promise<Agent> {
    this.assertUser(actor, "only the user may retire a member");
    return this.mutex.run(async () => {
      await this.validateRetire(input.name);
      return (await this.retireUnlocked(actor.name, input.name, input.reason, {})).agent;
    });
  }

  /** Writes a role charter directly, bypassing a role proposal. User only. */
  async setRoleCharter(actor: Actor, charter: RoleCharterInput): Promise<RoleCharter> {
    this.assertUser(actor, "only the user may write a role charter directly");
    const parsed = RoleCharterSchema.parse(charter);
    return this.mutex.run(async () => {
      this.validateRole(parsed);
      return (await this.writeRoleUnlocked(actor.name, parsed, {})).charter;
    });
  }

  /** Adds a channel to a project or to the society. Also what an approved channel proposal executes. */
  async addChannel(actor: Actor, input: AddChannelInput): Promise<ChannelRef> {
    this.assertAdmin(actor);
    return this.mutex.run(async () => {
      await this.validateAddChannel(input);
      return this.addChannelUnlocked(actor.name, input, {});
    });
  }

  /**
   * Adds one member of an existing role to a project, cloned from the newest active member of the
   * role, preferring one on that project. The caller enforces the charter's replica cap.
   */
  async addReplica(actor: Actor, input: AddReplicaInput): Promise<Agent> {
    this.assertAdmin(actor);
    return this.mutex.run(async () => {
      await this.readProject(input.project);
      await this.readRole(input.role);
      const candidates = (await this.listAgents())
        .filter(
          (agent): agent is Agent & { cli: CliKind } =>
            agent.status === "active" && agent.cli !== null && agent.role === input.role,
        )
        .toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const template =
        candidates.find((agent) => agent.memberships.includes(input.project)) ?? candidates[0];
      if (template === undefined) {
        throw new BoardError("NOT_FOUND", `no active ${input.role} exists to replicate`);
      }
      const base = template.name.replace(/-\d+$/, "");
      let index = 2;
      while (await exists(this.paths.agentFile(`${base}-${index}`))) {
        index += 1;
      }
      const { agent } = await this.addAgentUnlocked(
        actor.name,
        {
          name: NameSchema.parse(`${base}-${index}`),
          role: template.role,
          cli: template.cli,
          ...(template.model === undefined ? {} : { model: template.model }),
          homeRunner: template.homeRunner,
          memberships: [input.project],
        },
        { scaledFrom: template.name },
      );
      return agent;
    });
  }

  /** Records a runner's connection state and what it offers. A change of state is an operations signal. */
  async markRunner(name: Name, patch: RunnerPatch): Promise<Runner> {
    return this.mutex.run(async () => {
      const file = this.paths.runner(name);
      if (!(await exists(file))) {
        throw new BoardError("NOT_FOUND", `runner ${name} not found`);
      }
      const doc = await readMarkdown(file, RunnerSchema);
      const next: Runner = RunnerSchema.parse({
        ...doc.data,
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.clis === undefined ? {} : { clis: [...patch.clis] }),
        ...(patch.capabilities === undefined ? {} : { capabilities: [...patch.capabilities] }),
        lastSeen: this.now().toISOString(),
      });
      await writeMarkdown(file, next, doc.body);
      await this.events.append("runner.changed", SYSTEM_ACTOR.name, {
        name,
        status: next.status,
        clis: next.clis,
        capabilities: next.capabilities,
      });
      if (doc.data.status !== next.status) {
        const clis = next.clis.length === 0 ? "" : ` with ${next.clis.join(", ")}`;
        const capabilities =
          next.capabilities.length === 0 ? "" : ` and capabilities ${next.capabilities.join(", ")}`;
        await this.publishSignalUnlocked({
          kind: "runner",
          key: `runner:${name}`,
          summary: `runner ${name} is ${next.status}${clis}${capabilities}`,
          value: next.status === "connected" ? 1 : 0,
        });
      }
      return next;
    });
  }

  /** Publishes an operations signal: a post in the ops channel plus an `ops.signal` event. */
  async publishSignal(signal: OpsSignal): Promise<BoardEvent> {
    return this.mutex.run(() => this.publishSignalUnlocked(signal));
  }

  /** The most recent operations signals from the event log, oldest first. */
  async listSignals(limit = 100): Promise<SignalRecord[]> {
    const events = await this.events.readSince(null, Number.MAX_SAFE_INTEGER);
    const records: SignalRecord[] = [];
    for (const event of events) {
      if (event.type !== "ops.signal") {
        continue;
      }
      const parsed = OpsSignalSchema.safeParse(event.payload);
      if (parsed.success) {
        records.push({ id: event.id, ts: event.ts, signal: parsed.data });
      }
    }
    return records.slice(-limit);
  }

  /** A citizen's finished turns, oldest first, from the event log. */
  async listTurns(agent: Name, limit = 50): Promise<TurnHistoryEntry[]> {
    const events = await this.events.readSince(null, Number.MAX_SAFE_INTEGER);
    const entries: TurnHistoryEntry[] = [];
    // A citizen runs at most one turn per scope at a time, so a turn's start is the latest one
    // logged for its scope.
    const starts = new Map<Name, string>();
    for (const event of events) {
      if (event.actor !== agent) {
        continue;
      }
      if (event.type === "turn.started") {
        const start = TurnStartPayloadSchema.safeParse(event.payload);
        if (start.success) starts.set(start.data.project, event.ts);
        continue;
      }
      if (event.type !== "turn.completed" && event.type !== "turn.failed") {
        continue;
      }
      const parsed = TurnHistoryPayloadSchema.safeParse(event.payload);
      if (parsed.success) {
        const startedAt = starts.get(parsed.data.project);
        starts.delete(parsed.data.project);
        entries.push({
          id: event.id,
          ts: event.ts,
          outcome: event.type === "turn.failed" ? "failed" : "completed",
          ...parsed.data,
          ...(startedAt === undefined ? {} : { startedAt }),
        });
      }
    }
    return entries.slice(-limit);
  }

  async setPaused(actor: Actor, paused: boolean): Promise<void> {
    if (actor.role !== USER_ROLE) {
      throw new BoardError("FORBIDDEN", "only the user may pause or resume the society");
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
              stageSince: now.toISOString(),
              updatedAt: now.toISOString(),
            });
            await this.events.append("lease.expired", task.claimedBy ?? USER_NAME, {
              taskId: task.id,
              project,
              stage: task.stage,
            });
            if (task.claimedBy !== undefined) {
              await this.refreshMember(task.claimedBy);
            }
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
      if (args.thread_id !== undefined) {
        return this.appendThreadMessage(actor.name, args.thread_id, args.body, args.channel);
      }
      if (args.channel === undefined) {
        throw new BoardError("VALIDATION", "a message needs a channel, or a thread_id");
      }
      return this.appendMessage(actor.name, args.channel, args.body);
    });
  }

  /**
   * The reader's digest: messages newer than its cursor that mention it, sit in a channel it
   * follows, or belong to a thread it takes part in. Agents reach it through the `read_inbox` verb.
   */
  async readDigest(actor: Actor, input: VerbInput<"read_inbox"> = {}): Promise<DigestResult> {
    const args = VerbInputs.read_inbox.parse(input);
    await this.authorize(actor, "read_inbox");
    return this.mutex.run(async () => {
      const cursorFile = this.paths.agentCursors(actor.name);
      const stored = await this.readDigestCursor(actor.name);
      const since = args.since_cursor === undefined ? stored : args.since_cursor;
      const messages = (await this.digestSince(actor, since)).slice(0, args.limit);
      const last = messages.at(-1);
      const cursor = last === undefined ? since : last.id;
      if (args.advance && cursor !== stored) {
        await writeJson(cursorFile, { digest: cursor });
      }
      return { messages, cursor };
    });
  }

  /**
   * How many unread digest messages a member has in each scope: a project's slug for its channels
   * and their threads, `society` for the society's channels. The heartbeat asks, so that it wakes
   * a member where its unread messages are and not in every project it belongs to.
   */
  async unreadByScope(actor: Actor): Promise<Map<string, number>> {
    return this.mutex.run(async () => {
      const counts = new Map<string, number>();
      for (const message of await this.digestSince(
        actor,
        await this.readDigestCursor(actor.name),
      )) {
        const scope = parseChannelRef(message.channel).project ?? SOCIETY_SCOPE;
        counts.set(scope, (counts.get(scope) ?? 0) + 1);
      }
      return counts;
    });
  }

  private async readDigestCursor(agent: Name): Promise<Ulid | null> {
    const cursorFile = this.paths.agentCursors(agent);
    return (await exists(cursorFile)) ? (await readJson(cursorFile, CursorsSchema)).digest : null;
  }

  /** The digest after a cursor, oldest first: what mentions the member, sits in a channel it follows, or belongs to a thread it takes part in. */
  private async digestSince(actor: Actor, since: Ulid | null): Promise<Message[]> {
    const agent = await this.readAgent(actor.name);
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
          const found = await this.tryFindThread(message.thread);
          participates =
            found !== null && (await this.participatesInThread(actor, found.thread, found.threads));
          threadParticipation.set(message.thread, participates);
        }
        include = participates;
      }
      if (include && message.author !== actor.name) {
        collected.push(message);
      }
    }
    return collected.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
    if (projectFilter !== undefined && projectFilter !== null) {
      return hits;
    }
    // Shared tiers, then the caller's own archive and skills; another citizen's home is never read.
    const shared: Array<{ kind: SearchHit["kind"]; ref: string; file: string }> = [];
    for (const file of await listFiles(this.paths.societyKnowledge())) {
      shared.push({
        kind: "knowledge",
        ref: `society/knowledge/${file}`,
        file: path.join(this.paths.societyKnowledge(), file),
      });
    }
    for (const skill of await this.listSocietySkills()) {
      shared.push({ kind: "skill", ref: `society/skills/${skill.name}`, file: skill.path });
    }
    for (const skill of await this.listAgentSkills(actor.name)) {
      shared.push({ kind: "skill", ref: `skills/${skill.name}`, file: skill.path });
    }
    for (const file of await listFiles(this.paths.agentMemory(actor.name))) {
      shared.push({
        kind: "memory",
        ref: `memory/${file}`,
        file: path.join(this.paths.agentMemory(actor.name), file),
      });
    }
    for (const entry of shared) {
      const content = await readFile(entry.file, "utf8");
      if (content.toLowerCase().includes(needle)) {
        hits.push({
          kind: entry.kind,
          ref: entry.ref,
          snippet: snippetAround(content, args.query),
        });
        if (hits.length >= args.limit) {
          return hits;
        }
      }
    }
    return hits;
  }

  /**
   * Writes a topic: a project's by its members, the society's by the curating roles. The note in
   * the matching general channel carries no mention, so nobody is woken.
   */
  async writeKnowledge(actor: Actor, input: VerbInput<"write_knowledge">): Promise<Knowledge> {
    const args = VerbInputs.write_knowledge.parse(input);
    await this.authorize(actor, "write_knowledge");
    return this.mutex.run(async () => {
      if (args.project === null) {
        if (!CURATING_ROLES.includes(actor.role)) {
          throw new BoardError(
            "FORBIDDEN",
            "society knowledge is curated by the steward and the user",
          );
        }
      } else {
        const project = await this.readProject(args.project);
        if (!CURATING_ROLES.includes(actor.role) && !project.members.includes(actor.name)) {
          throw new BoardError("FORBIDDEN", `${actor.name} is not a member of ${args.project}`);
        }
      }
      const data = KnowledgeSchema.parse({
        topic: args.topic,
        project: args.project,
        updatedBy: actor.name,
        updatedAt: this.now().toISOString(),
      });
      const file =
        args.project === null
          ? this.paths.societyKnowledgeFile(args.topic)
          : this.paths.projectKnowledgeFile(args.project, args.topic);
      const replaced = await exists(file);
      await writeMarkdown(file, data, args.body);
      await this.events.append("knowledge.written", actor.name, {
        topic: args.topic,
        project: args.project,
        replaced,
      });
      const where = args.project === null ? "general" : channelRef(args.project, "general");
      await this.appendMessage(
        actor.name,
        where,
        `Knowledge ${replaced ? "updated" : "written"}: ${args.topic}. It is under knowledge/${args.topic}.md${
          args.project === null ? " of the society" : ""
        }.`,
      );
      return { ...data, body: args.body };
    });
  }

  async openThread(actor: Actor, input: VerbInput<"open_thread">): Promise<Thread> {
    const args = VerbInputs.open_thread.parse(input);
    await this.authorize(actor, "open_thread");
    return this.mutex.run(async () => {
      const { id, channel, title, subject } = await this.threadToOpen(args);
      if ((await this.tryFindThread(id)) !== null) {
        throw new BoardError(
          "INVALID_STATE",
          `${subject?.kind ?? "thread"} ${id} already has a thread`,
        );
      }
      const threads = this.paths.threadsOf(channel);
      await ensureDir(this.paths.threadMessages(threads, id));
      const thread = await this.writeThread(threads, {
        id,
        channel,
        title,
        ...(subject === undefined ? {} : { subject }),
        state: "open",
        openedBy: actor.name,
        openedAt: this.now().toISOString(),
        body: "",
      });
      await this.events.append("thread.opened", actor.name, {
        threadId: id,
        channel,
        subject: subject ?? null,
      });
      return thread;
    });
  }

  /** Where a new thread hangs, what it is called, and what it is about. */
  private async threadToOpen(
    args: VerbArgs<"open_thread">,
  ): Promise<{ id: Ulid; channel: ChannelRef; title: string; subject?: ThreadSubject }> {
    if (args.task_id !== undefined && args.proposal_id !== undefined) {
      throw new BoardError("VALIDATION", "a thread is about one task or one proposal, not both");
    }
    if (args.task_id !== undefined) {
      const { task, project } = await this.findTask(args.task_id);
      if (task.status === "done" || task.status === "abandoned") {
        throw new BoardError("INVALID_STATE", `task ${task.id} is ${task.status}`);
      }
      const channel = args.channel ?? channelRef(project, "general");
      if (parseChannelRef(channel).project !== project) {
        throw new BoardError(
          "VALIDATION",
          `a task's thread hangs off a channel of its project, ${project}`,
        );
      }
      await this.assertChannelExists(channel);
      return {
        id: task.id,
        channel,
        title: args.title ?? task.title,
        subject: { kind: "task", id: task.id },
      };
    }
    if (args.proposal_id !== undefined) {
      const proposal = await this.readProposal(args.proposal_id);
      if (proposal.status !== "proposed") {
        throw new BoardError(
          "INVALID_STATE",
          `proposal ${proposal.id} is already ${proposal.status}`,
        );
      }
      const channel = args.channel ?? "governance";
      await this.assertChannelExists(channel);
      const described = `${proposal.kind} proposal: ${describeCharter(proposal.kind, proposal.charter)}`;
      return {
        id: proposal.id,
        channel,
        title: args.title ?? described.slice(0, 200),
        subject: { kind: "proposal", id: proposal.id },
      };
    }
    if (args.channel === undefined || args.title === undefined) {
      throw new BoardError(
        "VALIDATION",
        "a thread needs a task_id, a proposal_id, or a channel and a title",
      );
    }
    await this.assertChannelExists(args.channel);
    return { id: this.newId(), channel: args.channel, title: args.title };
  }

  async closeThread(actor: Actor, input: VerbInput<"close_thread">): Promise<Message> {
    const args = VerbInputs.close_thread.parse(input);
    await this.authorize(actor, "close_thread");
    return this.mutex.run(async () => {
      const { thread, threads } = await this.findThread(args.thread_id);
      if (thread.state !== "open") {
        throw new BoardError("INVALID_STATE", `thread ${thread.id} is not open`);
      }
      if (
        !PLANNING_ROLES.includes(actor.role) &&
        !(await this.participatesInThread(actor, thread, threads))
      ) {
        throw new BoardError(
          "FORBIDDEN",
          "only the thread's participants, the user, the steward, or the concierge may close it",
        );
      }
      const summary = await this.writeMessage(
        this.paths.channelDir(thread.channel),
        { author: actor.name, channel: thread.channel, closes: thread.id },
        `Thread closed: "${thread.title}" (${thread.id}).\n\n${args.summary}`,
      );
      await this.writeThread(threads, {
        ...thread,
        state: "closed",
        closedBy: actor.name,
        closedAt: summary.ts,
        body: args.summary,
      });
      await this.events.append("thread.closed", actor.name, {
        threadId: thread.id,
        channel: thread.channel,
      });
      return summary;
    });
  }

  async createTask(actor: Actor, input: VerbInput<"create_task">): Promise<Task> {
    const args = VerbInputs.create_task.parse(input);
    await this.authorize(actor, "create_task");
    return this.mutex.run(async () => {
      const project = await this.readProject(args.project);
      if (args.parent_id !== undefined) {
        const parent = await this.findTask(args.parent_id);
        if (parent.project !== args.project) {
          throw new BoardError("VALIDATION", "a subtask must belong to its parent's project");
        }
      }
      if (args.stages?.some((stage) => stage.gate) === true) {
        this.assertMayGate(actor, "set a gate");
      }
      const planned: readonly PlanStage[] =
        args.stages ??
        (project.defaultPlan.length > 0 ? project.defaultPlan : [{ name: "work", gate: false }]);
      await this.validateAssignees(planned);
      const stages = planned.map((stage, index) => stageFrom(stage, `s${index + 1}`));
      const first = stages[0];
      if (first === undefined) {
        throw new BoardError("VALIDATION", "a plan needs at least one stage");
      }
      const ts = this.now().toISOString();
      const frontmatter: TaskFrontmatter = TaskFrontmatterSchema.parse({
        id: this.newId(),
        project: args.project,
        title: args.title,
        status: "open",
        createdBy: actor.name,
        createdAt: ts,
        updatedAt: ts,
        ...(args.parent_id === undefined ? {} : { parentId: args.parent_id }),
        blockedBy: [],
        requiredCapabilities: args.required_capabilities,
        stages,
        stage: first.id,
        stageSince: ts,
        stageSeq: stages.length,
        onDone: project.onDone,
        completing: false,
      });
      const task = await this.writeTask(args.project, { ...frontmatter, body: args.body });
      await this.events.append("task.created", actor.name, {
        taskId: task.id,
        project: task.project,
        title: task.title,
        parentId: task.parentId ?? null,
        stage: task.stage,
      });
      return task;
    });
  }

  /** Holds the task's current stage, or renews the lease on a stage the actor already holds. */
  async claimTask(actor: Actor, input: VerbInput<"claim_task">): Promise<Task> {
    const args = VerbInputs.claim_task.parse(input);
    await this.authorize(actor, "claim_task");
    return this.mutex.run(async () => {
      const location = await this.findTask(args.task_id);
      const current = location.task;
      const now = this.now();
      this.assertInPlay(current);
      if (current.status === "claimed" && !this.leaseExpired(current, now)) {
        if (current.claimedBy !== actor.name) {
          throw new BoardError(
            "CLAIM_CONFLICT",
            `task ${current.id} is held by ${current.claimedBy ?? "someone"}`,
          );
        }
        return this.writeTask(location.project, {
          ...current,
          leaseExpiresAt: this.leaseEnd(now),
          updatedAt: now.toISOString(),
        });
      }
      const lapsed = current.status === "claimed" ? current.claimedBy : undefined;
      if (lapsed !== undefined) {
        await this.events.append("lease.expired", lapsed, {
          taskId: current.id,
          project: location.project,
          stage: current.stage,
        });
      }
      await this.assertMayHold(actor, current);
      const task = await this.writeTask(location.project, {
        ...current,
        status: "claimed",
        claimedBy: actor.name,
        leaseExpiresAt: this.leaseEnd(now),
        updatedAt: now.toISOString(),
        stages: current.stages.map((stage) =>
          stage.id === current.stage && !stage.holders.includes(actor.name)
            ? { ...stage, holders: [...stage.holders, actor.name] }
            : stage,
        ),
      });
      await this.refreshMember(actor.name);
      if (lapsed !== undefined && lapsed !== actor.name) {
        await this.refreshMember(lapsed);
      }
      await this.events.append("task.claimed", actor.name, {
        taskId: task.id,
        project: location.project,
        stage: task.stage,
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
      if (current.status !== "claimed" || current.claimedBy === undefined) {
        throw new BoardError(
          "INVALID_TRANSITION",
          `task ${current.id} is ${current.status}; nobody holds its stage`,
        );
      }
      if (current.claimedBy !== actor.name && !PLANNING_ROLES.includes(actor.role)) {
        throw new BoardError(
          "FORBIDDEN",
          "only the holder, the user, the steward, or the concierge may release a stage",
        );
      }
      const ts = this.now().toISOString();
      const task = await this.writeTask(location.project, {
        ...current,
        status: "open",
        claimedBy: undefined,
        leaseExpiresAt: undefined,
        stageSince: ts,
        updatedAt: ts,
      });
      await this.refreshMember(current.claimedBy);
      await this.events.append("task.released", actor.name, {
        taskId: task.id,
        project: location.project,
        stage: task.stage,
      });
      return task;
    });
  }

  /**
   * Completes the current stage. The next stage becomes current and waits for its holder; past the
   * last stage the task is done, or completing while the project's completion effect runs.
   */
  async advanceTask(actor: Actor, input: VerbInput<"advance_task">): Promise<Task> {
    const args = VerbInputs.advance_task.parse(input);
    await this.authorize(actor, "advance_task");
    return this.mutex.run(async () => {
      const location = await this.findTask(args.task_id);
      const current = location.task;
      this.assertInPlay(current);
      const index = stageIndex(current, current.stage);
      const stage = current.stages[index];
      if (stage === undefined) {
        throw new BoardError("INVALID_STATE", `task ${current.id} has no stage ${current.stage}`);
      }
      const holds = current.status === "claimed" && current.claimedBy === actor.name;
      if (!holds && actor.role !== USER_ROLE) {
        throw new BoardError(
          "FORBIDDEN",
          `only the holder of stage ${stage.id} "${stage.name}" may advance it; claim it first`,
        );
      }
      const ts = this.now().toISOString();
      const completed: Stage = {
        ...stage,
        holders: stage.holders.includes(actor.name)
          ? stage.holders
          : [...stage.holders, actor.name],
        completedBy: actor.name,
        completedAt: ts,
      };
      const next = current.stages[index + 1];
      // The rework after a send-back lasts until the task is back at the stage that returned it.
      const reworkDone =
        current.returned === undefined ||
        next === undefined ||
        index + 1 >= stageIndex(current, current.returned.from);
      const base: Task = {
        ...current,
        ...(reworkDone ? { returned: undefined } : {}),
        stages: current.stages.map((s, i) => (i === index ? completed : s)),
        body:
          args.note === undefined
            ? current.body
            : appendNote(current.body, ts, actor.name, `${stage.name}: ${args.note}`),
        claimedBy: undefined,
        leaseExpiresAt: undefined,
        updatedAt: ts,
      };
      let task: Task;
      if (next !== undefined) {
        task = await this.writeTask(location.project, {
          ...base,
          status: "open",
          stage: next.id,
          stageSince: ts,
        });
      } else if (current.onDone === "none") {
        task = await this.writeEndedTask(actor.name, location.project, {
          ...base,
          status: "done",
        });
      } else {
        task = await this.writeTask(location.project, {
          ...base,
          status: "open",
          completing: true,
        });
      }
      await this.events.append("task.advanced", actor.name, {
        taskId: task.id,
        project: location.project,
        from: stage.id,
        to: next?.id ?? null,
        note: args.note ?? null,
      });
      if (task.status === "done") {
        await this.events.append("task.completed", actor.name, {
          taskId: task.id,
          project: location.project,
          createdBy: task.createdBy,
          effect: task.onDone,
        });
        for (const name of new Set(task.stages.flatMap((s) => s.completedBy ?? []))) {
          await this.refreshMember(name);
        }
      } else if (task.completing) {
        await this.events.append("task.completing", actor.name, {
          taskId: task.id,
          project: location.project,
          effect: task.onDone,
        });
      }
      await this.refreshMember(actor.name);
      return task;
    });
  }

  /**
   * Reshapes a task's plan from the current stage onward while nobody holds it, and after it
   * otherwise. Any member of the project may plan; changes that touch a gate, and the completion
   * effect, are the user's, the steward's, and the concierge's.
   */
  async planTask(actor: Actor, input: VerbInput<"plan_task">): Promise<Task> {
    const args = VerbInputs.plan_task.parse(input);
    await this.authorize(actor, "plan_task");
    return this.mutex.run(async () => {
      const location = await this.findTask(args.task_id);
      const current = location.task;
      this.assertInPlay(current);
      const planner = PLANNING_ROLES.includes(actor.role);
      if (!planner) {
        const agent = await this.readAgent(actor.name);
        if (!agent.memberships.includes(current.project)) {
          throw new BoardError(
            "FORBIDDEN",
            `${actor.name} is not a member of ${current.project}; join it first`,
          );
        }
      }
      const index = stageIndex(current, current.stage);
      const from = current.status === "open" ? index : index + 1;
      const ahead = current.stages.slice(from);
      const aheadById = new Map(ahead.map((stage) => [stage.id, stage]));
      const seen = new Set<StageId>();
      let seq = current.stageSeq;
      const replanned: Stage[] = [];
      for (const edit of args.stages) {
        if (edit.id === undefined) {
          seq += 1;
          replanned.push(stageFrom(edit, `s${seq}`));
          continue;
        }
        const existing = aheadById.get(edit.id);
        if (existing === undefined) {
          throw new BoardError(
            "VALIDATION",
            `stage ${edit.id} is not ahead of the current stage, so plan_task cannot keep it`,
          );
        }
        if (seen.has(edit.id)) {
          throw new BoardError("VALIDATION", `stage ${edit.id} appears twice`);
        }
        seen.add(edit.id);
        replanned.push(restage(existing, edit));
      }
      if (from === index && replanned.length === 0) {
        throw new BoardError(
          "VALIDATION",
          "the current stage is waiting: keep it or give its replacement, or abandon the task",
        );
      }
      const onDone = args.on_done ?? current.onDone;
      const guarded = gateChanges(ahead, replanned);
      if (onDone !== current.onDone) {
        guarded.push("change the completion effect");
      }
      if (guarded.length > 0) {
        this.assertMayGate(actor, guarded.join(", "));
      }
      await this.validateAssignees(replanned);
      const stages = [...current.stages.slice(0, from), ...replanned];
      const now = stages[index];
      if (now === undefined) {
        throw new BoardError("VALIDATION", "a plan needs at least one stage");
      }
      const ts = this.now().toISOString();
      const currentChanged = now.id !== current.stage;
      const task = await this.writeTask(location.project, {
        ...current,
        stages,
        stage: now.id,
        stageSeq: seq,
        onDone,
        updatedAt: ts,
        ...(currentChanged ? { stageSince: ts } : {}),
      });
      await this.events.append("task.planned", actor.name, {
        taskId: task.id,
        project: location.project,
        stage: task.stage,
        currentChanged,
        stages: task.stages.map((stage) => stage.id),
      });
      return task;
    });
  }

  /** Moves a task back to an earlier stage, abandons it, adds a note, or sets its blockers. */
  async updateTask(actor: Actor, input: VerbInput<"update_task">): Promise<Task> {
    const args = VerbInputs.update_task.parse(input);
    await this.authorize(actor, "update_task");
    return this.mutex.run(async () => {
      const location = await this.findTask(args.task_id);
      const current = location.task;
      const now = this.now();
      const ts = now.toISOString();
      let next: Task = { ...current, updatedAt: ts };
      let moved: { from: StageId; to: StageId } | null = null;

      if (args.status !== undefined || args.stage !== undefined) {
        this.assertInPlay(current);
      }
      if (args.status === "abandoned") {
        const mayAbandon =
          current.claimedBy === actor.name ||
          current.createdBy === actor.name ||
          PLANNING_ROLES.includes(actor.role);
        if (!mayAbandon) {
          throw new BoardError(
            "FORBIDDEN",
            "only the holder, the creator, the user, the steward, or the concierge may abandon a task",
          );
        }
        next = {
          ...next,
          status: "abandoned",
          claimedBy: undefined,
          leaseExpiresAt: undefined,
          returned: undefined,
        };
      } else if (args.stage !== undefined) {
        const at = stageIndex(current, current.stage);
        const to = stageIndex(current, args.stage);
        if (to < 0) {
          throw new BoardError("NOT_FOUND", `task ${current.id} has no stage ${args.stage}`);
        }
        if (to >= at) {
          throw new BoardError(
            "VALIDATION",
            "update_task moves a task back to an earlier stage; advance_task moves it forward",
          );
        }
        if (current.claimedBy !== actor.name && !PLANNING_ROLES.includes(actor.role)) {
          throw new BoardError(
            "FORBIDDEN",
            "only the holder of the current stage, the user, the steward, or the concierge may send a task back",
          );
        }
        next = {
          ...next,
          status: "open",
          claimedBy: undefined,
          leaseExpiresAt: undefined,
          stage: args.stage,
          stageSince: ts,
          stages: current.stages.map((stage, i) =>
            i >= to && i <= at ? reopenStage(stage) : stage,
          ),
          returned: { from: current.stage, by: actor.name, at: ts },
        };
        moved = { from: current.stage, to: args.stage };
      }
      if (args.blocked_by !== undefined) {
        for (const id of args.blocked_by) {
          await this.findTask(id);
        }
        next = { ...next, blockedBy: [...args.blocked_by] };
      }
      if (args.note !== undefined) {
        next = { ...next, body: appendNote(next.body, ts, actor.name, args.note) };
      }
      if (next.status === "claimed" && next.claimedBy === actor.name) {
        next = { ...next, leaseExpiresAt: this.leaseEnd(now) };
      }

      const task =
        next.status === "abandoned"
          ? await this.writeEndedTask(actor.name, location.project, next)
          : await this.writeTask(location.project, next);
      if (current.claimedBy !== undefined && task.claimedBy !== current.claimedBy) {
        await this.refreshMember(current.claimedBy);
      }
      if (moved !== null) {
        await this.events.append("task.moved", actor.name, {
          taskId: task.id,
          project: location.project,
          from: moved.from,
          to: moved.to,
          note: args.note ?? null,
        });
      } else {
        await this.events.append("task.updated", actor.name, {
          taskId: task.id,
          project: location.project,
          from: current.status,
          to: task.status,
          note: args.note ?? null,
        });
      }
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
      await this.refreshMember(actor.name);
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
      await this.refreshMember(actor.name);
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
      // What approval would provision must be possible now, so nobody decides a doomed proposal.
      await this.validateProvision(proposal.kind, proposal.charter);
      await this.writeProposal(proposal);
      await this.events.append("proposal.created", actor.name, {
        proposalId: proposal.id,
        kind: proposal.kind,
      });
      const rationale = args.rationale.trim();
      await this.appendMessage(
        actor.name,
        "governance",
        `Proposal ${proposal.id}: ${describeCharter(proposal.kind, proposal.charter)}.${
          rationale.length === 0 ? "" : `\n\n${rationale}`
        }`,
      );
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

  /** Creates a project with its default channels. */
  async createProject(actor: Actor, input: VerbInput<"create_project">): Promise<Project> {
    const args = VerbInputs.create_project.parse(input);
    await this.authorize(actor, "create_project");
    return this.mutex.run(() =>
      this.createProjectUnlocked(actor.name, {
        slug: args.slug,
        ...(args.name === undefined ? {} : { name: args.name }),
        repo: args.repo,
        defaultBranch: args.default_branch,
        ...(args.default_plan === undefined ? {} : { defaultPlan: args.default_plan }),
        ...(args.on_done === undefined ? {} : { onDone: args.on_done }),
      }),
    );
  }

  /** Sets a project's default plan and completion effect. */
  async configureProject(actor: Actor, input: VerbInput<"configure_project">): Promise<Project> {
    const args = VerbInputs.configure_project.parse(input);
    await this.authorize(actor, "configure_project");
    return this.mutex.run(async () => {
      await this.readProject(args.project);
      if (args.default_plan !== undefined) {
        await this.validateAssignees(args.default_plan);
      }
      const project = await this.updateProject(args.project, (current) => ({
        ...current,
        ...(args.default_plan === undefined ? {} : { defaultPlan: args.default_plan }),
        ...(args.on_done === undefined ? {} : { onDone: args.on_done }),
      }));
      await this.events.append("project.configured", actor.name, {
        slug: project.slug,
        onDone: project.onDone,
        defaultPlan: project.defaultPlan.map((stage) => stage.name),
      });
      return project;
    });
  }

  /**
   * A citizen joins a project itself, or a reallocating role adds it. The pair gets its project
   * directory now and, through the `agent.joined` event, an onboarding turn.
   */
  async joinProject(actor: Actor, input: VerbInput<"join_project">): Promise<Agent> {
    const args = VerbInputs.join_project.parse(input);
    await this.authorize(actor, "join_project");
    const target = args.agent ?? actor.name;
    this.assertMayReallocate(actor, target);
    return this.mutex.run(async () => {
      await this.readProject(args.project);
      const current = await this.readAgent(target);
      if (current.status !== "active") {
        throw new BoardError("INVALID_STATE", `${target} is retired`);
      }
      if (current.memberships.includes(args.project)) {
        return current;
      }
      const agent = await this.updateAgent(target, (a) => ({
        ...a,
        memberships: [...a.memberships, args.project],
        subscriptions: [...new Set([...a.subscriptions, channelRef(args.project, "general")])],
      }));
      await this.ensureAgentProject(target, args.project);
      await this.updateProject(args.project, (project) => ({
        ...project,
        members: [...new Set([...project.members, target])],
      }));
      await this.refreshMember(target);
      await this.events.append("agent.joined", actor.name, {
        name: target,
        project: args.project,
        cli: agent.cli,
      });
      return agent;
    });
  }

  async leaveProject(actor: Actor, input: VerbInput<"leave_project">): Promise<Agent> {
    const args = VerbInputs.leave_project.parse(input);
    await this.authorize(actor, "leave_project");
    const target = args.agent ?? actor.name;
    this.assertMayReallocate(actor, target);
    return this.mutex.run(async () => {
      await this.readProject(args.project);
      const current = await this.readAgent(target);
      if (!current.memberships.includes(args.project)) {
        return current;
      }
      const released: Ulid[] = [];
      for (const task of await this.heldClaims(target)) {
        if (task.project !== args.project) {
          continue;
        }
        await this.writeTask(task.project, {
          ...task,
          status: "open",
          claimedBy: undefined,
          leaseExpiresAt: undefined,
          stageSince: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        });
        await this.events.append("task.released", actor.name, {
          taskId: task.id,
          project: task.project,
          releasedFrom: target,
          reason: "left the project",
        });
        released.push(task.id);
      }
      const agent = await this.updateAgent(target, (a) => ({
        ...a,
        memberships: a.memberships.filter((slug) => slug !== args.project),
        subscriptions: a.subscriptions.filter(
          (ref) => parseChannelRef(ref).project !== args.project,
        ),
      }));
      await this.updateProject(args.project, (project) => ({
        ...project,
        members: project.members.filter((member) => member !== target),
      }));
      await this.refreshMember(target);
      await this.events.append("agent.left", actor.name, {
        name: target,
        project: args.project,
        releasedTasks: released,
      });
      return agent;
    });
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
        return this.readDigest(actor, VerbInputs.read_inbox.parse(input));
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
      case "create_project":
        return this.createProject(actor, VerbInputs.create_project.parse(input));
      case "join_project":
        return this.joinProject(actor, VerbInputs.join_project.parse(input));
      case "leave_project":
        return this.leaveProject(actor, VerbInputs.leave_project.parse(input));
      case "write_knowledge":
        return this.writeKnowledge(actor, VerbInputs.write_knowledge.parse(input));
      case "plan_task":
        return this.planTask(actor, VerbInputs.plan_task.parse(input));
      case "advance_task":
        return this.advanceTask(actor, VerbInputs.advance_task.parse(input));
      case "configure_project":
        return this.configureProject(actor, VerbInputs.configure_project.parse(input));
      default:
        throw new BoardError("VALIDATION", `unknown verb ${String(verb)}`);
    }
  }

  /** The admin CLI's manual wake. It becomes a `wake.requested` event the scheduler consumes. */
  async requestWake(actor: Actor, input: WakeRequestInput): Promise<BoardLogEvent> {
    this.assertAdmin(actor);
    const args = WakeRequestSchema.parse(input);
    const agent = await this.readAgent(args.agent);
    if (args.project === SOCIETY_SCOPE) {
      const charter = await this.readRole(agent.role);
      if (!charter.societyScope) {
        throw new BoardError("VALIDATION", `${args.agent} cannot take society-scope turns`);
      }
    } else {
      await this.readProject(args.project);
      if (!agent.memberships.includes(args.project)) {
        throw new BoardError("VALIDATION", `${args.agent} is not a member of ${args.project}`);
      }
    }
    return this.mutex.run(() =>
      this.events.append("wake.requested", actor.name, {
        agent: args.agent,
        project: args.project,
        reason: args.reason,
        kind: args.kind,
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
    return (await this.listTasks(project)).filter(
      (task) => task.status === "open" && !task.completing,
    );
  }

  async readAgentRoleBody(agent: Name): Promise<string> {
    const file = this.paths.agentRole(agent);
    return (await exists(file))
      ? (await readMarkdown(file, z.record(z.string(), z.unknown()))).body
      : "";
  }

  /** The steps of one finished turn, as the runner handed them over when it ended. */
  async readTranscript(agent: Name, turnId: string): Promise<TranscriptEntry[]> {
    // The id names a file, so only a ULID may reach the path.
    const id = UlidSchema.safeParse(turnId);
    const file = id.success ? this.paths.agentTranscript(agent, id.data) : null;
    if (file === null || !(await exists(file))) {
      throw new BoardError("NOT_FOUND", `no transcript of turn ${turnId} for ${agent}`);
    }
    const entries: TranscriptEntry[] = [];
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (line.trim() === "") continue;
      const parsed = TranscriptEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    }
    return entries;
  }

  async readMemoryCore(agent: Name): Promise<string> {
    const file = this.paths.agentMemoryCore(agent);
    return (await exists(file))
      ? (await readMarkdown(file, z.record(z.string(), z.unknown()))).body
      : "";
  }

  async setDigestCursor(agent: Name, cursor: Ulid | null): Promise<void> {
    await this.mutex.run(() => writeJson(this.paths.agentCursors(agent), { digest: cursor }));
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
  /** Records a turn's start and gives it the id its transcript will be filed under. */
  async beginTurn(record: TurnRecord): Promise<TurnRecord> {
    const parsed = TurnRecordSchema.parse({ ...record, id: record.id ?? this.newId() });
    await this.mutex.run(async () => {
      await this.writeTurnRecord(parsed);
      await this.events.append("turn.started", parsed.agent, {
        turnId: parsed.id,
        project: parsed.project,
        trigger: parsed.trigger.kind,
        session: parsed.session,
        runner: parsed.runner,
      });
    });
    return parsed;
  }

  /** Records a turn's end. Timeouts and errors become `turn.failed`; everything else `turn.completed`. */
  /** Records a turn's end, with the steps it took when the runner kept them. */
  async finishTurn(record: TurnRecord, transcript: readonly TranscriptEntry[] = []): Promise<void> {
    const parsed = TurnRecordSchema.parse(record);
    const failed = parsed.exitReason === "error" || parsed.exitReason === "timeout";
    await this.mutex.run(async () => {
      if (parsed.id !== undefined && transcript.length > 0) {
        await ensureDir(this.paths.agentTurns(parsed.agent));
        await writeFileAtomic(
          this.paths.agentTranscript(parsed.agent, parsed.id),
          `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        );
      }
      await this.writeTurnRecord(parsed);
      await this.refreshMember(parsed.agent);
      await this.events.append(failed ? "turn.failed" : "turn.completed", parsed.agent, {
        ...(parsed.id === undefined ? {} : { turnId: parsed.id }),
        project: parsed.project,
        trigger: parsed.trigger.kind,
        session: parsed.session,
        exitReason: parsed.exitReason,
        costUsd: parsed.costUsd,
        toolCalls: parsed.toolCalls,
        model: parsed.model,
        summary: parsed.status?.summary ?? null,
        needsUserDecision: parsed.status?.needsUserDecision ?? false,
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

  /**
   * Records the outcome of a completing task's effect: done, or waiting again at its last stage so
   * its participants can reshape the plan.
   */
  async finishCompletion(
    actor: Actor,
    input: { taskId: Ulid; ok: boolean; detail: string },
  ): Promise<Task> {
    return this.mutex.run(async () => {
      const location = await this.findTask(input.taskId);
      const current = location.task;
      if (!current.completing) {
        throw new BoardError("INVALID_STATE", `task ${current.id} is not completing`);
      }
      const ts = this.now().toISOString();
      if (input.ok) {
        const task = await this.writeEndedTask(actor.name, location.project, {
          ...current,
          status: "done",
          completing: false,
          updatedAt: ts,
        });
        await this.events.append("task.completed", actor.name, {
          taskId: task.id,
          project: location.project,
          createdBy: task.createdBy,
          effect: task.onDone,
          detail: input.detail,
        });
        for (const name of new Set(task.stages.flatMap((stage) => stage.completedBy ?? []))) {
          await this.refreshMember(name);
        }
        return task;
      }
      const task = await this.writeTask(location.project, {
        ...current,
        status: "open",
        completing: false,
        stageSince: ts,
        updatedAt: ts,
        stages: current.stages.map((stage) =>
          stage.id === current.stage ? reopenStage(stage) : stage,
        ),
      });
      await this.events.append("task.reopened", actor.name, {
        taskId: task.id,
        project: location.project,
        stage: task.stage,
        detail: input.detail,
      });
      return task;
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

  /** The project's editable dashboard: frontmatter plus markdown body. Empty when none exists. */
  async readDashboard(slug: Name): Promise<{ data: Record<string, unknown>; body: string }> {
    await this.readProject(slug);
    const file = this.paths.dashboard(slug);
    if (!(await exists(file))) {
      return { data: { project: slug }, body: "" };
    }
    return readMarkdown(file, z.record(z.string(), z.unknown()));
  }

  async listRunners(): Promise<Runner[]> {
    const runners: Runner[] = [];
    for (const file of await listFiles(this.paths.runners())) {
      runners.push((await readMarkdown(path.join(this.paths.runners(), file), RunnerSchema)).data);
    }
    return runners;
  }

  async readRunner(name: Name): Promise<Runner> {
    const file = this.paths.runner(name);
    if (!(await exists(file))) {
      throw new BoardError("NOT_FOUND", `runner ${name} not found`);
    }
    return (await readMarkdown(file, RunnerSchema)).data;
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
      this.paths.members(),
      this.paths.societyKnowledge(),
      this.paths.societySkills(),
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
      name: SERVER_RUNNER,
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
      `# ${runner.name}\n\nThe runner embedded in the board server.\n`,
    );
    await writeJson(this.paths.pausedFile(), { paused: false });

    const userToken = mintToken();
    const userCharter = await this.readRole(USER_ROLE);
    const user: Agent = AgentSchema.parse({
      name: USER_NAME,
      role: USER_ROLE,
      cli: null,
      homeRunner: SERVER_RUNNER,
      memberships: [],
      subscriptions: [],
      status: "active",
      createdAt,
      tokenHash: hashToken(userToken),
    });
    await this.writeAgentHome(user, userCharter);
    await this.events.append("society.initialized", USER_NAME, { name: society.name });
    return userToken;
  }

  /** The charter as the citizen reads it: its purpose, the routing rule for lessons, and its own seed instructions. */
  private async writeAgentRole(agent: Name, charter: RoleCharter, seed: string): Promise<void> {
    await writeMarkdown(
      this.paths.agentRole(agent),
      { role: charter.name, agent },
      `# ${agent}, ${charter.name}\n\n${charter.purpose}\n\n` +
        `Route every lesson with one question: about me, my craft, or the user, it goes in memory/core.md; ` +
        `about this codebase, it goes in the project's knowledge directory; something everyone should know, post it.\n` +
        (seed.length === 0 ? "" : `\n${SEED_INSTRUCTIONS_HEADING}\n\n${seed}\n`),
    );
  }

  /**
   * A charter change reaches every active member of the role: each one's role file is rewritten
   * from the new charter, keeping the seed instructions that are the member's own.
   */
  private async refreshAgentRoles(charter: RoleCharter): Promise<void> {
    for (const agent of await this.listAgents()) {
      if (agent.role !== charter.name || agent.status !== "active") {
        continue;
      }
      const file = this.paths.agentRole(agent.name);
      const body = (await exists(file))
        ? (await readMarkdown(file, z.record(z.string(), z.unknown()))).body
        : "";
      const at = body.indexOf(`\n${SEED_INSTRUCTIONS_HEADING}\n`);
      const seed = at < 0 ? "" : body.slice(at + SEED_INSTRUCTIONS_HEADING.length + 2).trim();
      await this.writeAgentRole(agent.name, charter, seed);
    }
  }

  private async writeAgentHome(
    agent: Agent,
    charter: RoleCharter,
    seedInstructions?: string,
  ): Promise<void> {
    await writeJson(this.paths.agentFile(agent.name), agent);
    await this.writeAgentRole(agent.name, charter, seedInstructions?.trim() ?? "");
    await ensureDir(this.paths.agentMemory(agent.name));
    if (!(await exists(this.paths.agentMemoryCore(agent.name)))) {
      await writeMarkdown(
        this.paths.agentMemoryCore(agent.name),
        { agent: agent.name, updatedAt: agent.createdAt },
        `# Core memory\n\nShort, curated, loaded on every turn. Keep entries that change future behavior and hold across tasks.\n`,
      );
    }
    if (!(await exists(this.paths.agentProfile(agent.name)))) {
      await writeMarkdown(
        this.paths.agentProfile(agent.name),
        { agent: agent.name, updatedAt: agent.createdAt },
        PROFILE_TEMPLATE,
      );
    }
    await ensureDir(this.paths.agentSkills(agent.name));
    for (const slug of agent.memberships) {
      await this.ensureAgentProject(agent.name, slug);
    }
    this.tokenIndex.set(agent.tokenHash, { name: agent.name, role: agent.role });
    await this.refreshMember(agent.name);
  }

  private async ensureAgentProject(name: Name, slug: Name): Promise<void> {
    const dir = this.paths.agentProject(name, slug);
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

  /**
   * Rewrites a citizen's roster entry from its record, its claims, its task history, its last
   * turn, and its profile. Every path that changes one of those must call it.
   */
  private async refreshMember(name: Name): Promise<void> {
    if (!(await exists(this.paths.agentFile(name)))) {
      return;
    }
    const agent = await this.readAgent(name);
    const charter = await this.readRole(agent.role);
    let claimsHeld = 0;
    let tasksDone = 0;
    for (const project of await listDirs(this.paths.projects())) {
      for (const task of await this.listTasks(project)) {
        if (task.status === "claimed" && task.claimedBy === name) {
          claimsHeld += 1;
        } else if (
          task.status === "done" &&
          task.stages.some((stage) => stage.completedBy === name)
        ) {
          tasksDone += 1;
        }
      }
    }
    let lastTurnAt: string | undefined;
    let lastTurnOutcome: string | undefined;
    let lastModel: string | undefined;
    for (const scope of await listDirs(this.paths.agentProjects(name))) {
      const turn = await this.readLastTurn(name, scope);
      const at = turn?.endedAt ?? turn?.startedAt;
      if (turn !== null && at !== undefined && (lastTurnAt === undefined || at > lastTurnAt)) {
        lastTurnAt = at;
        lastTurnOutcome = `${turn.trigger.kind} on ${scope}: ${turn.exitReason ?? "running"}${
          turn.status === null ? "" : `, ${turn.status.summary.slice(0, 160)}`
        }`;
        lastModel = turn.model ?? undefined;
      }
    }
    const member = MemberSchema.parse({
      name: agent.name,
      role: agent.role,
      cli: agent.cli,
      homeRunner: agent.homeRunner,
      status: agent.status,
      resident: charter.resident,
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(lastModel === undefined ? {} : { lastModel }),
      skills: (await this.listAgentSkills(name)).map((skill) => skill.name),
      memberships: agent.memberships,
      subscriptions: agent.subscriptions,
      claimsHeld,
      tasksDone,
      ...(lastTurnAt === undefined ? {} : { lastTurnAt }),
      ...(lastTurnOutcome === undefined ? {} : { lastTurnOutcome }),
      createdAt: agent.createdAt,
      ...(agent.retiredAt === undefined ? {} : { retiredAt: agent.retiredAt }),
    });
    await writeMarkdown(this.paths.member(name), member, await this.readProfile(name));
  }

  private assertMayReallocate(actor: Actor, target: Name): void {
    if (target !== actor.name && !REALLOCATING_ROLES.includes(actor.role)) {
      throw new BoardError(
        "FORBIDDEN",
        "only the user, the steward, or the concierge may move another citizen",
      );
    }
  }

  private async loadTokenIndex(): Promise<void> {
    this.tokenIndex.clear();
    for (const agent of await this.listAgents()) {
      if (agent.status === "active") {
        this.tokenIndex.set(agent.tokenHash, { name: agent.name, role: agent.role });
      }
    }
  }

  /**
   * Sets the model a citizen's turns run with, or clears it for the CLI's default. It applies from
   * the citizen's next turn; the runner starts a warm session afresh when the model changes.
   */
  async setAgentModel(actor: Actor, name: Name, model: string | null): Promise<Agent> {
    this.assertUser(actor, "only the user may change a citizen's model");
    const chosen = model === null ? null : ModelNameSchema.parse(model);
    return this.mutex.run(async () => {
      const current = await this.readAgent(name);
      if (current.status !== "active" || current.cli === null) {
        throw new BoardError("INVALID_STATE", `${name} takes no turns, so it has no model to set`);
      }
      const { model: previous, ...rest } = current;
      const next = await this.updateAgent(name, () =>
        chosen === null ? rest : { ...rest, model: chosen },
      );
      await this.refreshMember(name);
      await this.events.append("agent.configured", actor.name, {
        agent: name,
        model: chosen,
        previous: previous ?? null,
      });
      return next;
    });
  }

  private async updateAgent(name: Name, mutate: (agent: Agent) => Agent): Promise<Agent> {
    const current = await this.readAgent(name);
    const next = AgentSchema.parse(mutate(current));
    await writeJson(this.paths.agentFile(name), next);
    return next;
  }

  private async updateProject(slug: Name, mutate: (project: Project) => Project): Promise<Project> {
    const doc = await readMarkdown(this.paths.projectFile(slug), ProjectSchema);
    const next = ProjectSchema.parse(mutate(doc.data));
    await writeMarkdown(this.paths.projectFile(slug), next, doc.body);
    return next;
  }

  private assertAdmin(actor: Actor): void {
    if (actor.role !== USER_ROLE && actor.role !== "steward") {
      throw new BoardError("FORBIDDEN", "only the user or the steward may administer the society");
    }
  }

  private assertUser(actor: Actor, message: string): void {
    if (actor.role !== USER_ROLE) {
      throw new BoardError("FORBIDDEN", message);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Provisioning: what an approval executes. Validation never writes; execution assumes it passed.
  // ---------------------------------------------------------------------------------------------

  private async validateProvision(
    kind: ProposalKind,
    charter: Record<string, unknown>,
  ): Promise<void> {
    switch (kind) {
      case "member":
        await this.validateAddAgent(memberToAgentInput(MemberProposalSchema.parse(charter)));
        return;
      case "channel":
        await this.validateAddChannel(ChannelProposalSchema.parse(charter));
        return;
      case "role":
        this.validateRole(RoleCharterSchema.parse(charter));
        return;
      case "retirement":
        await this.validateRetire(RetirementProposalSchema.parse(charter).agent);
        return;
      case "skill":
        SkillProposalSchema.parse(charter);
        return;
      case "reallocation":
        return;
      default:
        return;
    }
  }

  private async executeProvision(
    by: Name,
    proposal: Proposal,
  ): Promise<Record<string, unknown> | undefined> {
    const meta = { proposalId: proposal.id };
    switch (proposal.kind) {
      case "member": {
        const input = memberToAgentInput(MemberProposalSchema.parse(proposal.charter));
        const { agent } = await this.addAgentUnlocked(by, input, meta);
        return {
          agent: agent.name,
          role: agent.role,
          cli: agent.cli,
          memberships: agent.memberships,
        };
      }
      case "channel": {
        const channel = await this.addChannelUnlocked(
          by,
          ChannelProposalSchema.parse(proposal.charter),
          meta,
        );
        return { channel };
      }
      case "role": {
        const { charter, replaced } = await this.writeRoleUnlocked(
          by,
          RoleCharterSchema.parse(proposal.charter),
          meta,
        );
        return { role: charter.name, replaced };
      }
      case "retirement": {
        const input = RetirementProposalSchema.parse(proposal.charter);
        const { agent, releasedTasks } = await this.retireUnlocked(
          by,
          input.agent,
          input.reason,
          meta,
        );
        return { agent: agent.name, releasedTasks };
      }
      case "skill": {
        const skill = SkillProposalSchema.parse(proposal.charter);
        const replaced = await this.promoteSkillUnlocked(by, proposal.proposedBy, skill, meta);
        return { skill: skill.name, replaced };
      }
      case "reallocation":
        return undefined;
      default:
        return undefined;
    }
  }

  /** Writes a promoted skill under the society's skills, where every citizen's skills index lists it. */
  private async promoteSkillUnlocked(
    by: Name,
    proposedBy: Name,
    skill: SkillProposal,
    meta: Record<string, unknown>,
  ): Promise<boolean> {
    const file = this.paths.societySkillFile(skill.name);
    const replaced = await exists(file);
    await ensureDir(this.paths.societySkill(skill.name));
    // The SKILL.md frontmatter the CLIs' validators accept: name, description, and a metadata map.
    await writeMarkdown(
      file,
      {
        name: skill.name,
        description: skill.summary,
        metadata: { proposedBy, promotedBy: by, promotedAt: this.now().toISOString() },
      },
      skill.body,
    );
    await this.events.append("skill.promoted", by, {
      name: skill.name,
      summary: skill.summary,
      proposedBy,
      replaced,
      ...meta,
    });
    await this.appendMessage(
      by,
      "general",
      `Skill ${skill.name} ${replaced ? "updated in" : "promoted to"} the society: ${sentence(skill.summary)}. Every citizen's skills index now lists it.`,
    );
    return replaced;
  }

  private async validateAddAgent(input: AddAgentInput): Promise<void> {
    if (await exists(this.paths.agentFile(input.name))) {
      throw new BoardError("ALREADY_EXISTS", `agent ${input.name} already exists`);
    }
    await this.readRole(input.role);
    await this.readRunner(input.homeRunner ?? SERVER_RUNNER);
    for (const slug of input.memberships ?? []) {
      await this.readProject(slug);
    }
    for (const ref of input.subscriptions ?? []) {
      await this.assertChannelExists(ref);
    }
  }

  private async addAgentUnlocked(
    by: Name,
    input: AddAgentInput,
    meta: Record<string, unknown>,
  ): Promise<{ agent: Agent; token: string }> {
    const charter = await this.readRole(input.role);
    const memberships = [...(input.memberships ?? [])];
    const defaultSubscriptions: ChannelRef[] = [
      "general",
      ...memberships.map((slug) => channelRef(slug, "general")),
      ...(charter.wakeTriggers.includes(OPS_WAKE_TRIGGER) ? OPS_CHANNELS : []),
    ];
    const subscriptions = [...new Set([...defaultSubscriptions, ...(input.subscriptions ?? [])])];
    const token = mintToken();
    const agent: Agent = AgentSchema.parse({
      name: input.name,
      role: input.role,
      cli: input.cli,
      ...(input.model === undefined ? {} : { model: input.model }),
      homeRunner: input.homeRunner ?? SERVER_RUNNER,
      memberships,
      subscriptions,
      status: "active",
      createdAt: this.now().toISOString(),
      tokenHash: hashToken(token),
    });
    await this.writeAgentHome(agent, charter, input.seedInstructions);
    for (const slug of memberships) {
      await this.updateProject(slug, (project) => ({
        ...project,
        members: [...new Set([...project.members, agent.name])],
      }));
    }
    await this.events.append("agent.added", by, {
      name: agent.name,
      role: agent.role,
      cli: agent.cli,
      memberships,
      ...meta,
    });
    return { agent, token };
  }

  private async validateAddChannel(input: AddChannelInput): Promise<void> {
    if (input.project === null) {
      if ((await this.society()).channels.includes(input.name)) {
        throw new BoardError("ALREADY_EXISTS", `society channel ${input.name} already exists`);
      }
      return;
    }
    const project = await this.readProject(input.project);
    if (project.channels.includes(input.name)) {
      throw new BoardError(
        "ALREADY_EXISTS",
        `channel ${channelRef(input.project, input.name)} already exists`,
      );
    }
  }

  private async addChannelUnlocked(
    by: Name,
    input: AddChannelInput,
    meta: Record<string, unknown>,
  ): Promise<ChannelRef> {
    const ref = channelRef(input.project, input.name);
    if (input.project === null) {
      const doc = await readMarkdown(this.paths.societyFile(), SocietySchema);
      await writeMarkdown(
        this.paths.societyFile(),
        { ...doc.data, channels: [...doc.data.channels, input.name] },
        doc.body,
      );
      await ensureDir(this.paths.societyChannel(input.name));
    } else {
      const project = input.project;
      await this.updateProject(project, (current) => ({
        ...current,
        channels: [...current.channels, input.name],
      }));
      await ensureDir(this.paths.projectChannel(project, input.name));
    }
    await this.events.append("channel.added", by, {
      channel: ref,
      purpose: input.purpose,
      ...meta,
    });
    await this.appendMessage(by, ref, `Channel ${ref} opened: ${input.purpose}`);
    return ref;
  }

  private validateRole(charter: RoleCharter): void {
    if (charter.name === USER_ROLE) {
      throw new BoardError("FORBIDDEN", "the user charter is not subject to proposals");
    }
  }

  private async writeRoleUnlocked(
    by: Name,
    charter: RoleCharter,
    meta: Record<string, unknown>,
  ): Promise<{ charter: RoleCharter; replaced: boolean }> {
    const file = this.paths.role(charter.name);
    const replaced = await exists(file);
    await writeMarkdown(file, charter, `# ${charter.name}\n\n${charter.purpose}\n`);
    this.roleCache.set(charter.name, charter);
    await this.events.append("role.added", by, {
      name: charter.name,
      replaced,
      verbs: charter.verbs,
      maxReplicas: charter.maxReplicas,
      backlogThreshold: charter.backlogThreshold,
      ...meta,
    });
    if (replaced) {
      await this.refreshAgentRoles(charter);
    }
    return { charter, replaced };
  }

  private async validateRetire(name: Name): Promise<void> {
    const agent = await this.readAgent(name);
    if (agent.role === USER_ROLE) {
      throw new BoardError("FORBIDDEN", "the user cannot be retired");
    }
    if (agent.status === "retired") {
      throw new BoardError("INVALID_STATE", `${name} is already retired`);
    }
  }

  private async retireUnlocked(
    by: Name,
    name: Name,
    reason: string,
    meta: Record<string, unknown>,
  ): Promise<{ agent: Agent; releasedTasks: Ulid[] }> {
    const current = await this.readAgent(name);
    const ts = this.now().toISOString();
    const releasedTasks: Ulid[] = [];
    for (const task of await this.heldClaims(name)) {
      await this.writeTask(task.project, {
        ...task,
        status: "open",
        claimedBy: undefined,
        leaseExpiresAt: undefined,
        stageSince: ts,
        updatedAt: ts,
      });
      await this.events.append("task.released", by, {
        taskId: task.id,
        project: task.project,
        releasedFrom: name,
        reason: "retired",
      });
      releasedTasks.push(task.id);
    }
    const agent = await this.updateAgent(name, (a) => ({
      ...a,
      status: "retired",
      retiredAt: ts,
      retiredReason: reason,
    }));
    for (const slug of agent.memberships) {
      await this.updateProject(slug, (project) => ({
        ...project,
        members: project.members.filter((member) => member !== name),
      }));
      const sessions = path.join(this.paths.agentProject(name, slug), "sessions.json");
      if (await exists(sessions)) {
        const archived = `sessions.archived.${ts.replace(/[:.]/g, "-")}.json`;
        await rename(sessions, path.join(this.paths.agentProject(name, slug), archived));
      }
    }
    this.tokenIndex.delete(current.tokenHash);
    await this.refreshMember(name);
    await this.events.append("agent.retired", by, {
      name,
      role: agent.role,
      reason,
      releasedTasks,
      ...meta,
    });
    const released =
      releasedTasks.length === 0
        ? ""
        : ` Released ${releasedTasks.length} claimed task(s) back to open.`;
    await this.appendMessage(
      by,
      "general",
      `Retired ${name} (${agent.role}): ${reason}.${released}`,
    );
    return { agent, releasedTasks };
  }

  /** Writes one message and its event. Callers hold the mutex and have authorized the author. */
  private async appendMessage(author: Name, channel: ChannelRef, body: string): Promise<Message> {
    await this.assertChannelExists(channel);
    return this.writeMessage(this.paths.channelDir(channel), { author, channel }, body);
  }

  /** A thread's message carries the thread's channel; a caller naming another channel is refused. */
  private async appendThreadMessage(
    author: Name,
    threadId: Ulid,
    body: string,
    channel?: ChannelRef,
  ): Promise<Message> {
    const { thread, threads } = await this.findThread(threadId);
    if (thread.state !== "open") {
      throw new BoardError("INVALID_STATE", `thread ${threadId} is closed`);
    }
    if (channel !== undefined && channel !== thread.channel) {
      throw new BoardError(
        "VALIDATION",
        `thread ${threadId} belongs to ${thread.channel}; leave channel out or pass that one`,
      );
    }
    return this.writeMessage(
      this.paths.threadMessages(threads, threadId),
      { author, channel: thread.channel, thread: threadId },
      body,
    );
  }

  private async writeMessage(
    dir: string,
    head: { author: Name; channel: ChannelRef; thread?: Ulid; closes?: Ulid },
    body: string,
  ): Promise<Message> {
    const frontmatter: MessageFrontmatter = MessageFrontmatterSchema.parse({
      id: this.newId(),
      ...head,
      ts: this.now().toISOString(),
      mentions: extractMentions(body),
    });
    const { author } = head;
    await writeMarkdown(this.paths.messageFile(dir, frontmatter.id, author), frontmatter, body);
    await this.events.append("message.posted", author, {
      id: frontmatter.id,
      channel: frontmatter.channel,
      thread: frontmatter.thread ?? null,
      mentions: frontmatter.mentions,
    });
    return { ...frontmatter, body };
  }

  private async publishSignalUnlocked(signal: OpsSignal): Promise<BoardEvent> {
    const parsed = OpsSignalSchema.parse(signal);
    const meta = Object.entries(parsed)
      .filter(([key]) => key !== "summary")
      .map(([key, value]) => `${key}=${plain(value)}`)
      .join(" ");
    await this.appendMessage(
      SYSTEM_ACTOR.name,
      "ops",
      `**${parsed.kind}** ${parsed.summary}\n\n\`${meta}\``,
    );
    return this.events.append("ops.signal", SYSTEM_ACTOR.name, parsed);
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

  private assertInPlay(task: Task): void {
    if (task.status === "done" || task.status === "abandoned") {
      throw new BoardError("INVALID_TRANSITION", `task ${task.id} is ${task.status}`);
    }
    if (task.completing) {
      throw new BoardError("INVALID_STATE", `task ${task.id} is completing`);
    }
  }

  private assertMayGate(actor: Actor, what: string): void {
    if (!PLANNING_ROLES.includes(actor.role)) {
      throw new BoardError(
        "FORBIDDEN",
        `only the user, the steward, and the concierge may ${what}; ask one of them in the task's thread`,
      );
    }
  }

  /** The user holds anything; everyone else must be a project member the current stage admits. */
  private async assertMayHold(actor: Actor, task: Task): Promise<void> {
    if (actor.role === USER_ROLE) {
      return;
    }
    const agent = await this.readAgent(actor.name);
    if (!agent.memberships.includes(task.project)) {
      throw new BoardError(
        "FORBIDDEN",
        `${actor.name} is not a member of ${task.project}; join it first`,
      );
    }
    if (mayHoldStage(actor, task)) {
      return;
    }
    const stage = currentStage(task);
    const which = stage === undefined ? task.stage : `stage ${stage.id} "${stage.name}"`;
    const why =
      stage?.agent !== undefined && stage.agent !== actor.name
        ? `is assigned to ${stage.agent}`
        : stage?.role !== undefined && stage.role !== actor.role
          ? `is for the ${stage.role} role`
          : "is gated: nobody who held an earlier stage may hold it";
    throw new BoardError("FORBIDDEN", `${which} ${why}`);
  }

  /** A stage may name any role, so a missing one surfaces as a role gap; a named citizen must exist. */
  private async validateAssignees(stages: readonly { agent?: Name | undefined }[]): Promise<void> {
    for (const stage of stages) {
      if (stage.agent === undefined) {
        continue;
      }
      const agent = await this.readAgent(stage.agent);
      if (agent.status !== "active") {
        throw new BoardError("INVALID_STATE", `${stage.agent} is retired`);
      }
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

  /** Writes a task that has just ended, done or abandoned; its thread, if open, closes with it. */
  private async writeEndedTask(by: Name, project: Name, task: Task): Promise<Task> {
    const written = await this.writeTask(project, task);
    await this.endThreadOf(task.id, by, task.status);
    return written;
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

  /**
   * Records a decision and, on approval, provisions what the proposal asked for in the same
   * transaction: the member exists, the channel is open, the charter is written, the agent is
   * retired. Validation runs before any write, so an impossible provision fails the decision.
   */
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
      const approvers = ROLE_KIND_APPROVERS[proposal.kind];
      if (!approvers.includes(actor.role)) {
        throw new BoardError(
          "FORBIDDEN",
          `a ${proposal.kind} proposal requires one of: ${approvers.join(", ")}`,
        );
      }
      if (outcome === "approved") {
        await this.validateProvision(proposal.kind, proposal.charter);
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
      const provision =
        outcome === "approved" ? await this.executeProvision(actor.name, proposal) : undefined;
      const status: ProposalStatus =
        outcome === "rejected" ? "rejected" : provision === undefined ? "approved" : "provisioned";
      await this.writeProposal({
        ...proposal,
        status,
        decidedBy: actor.name,
        decidedAt: ts,
        ...(reason === undefined ? {} : { reason }),
        ...(provision === undefined ? {} : { provisionedAt: ts, provision }),
      });
      await this.events.append("proposal.decided", actor.name, {
        proposalId,
        outcome,
        kind: proposal.kind,
      });
      if (provision !== undefined) {
        await this.events.append("proposal.provisioned", actor.name, {
          proposalId,
          kind: proposal.kind,
          ...provision,
        });
      }
      const verdict = outcome === "approved" ? "Approved" : "Rejected";
      const why = reason === undefined ? "" : ` Reason: ${reason}.`;
      const result =
        provision === undefined
          ? ""
          : ` Provisioned: ${Object.entries(provision)
              .map(([key, value]) => `${key} ${plain(value)}`)
              .join(", ")}.`;
      await this.appendMessage(
        actor.name,
        "decisions",
        `${verdict} ${proposal.kind} proposal ${proposalId} by ${proposal.proposedBy}: ${describeCharter(proposal.kind, proposal.charter)}.${why}${result}`,
      );
      await this.endThreadOf(proposalId, actor.name, outcome);
      return decision;
    });
  }

  /** The opener, the people of its subject, and anyone who posted in it; mentions reach the rest. */
  private async participatesInThread(
    actor: Actor,
    thread: Thread,
    threads: string,
  ): Promise<boolean> {
    if (thread.openedBy === actor.name || (await this.involvedIn(actor, thread.subject))) {
      return true;
    }
    const files = await listFiles(this.paths.threadMessages(threads, thread.id));
    return files.some((file) => file.endsWith(`-${actor.name}.md`));
  }

  /**
   * A task's creator, holder, and everyone named on or holding a stage; a proposal's proposer,
   * its decider, and the roles that may decide it.
   */
  private async involvedIn(actor: Actor, subject: ThreadSubject | undefined): Promise<boolean> {
    try {
      if (subject?.kind === "task") {
        const { task } = await this.findTask(subject.id);
        return (
          task.claimedBy === actor.name ||
          task.createdBy === actor.name ||
          task.stages.some(
            (stage) => stage.agent === actor.name || stage.holders.includes(actor.name),
          )
        );
      }
      if (subject?.kind === "proposal") {
        const proposal = await this.readProposal(subject.id);
        return (
          proposal.proposedBy === actor.name ||
          proposal.decidedBy === actor.name ||
          ROLE_KIND_APPROVERS[proposal.kind].includes(actor.role)
        );
      }
    } catch {
      return false;
    }
    return false;
  }

  private async threadScopes(): Promise<string[]> {
    const projects = await listDirs(this.paths.projects());
    return [this.paths.societyThreads(), ...projects.map((slug) => this.paths.threads(slug))];
  }

  private async tryFindThread(id: Ulid): Promise<{ thread: Thread; threads: string } | null> {
    for (const threads of await this.threadScopes()) {
      const file = this.paths.threadFile(threads, id);
      if (await exists(file)) {
        const doc = await readMarkdown(file, ThreadFrontmatterSchema);
        return { thread: { ...doc.data, body: doc.body }, threads };
      }
    }
    return null;
  }

  private async findThread(id: Ulid): Promise<{ thread: Thread; threads: string }> {
    const found = await this.tryFindThread(id);
    if (found === null) {
      throw new BoardError("NOT_FOUND", `thread ${id} not found`);
    }
    return found;
  }

  private async writeThread(threads: string, thread: Thread): Promise<Thread> {
    const { body, ...frontmatter } = thread;
    const clean = Object.fromEntries(
      Object.entries(frontmatter).filter(([, value]) => value !== undefined),
    );
    const data = ThreadFrontmatterSchema.parse(clean);
    await writeMarkdown(this.paths.threadFile(threads, thread.id), data, body);
    return { ...data, body };
  }

  /** A thread with a subject closes, without a summary, when its subject ends. */
  private async endThreadOf(subjectId: Ulid, by: Name, ended: string): Promise<void> {
    const found = await this.tryFindThread(subjectId);
    if (found === null || found.thread.state !== "open") {
      return;
    }
    await this.writeThread(found.threads, {
      ...found.thread,
      state: "closed",
      closedBy: by,
      closedAt: this.now().toISOString(),
    });
    await this.events.append("thread.closed", by, {
      threadId: subjectId,
      channel: found.thread.channel,
      ended,
    });
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
      yield* this.threadMessagesIn(this.paths.societyThreads(), since);
    }
    const projects = project === undefined ? await listDirs(this.paths.projects()) : [project];
    for (const slug of projects) {
      for (const channel of await listDirs(this.paths.projectChannels(slug))) {
        yield* await this.readMessagesIn(this.paths.projectChannel(slug, channel), since);
      }
      yield* this.threadMessagesIn(this.paths.threads(slug), since);
    }
  }

  private async *threadMessagesIn(threads: string, since: Ulid | null): AsyncGenerator<Message> {
    for (const id of await listDirs(threads)) {
      yield* await this.readMessagesIn(this.paths.threadMessages(threads, id), since);
    }
  }
}
