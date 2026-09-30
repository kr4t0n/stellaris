import { writeFile } from "node:fs/promises";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { SYSTEM_ACTOR, type Actor, type Board } from "@stellaris/board-core";
import {
  mayHoldStage,
  sessionKey,
  USER_NAME,
  SOCIETY_SCOPE,
  turnStatusJsonSchema,
  wakeScope,
  type AgentEvent,
  type CliKind,
  type Message,
  type Name,
  type Task,
  type Thread,
  type TurnDispatch,
  type TranscriptEntry,
  type TurnRecord,
  type Ulid,
} from "@stellaris/shared";
import { ExecaGit, taskBranch, type GitOps } from "./git.js";
import {
  buildTurnPrompt,
  type Conversation,
  type KnowledgeView,
  type SocietyView,
} from "./prompt.js";
import {
  renderClaudeMcpConfig,
  renderCodexMcpConfig,
  renderInstructions,
  type OnboardingContext,
} from "./render.js";
import {
  ZERO_USAGE,
  type AgentBackend,
  type AgentSpec,
  type ResidentSession,
  type TurnResult,
} from "./types.js";

export interface RunnerLog {
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface LocalRunnerOptions {
  readonly board: Board;
  readonly backends: Partial<Record<CliKind, AgentBackend>>;
  /** Where agents reach the board's MCP endpoint, for example http://127.0.0.1:4700/mcp */
  readonly mcpUrl: string;
  readonly runnerName: Name;
  /** How long a turn may run, or null for no limit. */
  readonly turnTimeoutMs?: number | null | undefined;
  /** Rounds of tool calls a turn may take, or null for no limit. */
  readonly maxTurns?: number | null | undefined;
  /** How long a resident session stays warm after its last turn before the runner lets it go cold. */
  readonly residentIdleMs?: number | undefined;
  readonly git?: GitOps | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: RunnerLog | undefined;
  /** Every event a turn's adapter emits, with the turn's scope and, in a thread, its thread. */
  readonly onEvent?: TurnEventListener | undefined;
}

export type TurnEventListener = (
  agent: Name,
  project: Name,
  event: AgentEvent,
  thread?: Ulid,
) => void;

/** Where a turn runs: the clone, the worktree, and the branch to hand the worktree back to, or null to detach. */
interface Workspace {
  readonly repoDir: string;
  readonly worktree: string;
  readonly branch: string | null;
}

const SILENT: RunnerLog = { info() {}, warn() {}, error() {} };
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
/** A running turn renews the leases it holds this often, so one longer than a lease keeps its claims. */
const LEASE_RENEW_MS = 10 * 60_000;
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_RESIDENT_IDLE_MS = 10 * 60_000;
const USER_POST_TRIGGER = "user_post";
const OPS_TRIGGER = "ops_event";
/** How many signals a reader's prompt lists at most, newest kept. */
const MAX_SIGNALS = 30;

interface Resident {
  readonly session: ResidentSession;
  readonly token: string;
  /** The model the session started with; a citizen given another model gets a fresh session. */
  readonly model: string | undefined;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The embedded runner: ensures the worktree, renders the config home, builds the prompt,
 * runs the turn through the CLI's adapter, then records the outcome on the board.
 * Resident roles keep a warm session between turns; the society scope runs a turn in the
 * agent's home, outside any project.
 */
export class LocalRunner {
  private readonly board: Board;
  private readonly backends: Partial<Record<CliKind, AgentBackend>>;
  private readonly mcpUrl: string;
  private readonly runnerName: Name;
  private readonly turnTimeoutMs: number | null;
  private readonly maxTurns: number | null;
  private readonly residentIdleMs: number;
  private readonly git: GitOps;
  private readonly now: () => Date;
  private readonly log: RunnerLog;
  private readonly onEvent: TurnEventListener | undefined;
  private readonly prepareLocks = new Map<Name, Promise<void>>();
  private readonly residents = new Map<string, Resident>();

  constructor(options: LocalRunnerOptions) {
    this.board = options.board;
    this.backends = options.backends;
    this.mcpUrl = options.mcpUrl;
    this.runnerName = options.runnerName;
    this.turnTimeoutMs =
      options.turnTimeoutMs === undefined ? DEFAULT_TURN_TIMEOUT_MS : options.turnTimeoutMs;
    this.maxTurns = options.maxTurns === undefined ? DEFAULT_MAX_TURNS : options.maxTurns;
    this.residentIdleMs = options.residentIdleMs ?? DEFAULT_RESIDENT_IDLE_MS;
    this.git = options.git ?? new ExecaGit();
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? SILENT;
    this.onEvent = options.onEvent;
  }

  /** Home conversations with a warm session right now, as `agent/scope`. */
  get residentPairs(): string[] {
    return [...this.residents.keys()].toSorted();
  }

  /**
   * Clones the project once and adds the worktree a turn runs in: the pair's own for its home
   * conversation and its proposal and topic threads, or, for a task's conversation, one of its own
   * on the task's branch. Idempotent.
   */
  async prepare(agent: Name, project: Name, taskId?: Ulid): Promise<Workspace> {
    // Two first turns on one project must not both initialize its repository: serialize per project.
    const previous = this.prepareLocks.get(project) ?? Promise.resolve();
    const run = previous.then(
      () => this.prepareUnlocked(agent, project, taskId),
      () => this.prepareUnlocked(agent, project, taskId),
    );
    this.prepareLocks.set(
      project,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async prepareUnlocked(
    agent: Name,
    project: Name,
    taskId: Ulid | undefined,
  ): Promise<Workspace> {
    const record = await this.board.readProject(project);
    const repoDir = await this.git.ensureRepo(record, this.board.paths.repo(project));
    if (taskId !== undefined) {
      const branch = taskBranch(taskId);
      await this.git.ensureBranch(repoDir, branch, record.defaultBranch);
      const worktree = await this.git.ensureTaskWorktree(
        repoDir,
        this.board.paths.taskWorktree(agent, taskId),
        branch,
      );
      return { repoDir, worktree, branch: null };
    }
    const branch = `agent/${agent}`;
    const worktree = await this.git.ensureWorktree(
      repoDir,
      this.board.paths.worktree(agent, project),
      branch,
      record.defaultBranch,
    );
    return { repoDir, worktree, branch };
  }

  async runTurn(dispatch: TurnDispatch): Promise<TurnRecord> {
    const agent = await this.board.readAgent(dispatch.agent);
    const actor: Actor = { name: agent.name, role: agent.role };
    const startedAt = this.now().toISOString();
    const thread = dispatch.thread;
    const base: TurnRecord = {
      agent: agent.name,
      project: dispatch.project,
      ...(thread === undefined ? {} : { thread: thread.id }),
      runner: this.runnerName,
      cli: agent.cli,
      session: null,
      trigger: dispatch.trigger,
      startedAt,
      endedAt: null,
      exitReason: null,
      status: null,
      error: null,
      usage: null,
      costUsd: 0,
      toolCalls: 0,
      model: agent.model ?? null,
    };

    if (agent.status === "retired") {
      return this.fail(base, `${agent.name} is retired`);
    }
    if (agent.cli === null) {
      return this.fail(base, `${agent.name} has no CLI binding`);
    }
    const backend = this.backends[agent.cli];
    if (backend === undefined) {
      return this.fail(base, `no backend registered for ${agent.cli}`);
    }
    const charter = await this.board.readRole(agent.role);
    const societyScope = dispatch.project === SOCIETY_SCOPE;
    if (societyScope && !charter.societyScope) {
      return this.fail(base, `${agent.role} cannot take society-scope turns`);
    }

    // The society scope has no repository: the agent's home is its working directory.
    const home = this.board.paths.agent(agent.name);
    const taskId = thread?.task === true ? thread.id : undefined;
    const workspace = societyScope
      ? null
      : await this.prepare(agent.name, dispatch.project, taskId);
    const worktree = workspace?.worktree ?? home;
    const repoDir = workspace?.repoDir ?? home;
    const project = societyScope ? null : await this.board.readProject(dispatch.project);
    if (project !== null) {
      // Every task in play gets its branch before the turn, so a holder only has to switch to it.
      for (const task of await this.board.listTasks(project.slug)) {
        if (task.status === "open" || task.status === "claimed") {
          await this.git.ensureBranch(repoDir, taskBranch(task.id), project.defaultBranch);
        }
      }
    }
    const sessions = await this.board.readSessions(agent.name, dispatch.project, thread?.id);
    const spec: AgentSpec = {
      agent: agent.name,
      project: dispatch.project,
      cli: agent.cli,
      runner: this.runnerName,
      cwd: worktree,
      repoDir,
      configHome: home,
      boardDir: this.board.paths.board,
      ...(agent.model === undefined ? {} : { model: agent.model }),
    };
    let session = sessions[agent.cli];
    const newSession = session === undefined;
    if (session === undefined) {
      session = await backend.newSession(spec);
      // Written before the turn runs so a crash cannot lose the id.
      await this.board.writeSession(agent.name, dispatch.project, agent.cli, session, thread?.id);
    }

    const lastTurn = await this.board.readLastTurn(agent.name, dispatch.project, thread?.id);
    // A resumed session reports a running total that includes its earlier turns. Records from
    // before `sessionCostUsd` held that total as the turn's cost.
    const costSoFarUsd =
      !newSession && lastTurn?.session === session
        ? (lastTurn.sessionCostUsd ?? lastTurn.costUsd)
        : 0;
    // The digest of this turn's conversation only: a citizen's turns in its other conversations
    // may run at the same time, and each reads and acts on its own. A new thread conversation
    // is shown the whole thread, since nothing of it is in the session yet.
    const digest = await this.board.readDigest(
      { ...actor, scope: dispatch.project, ...(thread === undefined ? {} : { thread: thread.id }) },
      { advance: false, limit: thread === undefined ? 50 : 100 },
    );
    const threadSoFar =
      thread !== undefined && newSession
        ? (await this.board.listThread(thread.id).catch(() => [] as Message[])).slice(-100)
        : null;
    const messages = threadSoFar ?? digest.messages;
    const cursorAfter = threadSoFar?.at(-1)?.id ?? digest.cursor;
    const task: Task | null =
      taskId === undefined
        ? null
        : await this.board
            .findTask(taskId)
            .then((found) => found.task)
            .catch(() => null);
    // Stages are a task conversation's business: its own task's, and nothing in other conversations.
    const held =
      task === null
        ? []
        : (await this.board.heldClaims(agent.name)).filter((each) => each.id === task.id);
    const roleCharter = await this.board.readAgentRoleBody(agent.name);
    const memoryCore = await this.board.readMemoryCore(agent.name);
    const onboarding: OnboardingContext | null =
      dispatch.onboarding || (newSession && thread === undefined)
        ? {
            agentName: agent.name,
            roleSummary: charter.purpose,
            project: dispatch.project,
            worktree,
          }
        : null;
    const instructions = renderInstructions({
      agentName: agent.name,
      roleCharter,
      memoryCore,
      homeDir: spec.configHome,
      boardDir: spec.boardDir,
      norms: await this.board.readSocietyNorms(),
      skills: [
        ...(await this.board.listAgentSkills(agent.name)),
        ...(await this.board.listSocietySkills()),
      ],
      ...(onboarding === null ? {} : { onboarding }),
    });
    await this.renderConfigHome(agent.name, instructions);
    // Roles that route for the user get the roster and the projects still taking work in every digest.
    const societyView: SocietyView | null = charter.wakeTriggers.includes(USER_POST_TRIGGER)
      ? {
          projects: (await this.board.listProjects()).filter((each) => each.archived === undefined),
          members: await this.board.listMembers(),
        }
      : null;
    const knowledge: KnowledgeView = societyScope
      ? { dir: this.board.paths.societyKnowledge(), topics: await this.board.listKnowledge(null) }
      : {
          dir: this.board.paths.projectKnowledge(dispatch.project),
          topics: await this.board.listKnowledge(dispatch.project),
        };
    // Readers of operations signals get those logged for this scope since their last home turn here.
    const signals =
      thread === undefined && charter.wakeTriggers.includes(OPS_TRIGGER)
        ? (await this.board.listSignals(500))
            .filter(
              (record) =>
                wakeScope(agent, charter, record.signal.project ?? null) === dispatch.project &&
                (lastTurn === null || record.ts > lastTurn.startedAt),
            )
            .slice(-MAX_SIGNALS)
        : null;
    const waiting =
      task !== null && task.status === "open" && !task.completing && mayHoldStage(actor, task)
        ? [task]
        : [];
    const threads = new Map<Ulid, Thread>();
    for (const id of new Set(messages.flatMap((message) => message.thread ?? []))) {
      const record = await this.board.readThread(id).catch(() => undefined);
      if (record !== undefined) {
        threads.set(id, record);
      }
    }
    const threadRecord =
      thread === undefined
        ? undefined
        : (threads.get(thread.id) ??
          (await this.board.readThread(thread.id).catch(() => undefined)));
    const conversation: Conversation | null =
      threadRecord === undefined
        ? null
        : { thread: threadRecord, task, fresh: threadSoFar !== null };
    const prompt = buildTurnPrompt({
      dispatch,
      messages,
      threads,
      conversation,
      heldClaims: held,
      waitingStages: waiting,
      project,
      lastTurn,
      onboarding,
      societyView,
      knowledge,
      signals,
    });
    const env = {
      GIT_AUTHOR_NAME: agent.name,
      GIT_AUTHOR_EMAIL: `${agent.name}@stellaris.local`,
      GIT_COMMITTER_NAME: agent.name,
      GIT_COMMITTER_EMAIL: `${agent.name}@stellaris.local`,
    };
    const limits = { timeoutMs: this.turnTimeoutMs, maxTurns: this.maxTurns };
    const statusSchema = turnStatusJsonSchema();

    const record = await this.board.beginTurn({ ...base, session, sessionCostUsd: costSoFarUsd });
    // Residency keeps a role's home conversation warm; its thread conversations run cold.
    const resident =
      charter.resident && backend.startResident !== undefined && thread === undefined;
    this.log.info(
      {
        agent: agent.name,
        project: dispatch.project,
        thread: thread?.id,
        session,
        newSession,
        resident,
      },
      "turn starting",
    );

    const events: AgentEvent[] = [];
    const transcript: TranscriptEntry[] = [];
    const onEvent = (event: AgentEvent): void => {
      events.push(event);
      transcript.push({ ts: this.now().toISOString(), event });
      this.onEvent?.(agent.name, dispatch.project, event, thread?.id);
    };
    const keepLeases = setInterval(() => {
      void this.board
        .heldClaims(agent.name)
        .then((claims) =>
          this.renewLeases(
            actor,
            claims.filter((each) => each.project === dispatch.project).map((each) => each.id),
          ),
        )
        .catch(() => undefined);
    }, LEASE_RENEW_MS);
    keepLeases.unref?.();
    let result: TurnResult;
    try {
      if (resident && backend.startResident !== undefined) {
        result = await this.runResidentTurn(backend, spec, {
          key: sessionKey(agent.name, dispatch.project),
          scope: dispatch.project,
          agent: { name: agent.name, role: agent.role },
          session,
          newSession,
          instructions,
          prompt,
          limits,
          statusSchema,
          env,
          costSoFarUsd,
          onEvent,
        });
      } else {
        const token = this.board.issueTurnToken(
          agent.name,
          agent.role,
          this.tokenLifetime(5 * 60_000),
          dispatch.project,
          thread?.id,
        );
        try {
          result = await backend.runTurn(
            {
              spec,
              session,
              newSession,
              prompt,
              instructions,
              mcp: { url: this.mcpUrl, token },
              limits,
              statusSchema,
              env,
              costSoFarUsd,
            },
            onEvent,
          );
        } finally {
          this.board.revokeTurnToken(token);
        }
      }
    } catch (error) {
      result = {
        events,
        finalText: "",
        usage: ZERO_USAGE,
        costUsd: 0,
        status: null,
        exitReason: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearInterval(keepLeases);
    }

    if (workspace !== null) {
      await this.handBack(agent.name, workspace.worktree, workspace.branch);
      if (taskId !== undefined) {
        await this.dropEndedTaskWorktree(taskId, workspace);
      }
    }

    // CLIs that assign their own session ids report the real one after the first turn.
    if (result.session !== undefined && result.session !== session) {
      await this.board.writeSession(
        agent.name,
        dispatch.project,
        agent.cli,
        result.session,
        thread?.id,
      );
      session = result.session;
    }

    const finished: TurnRecord = {
      ...record,
      session,
      endedAt: this.now().toISOString(),
      exitReason: result.exitReason,
      status: result.status,
      error: result.error ?? null,
      usage: result.usage,
      costUsd: result.costUsd,
      sessionCostUsd: result.sessionCostUsd ?? costSoFarUsd,
      toolCalls: result.events.filter((event) => event.type === "tool_call").length,
      model: result.model ?? agent.model ?? null,
    };

    if (result.exitReason === "completed" || result.exitReason === "blocked") {
      // The digest was delivered; only now does the cursor move past it.
      await this.board.setDigestCursor(agent.name, dispatch.project, cursorAfter, thread?.id);
      await this.renewLeases(
        actor,
        held.map((each) => each.id),
      );
      if (result.status?.needsUserDecision === true) {
        await this.askUser(actor, dispatch.project, thread?.id, startedAt, result.status.summary);
      }
    }
    await this.board.finishTurn(finished, transcript);
    this.log.info(
      {
        agent: agent.name,
        project: dispatch.project,
        thread: thread?.id,
        exitReason: finished.exitReason,
      },
      "turn finished",
    );
    return finished;
  }

  /**
   * One turn on a warm session: start it on first use, extend its token, run the prompt, then
   * either keep it warm until the idle timeout or recycle it when its instructions went stale.
   */
  private async runResidentTurn(
    backend: AgentBackend,
    spec: AgentSpec,
    input: {
      key: string;
      /** The pair's scope, which its turn token carries. */
      scope: Name;
      agent: { name: Name; role: Name };
      session: string;
      newSession: boolean;
      instructions: string;
      prompt: string;
      limits: { timeoutMs: number | null; maxTurns: number | null };
      statusSchema: Record<string, unknown>;
      env: Readonly<Record<string, string>>;
      costSoFarUsd: number;
      onEvent: (event: AgentEvent) => void;
    },
  ): Promise<TurnResult> {
    if (backend.startResident === undefined) {
      throw new Error("backend cannot host resident sessions");
    }
    const ttl = this.tokenLifetime(this.residentIdleMs + 60_000);
    const warm = this.residents.get(input.key);
    if (warm !== undefined && warm.model !== spec.model) {
      await this.closeResident(input.key, "model changed");
    }
    let resident = this.residents.get(input.key);
    if (resident === undefined) {
      const token = this.board.issueTurnToken(input.agent.name, input.agent.role, ttl, input.scope);
      const session = await backend.startResident(spec, {
        session: input.session,
        newSession: input.newSession,
        instructions: input.instructions,
        mcp: { url: this.mcpUrl, token },
        limits: input.limits,
        statusSchema: input.statusSchema,
        env: input.env,
        costSoFarUsd: input.costSoFarUsd,
      });
      resident = { session, token, model: spec.model, timer: null };
      this.residents.set(input.key, resident);
      this.log.info({ pair: input.key, session: session.session }, "resident session started");
    } else {
      this.board.extendTurnToken(resident.token, ttl);
    }
    if (resident.timer !== null) {
      clearTimeout(resident.timer);
      resident.timer = null;
    }
    const result = await resident.session.runTurn(input.prompt, input.onEvent);
    const stale = result.status?.memoryUpdated === true || result.exitReason !== "completed";
    if (stale) {
      // The instructions carry the memory core; a changed memory or a broken turn means a fresh start next time.
      await this.closeResident(input.key, "instructions changed or turn failed");
    } else {
      const active = resident;
      active.timer = setTimeout(() => {
        void this.closeResident(input.key, "idle");
      }, this.residentIdleMs);
      active.timer.unref?.();
    }
    return { ...result, session: resident.session.session };
  }

  private async closeResident(key: string, reason: string): Promise<void> {
    const resident = this.residents.get(key);
    if (resident === undefined) {
      return;
    }
    this.residents.delete(key);
    if (resident.timer !== null) {
      clearTimeout(resident.timer);
    }
    this.board.revokeTurnToken(resident.token);
    try {
      await resident.session.close();
    } catch (error) {
      this.log.warn({ pair: key, error: String(error) }, "resident session did not close cleanly");
    }
    this.log.info({ pair: key, reason }, "resident session closed");
  }

  /** Lets every warm session go: called on shutdown. */
  async close(): Promise<void> {
    await Promise.all([...this.residents.keys()].map((key) => this.closeResident(key, "shutdown")));
  }

  /**
   * Runs a completing task's effect. For `merge` it lands `task/<id>` on the default branch in the
   * project's clone, whoever did the work; the board then marks the task done, or sends it back to
   * wait at its last stage.
   */
  async completeTask(project: Name, taskId: Ulid): Promise<void> {
    const { task } = await this.board.findTask(taskId);
    if (!task.completing) {
      return;
    }
    if (task.onDone !== "merge") {
      await this.board.finishCompletion(SYSTEM_ACTOR, {
        taskId,
        ok: true,
        detail: "no completion effect",
      });
      return;
    }
    const record = await this.board.readProject(project);
    const repoDir = await this.git.ensureRepo(record, this.board.paths.repo(project));
    const branch = taskBranch(taskId);
    const outcome = (await this.git.branchExists(repoDir, branch))
      ? await this.git.merge(repoDir, record.defaultBranch, branch)
      : { ok: true, detail: "nothing to land, since the task left no branch" };
    await this.board.recordMerge(SYSTEM_ACTOR, {
      project,
      taskId,
      branch,
      ok: outcome.ok,
      detail: outcome.detail,
    });
    await this.board.finishCompletion(SYSTEM_ACTOR, {
      taskId,
      ok: outcome.ok,
      detail: outcome.detail,
    });
  }

  /**
   * A turn that reported the user must decide asks where the question belongs, with a mention of
   * the user, which is what puts it before them. One that mentioned the user nowhere asks in its
   * own thread when it was in one that is still open, so the answer comes back to the same
   * conversation, and otherwise in a thread of its own on its scope's general channel, opened as the
   * citizen with its summary.
   */
  private async askUser(
    actor: Actor,
    scope: Name,
    threadId: Ulid | undefined,
    since: string,
    summary: string,
  ): Promise<void> {
    try {
      if (await this.board.hasMentioned(actor.name, USER_NAME, since)) {
        return;
      }
      const current =
        threadId === undefined ? null : await this.board.readThread(threadId).catch(() => null);
      if (current !== null && current.state === "open") {
        await this.board.postMessage(actor, {
          thread_id: current.id,
          body: `@${USER_NAME} ${summary}`,
        });
        return;
      }
      const thread = await this.board.openThread(actor, {
        channel: scope === SOCIETY_SCOPE ? "general" : `${scope}/general`,
        title: `${actor.name} asks for a decision: ${summary}`.slice(0, 200),
      });
      await this.board.postMessage(actor, {
        thread_id: thread.id,
        body: `@${USER_NAME} ${summary}`,
      });
    } catch (error) {
      this.log.warn({ agent: actor.name, error: String(error) }, "could not ask the user");
    }
  }

  /**
   * Commits what the turn left on a task branch and returns the worktree to the agent's own
   * branch, or for a task's own worktree detaches it, which frees the branch for the next holder.
   */
  private async handBack(agent: Name, worktree: string, home: string | null): Promise<void> {
    try {
      const handed = await this.git.handBack(worktree, home, {
        name: agent,
        email: `${agent}@stellaris.local`,
      });
      if (handed?.committed === true) {
        this.log.info({ agent, branch: handed.branch }, "committed work left at the end of a turn");
      }
    } catch (error) {
      this.log.warn({ agent, error: String(error) }, "could not hand the worktree back");
    }
  }

  /** A task's own worktree goes once the task has ended; its work is on the task's branch. */
  private async dropEndedTaskWorktree(taskId: Ulid, workspace: Workspace): Promise<void> {
    try {
      const { task } = await this.board.findTask(taskId);
      if (task.status === "done" || task.status === "abandoned") {
        await this.git.removeWorktree(workspace.repoDir, workspace.worktree);
      }
    } catch (error) {
      this.log.warn({ taskId, error: String(error) }, "could not remove an ended task's worktree");
    }
  }

  /** How long a turn token must live: the turn's limit and some slack, or for good without one. */
  private tokenLifetime(slackMs: number): number {
    return this.turnTimeoutMs === null ? Number.POSITIVE_INFINITY : this.turnTimeoutMs + slackMs;
  }

  private async renewLeases(actor: Actor, taskIds: readonly Ulid[]): Promise<void> {
    for (const taskId of taskIds) {
      try {
        await this.board.claimTask(actor, { task_id: taskId });
      } catch {
        // The agent released or submitted the task during the turn; nothing to renew.
      }
    }
  }

  private async fail(base: TurnRecord, error: string): Promise<TurnRecord> {
    const record: TurnRecord = {
      ...base,
      endedAt: this.now().toISOString(),
      exitReason: "error",
      error,
    };
    await this.board.beginTurn(base);
    await this.board.finishTurn(record);
    this.log.error({ agent: base.agent, project: base.project, error }, "turn could not start");
    return record;
  }

  /** Writes the CLI config files into the agent's home for inspection and for CLIs driven without an SDK. */
  private async renderConfigHome(agent: Name, instructions: string): Promise<void> {
    const home = this.board.paths.agent(agent);
    const claudeDir = path.join(home, ".claude");
    const codexDir = path.join(home, ".codex");
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });
    await writeFile(path.join(claudeDir, "CLAUDE.md"), instructions, "utf8");
    await writeFile(
      path.join(claudeDir, "board.mcp.json"),
      `${JSON.stringify(renderClaudeMcpConfig(this.mcpUrl), null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(codexDir, "AGENTS.md"), instructions, "utf8");
    await writeFile(
      path.join(codexDir, "board.mcp.toml"),
      renderCodexMcpConfig(this.mcpUrl),
      "utf8",
    );
  }
}
