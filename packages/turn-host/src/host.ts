import type { Actor, Board } from "@stellaris/board-core";
import {
  mayHoldStage,
  PATH_TOKENS,
  ROLE_KIND_APPROVERS,
  sessionKey,
  SOCIETY_SCOPE,
  USER_NAME,
  USER_ROLE,
  wakeScope,
  type AgentEvent,
  type Message,
  type Name,
  type Project,
  type ProjectRepo,
  type Task,
  type Thread,
  type TranscriptEntry,
  type TurnDispatch,
  type TurnJob,
  type TurnOutcome,
  type TurnRecord,
  type TurnWorkspace,
  type Ulid,
} from "@stellaris/shared";
import {
  buildTurnPrompt,
  type Conversation,
  type KnowledgeView,
  type RunnersView,
  type SocietyView,
} from "./prompt.js";
import { renderInstructions, type OnboardingContext } from "./render.js";

export interface HostLog {
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

/** What the host needs to know of the runner a turn goes to. */
export interface RunnerSeat {
  readonly name: Name;
  /** The CLIs whose sessions the runner can keep warm. */
  readonly residentClis: readonly string[];
  /** Whether the runner reports the conversation's session warm right now. */
  isWarm(key: string): boolean;
}

export interface TurnHostOptions {
  readonly board: Board;
  /** Where agents reach the board's MCP endpoint, as runners see it. */
  readonly mcpUrl: string;
  /** How long a turn may run, or null for no limit. */
  readonly turnTimeoutMs?: number | null | undefined;
  /** Rounds of tool calls a turn may take, or null for no limit. */
  readonly maxTurns?: number | null | undefined;
  /** How long a warm session stays warm after its last turn. */
  readonly residentIdleMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: HostLog | undefined;
  /** Every event of a turn as it arrives, with the turn's scope and, in a thread, its thread. */
  readonly onEvent?:
    | ((agent: Name, scope: Name, event: AgentEvent, thread?: Ulid) => void)
    | undefined;
}

/** A turn whose job went out and whose outcome has not come back. */
interface OpenTurn {
  readonly job: TurnJob;
  readonly runner: Name;
  readonly actor: Actor;
  readonly record: TurnRecord;
  readonly cursorAfter: Ulid | null;
  readonly held: readonly Ulid[];
  readonly taskId: Ulid | undefined;
  readonly costSoFarUsd: number;
  readonly configuredModel: string | null;
  readonly transcript: TranscriptEntry[];
  /** The turn's own token, revoked when the turn ends; a warm session's lives on with the session. */
  readonly coldToken: string | null;
  readonly residentKey: string | null;
  readonly keepLeases: ReturnType<typeof setInterval>;
  readonly done: (record: TurnRecord) => void;
}

/** A prepared turn: the job to send and the record its end resolves to, or a turn that could not start. */
export type Opened =
  | { readonly job: TurnJob; readonly ended: Promise<TurnRecord> }
  | { readonly failed: TurnRecord };

const SILENT: HostLog = { info() {}, warn() {}, error() {} };
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_RESIDENT_IDLE_MS = 10 * 60_000;
/** A running turn renews the leases it holds this often, so one longer than a lease keeps its claims. */
const LEASE_RENEW_MS = 10 * 60_000;
const USER_POST_TRIGGER = "user_post";
const OPS_TRIGGER = "ops_event";
/** How many signals a reader's prompt lists at most, newest kept. */
const MAX_SIGNALS = 30;

/**
 * The server side of a turn. It turns a dispatch into a self-contained job, everything the runner
 * needs with every policy decided, and records the turn's start; when the outcome comes back it
 * records the end: the session, the cursor, the leases, a question to the user, the transcript.
 * It never touches a runner's disk: places in the job's text are `PATH_TOKENS`.
 */
export class TurnHost {
  private readonly board: Board;
  private readonly mcpUrl: string;
  private readonly turnTimeoutMs: number | null;
  private readonly maxTurns: number | null;
  private readonly residentIdleMs: number;
  private readonly now: () => Date;
  private readonly log: HostLog;
  private readonly onEvent: TurnHostOptions["onEvent"];
  private readonly open = new Map<Ulid, OpenTurn>();
  /** Tokens of warm sessions by runner and session key, kept while the runner keeps the session. */
  private readonly residentTokens = new Map<string, string>();

  constructor(options: TurnHostOptions) {
    this.board = options.board;
    this.mcpUrl = options.mcpUrl;
    this.turnTimeoutMs =
      options.turnTimeoutMs === undefined ? DEFAULT_TURN_TIMEOUT_MS : options.turnTimeoutMs;
    this.maxTurns = options.maxTurns === undefined ? DEFAULT_MAX_TURNS : options.maxTurns;
    this.residentIdleMs = options.residentIdleMs ?? DEFAULT_RESIDENT_IDLE_MS;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? SILENT;
    this.onEvent = options.onEvent;
  }

  /** The runner a turn in flight runs on, or undefined for a turn the host does not know. */
  runnerOf(turnId: Ulid): Name | undefined {
    return this.open.get(turnId)?.runner;
  }

  /** The turns in flight on a runner. */
  turnsOn(runner: Name): Ulid[] {
    return [...this.open.values()]
      .filter((turn) => turn.runner === runner)
      .map((turn) => turn.job.turnId);
  }

  /** Whether a runner has a turn in flight for an agent: what lets it read and write the agent's home. */
  hasTurnFor(runner: Name, agent: Name): boolean {
    return [...this.open.values()].some(
      (turn) => turn.runner === runner && turn.job.agent === agent,
    );
  }

  /**
   * Builds the job for a dispatch on a runner and records the turn's start. A turn that cannot
   * start, a retired agent or one without a CLI, is recorded as failed instead.
   */
  async openTurn(dispatch: TurnDispatch, runner: RunnerSeat): Promise<Opened> {
    const agent = await this.board.readAgent(dispatch.agent);
    const actor: Actor = { name: agent.name, role: agent.role };
    const thread = dispatch.thread;
    const startedAt = this.now().toISOString();
    const base: TurnRecord = {
      agent: agent.name,
      project: dispatch.project,
      ...(thread === undefined ? {} : { thread: thread.id }),
      runner: runner.name,
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
      return { failed: await this.fail(base, `${agent.name} is retired`) };
    }
    if (agent.cli === null) {
      return { failed: await this.fail(base, `${agent.name} has no CLI binding`) };
    }
    const charter = await this.board.readRole(agent.role);
    const societyScope = dispatch.project === SOCIETY_SCOPE;

    const taskId = thread?.task === true ? thread.id : undefined;
    const project = societyScope ? null : await this.board.readProject(dispatch.project);
    const workspace = await this.workspaceOf(project, taskId);
    const sessions = await this.board.readSessions(agent.name, dispatch.project, thread?.id);
    // A session lives on the runner it began on; anywhere else the conversation starts afresh.
    const recorded = sessions.runner === runner.name ? sessions[agent.cli] : undefined;
    const newSession = recorded === undefined;
    const lastTurn = await this.board.readLastTurn(agent.name, dispatch.project, thread?.id);
    // A resumed session reports a running total that includes its earlier turns. Records from
    // before `sessionCostUsd` held that total as the turn's cost.
    const costSoFarUsd =
      !newSession && lastTurn?.session === recorded
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
    const onboarding: OnboardingContext | null =
      dispatch.onboarding || (newSession && thread === undefined)
        ? {
            agentName: agent.name,
            roleSummary: charter.purpose,
            project: dispatch.project,
            worktree: PATH_TOKENS.worktree,
          }
        : null;
    const instructions = renderInstructions({
      agentName: agent.name,
      roleCharter: await this.board.readAgentRoleBody(agent.name),
      memoryCore: await this.board.readMemoryCore(agent.name),
      homeDir: PATH_TOKENS.home,
      boardDir: PATH_TOKENS.board,
      norms: await this.board.readSocietyNorms(),
      skills: [
        ...(await this.board.listAgentSkills(agent.name)).map((skill) => ({
          ...skill,
          path: `${PATH_TOKENS.home}/skills/${skill.name}/SKILL.md`,
        })),
        ...(await this.board.listSocietySkills()).map((skill) => ({
          ...skill,
          path: `${PATH_TOKENS.board}/society/skills/${skill.name}/SKILL.md`,
        })),
      ],
      ...(onboarding === null ? {} : { onboarding }),
    });
    // Roles that route for the user get the roster and the projects still taking work in every digest.
    const societyView: SocietyView | null = charter.wakeTriggers.includes(USER_POST_TRIGGER)
      ? {
          projects: (await this.board.listProjects()).filter((each) => each.archived === undefined),
          members: await this.board.listMembers(),
        }
      : null;
    // Society roles plan where work runs, so they see every machine and what lives on it.
    const runners: RunnersView | null =
      charter.societyScope && agent.role !== USER_ROLE
        ? {
            runners: await this.board.listRunners(),
            projects: (await this.board.listProjects()).filter(
              (each) => each.archived === undefined,
            ),
          }
        : null;
    const knowledge: KnowledgeView = societyScope
      ? {
          dir: `${PATH_TOKENS.board}/society/knowledge`,
          topics: await this.board.listKnowledge(null),
        }
      : {
          dir: `${PATH_TOKENS.board}/projects/${dispatch.project}/knowledge`,
          topics: await this.board.listKnowledge(dispatch.project),
        };
    // Readers of operations signals get those logged for this scope since their last home turn here.
    const signals =
      thread === undefined && charter.wakeTriggers.includes(OPS_TRIGGER)
        ? (await this.board.listSignals(500))
            .filter(
              (record) =>
                wakeScope(agent, record.signal.project ?? null) === dispatch.project &&
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
      runners,
      knowledge,
      signals,
      conflicts: await this.board.listHomeConflicts(agent.name),
    });

    // Residency keeps a role's home conversation warm; its thread conversations run cold.
    const resident =
      charter.resident && thread === undefined && runner.residentClis.includes(agent.cli);
    const residentKey = resident ? sessionKey(agent.name, dispatch.project) : null;
    const token =
      residentKey === null
        ? this.board.issueTurnToken(
            agent.name,
            agent.role,
            this.tokenLifetime(5 * 60_000),
            dispatch.project,
            thread?.id,
          )
        : this.residentToken(runner, residentKey, actor, dispatch.project);

    const record = await this.board.beginTurn({
      ...base,
      session: recorded ?? null,
      sessionCostUsd: costSoFarUsd,
    });
    if (record.id === undefined) {
      throw new Error("the board gave the turn no id");
    }
    const job: TurnJob = {
      turnId: record.id,
      agent: agent.name,
      role: agent.role,
      cli: agent.cli,
      ...(agent.model === undefined ? {} : { model: agent.model }),
      scope: dispatch.project,
      ...(thread === undefined ? {} : { thread: thread.id }),
      session: recorded ?? null,
      costSoFarUsd,
      instructions,
      prompt,
      mcp: { url: this.mcpUrl, token },
      limits: { timeoutMs: this.turnTimeoutMs, maxTurns: this.maxTurns },
      ...(residentKey === null
        ? {}
        : { resident: { key: residentKey, idleMs: this.residentIdleMs } }),
      workspace,
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
    const { promise: ended, resolve: done } = Promise.withResolvers<TurnRecord>();
    this.open.set(record.id, {
      job,
      runner: runner.name,
      actor,
      record,
      cursorAfter,
      held: held.map((each) => each.id),
      taskId,
      costSoFarUsd,
      configuredModel: agent.model ?? null,
      transcript: [],
      coldToken: residentKey === null ? token : null,
      residentKey: residentKey === null ? null : `${runner.name}|${residentKey}`,
      keepLeases,
      done,
    });
    this.log.info(
      {
        agent: agent.name,
        project: dispatch.project,
        thread: thread?.id,
        runner: runner.name,
        session: recorded,
        newSession,
        resident: residentKey !== null,
      },
      "turn starting",
    );
    return { job, ended };
  }

  /** Steps of a turn in flight, as the runner received them. */
  addEvents(turnId: Ulid, entries: readonly TranscriptEntry[]): void {
    const turn = this.open.get(turnId);
    if (turn === undefined) {
      return;
    }
    for (const entry of entries) {
      turn.transcript.push(entry);
      this.onEvent?.(turn.job.agent, turn.job.scope, entry.event, turn.job.thread);
    }
  }

  /**
   * Records a turn's end from its outcome. Returns null for a turn the host does not know, else
   * whether the task the turn worked on has ended, so the runner may drop its worktree.
   */
  async closeTurn(turnId: Ulid, outcome: TurnOutcome): Promise<{ dropWorktree: boolean } | null> {
    const turn = this.open.get(turnId);
    if (turn === undefined) {
      return null;
    }
    this.open.delete(turnId);
    clearInterval(turn.keepLeases);
    if (turn.coldToken !== null) {
      this.board.revokeTurnToken(turn.coldToken);
    }
    const { job } = turn;
    if (outcome.session !== job.session) {
      // A fresh session's id, or the real one of a CLI that assigns its own, is kept for the next turn.
      await this.board.writeSession(
        job.agent,
        job.scope,
        job.cli,
        outcome.session,
        turn.runner,
        job.thread,
      );
    }
    const finished: TurnRecord = {
      ...turn.record,
      session: outcome.session,
      endedAt: this.now().toISOString(),
      exitReason: outcome.exitReason,
      status: outcome.status,
      error: outcome.error,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      sessionCostUsd: outcome.sessionCostUsd ?? turn.costSoFarUsd,
      toolCalls: turn.transcript.filter((entry) => entry.event.type === "tool_call").length,
      model: outcome.model ?? turn.configuredModel,
      ...(outcome.work === null ? {} : { work: outcome.work }),
    };
    if (outcome.exitReason === "completed" || outcome.exitReason === "blocked") {
      // The digest was delivered; only now does the cursor move past it.
      await this.board.setDigestCursor(job.agent, job.scope, turn.cursorAfter, job.thread);
      await this.renewLeases(turn.actor, turn.held);
      if (outcome.status?.needsUserDecision === true) {
        await this.askUser(
          turn.actor,
          job.scope,
          job.thread,
          turn.record.startedAt,
          outcome.status.summary,
        );
      }
    }
    await this.board.finishTurn(finished, turn.transcript);
    this.log.info(
      { agent: job.agent, project: job.scope, thread: job.thread, exitReason: finished.exitReason },
      "turn finished",
    );
    turn.done(finished);
    return { dropWorktree: await this.taskEnded(turn.taskId) };
  }

  /** Ends a turn whose outcome will never come, as when its runner went away, as failed. */
  async abortTurn(turnId: Ulid, reason: string): Promise<void> {
    const turn = this.open.get(turnId);
    if (turn === undefined) {
      return;
    }
    this.open.delete(turnId);
    clearInterval(turn.keepLeases);
    if (turn.coldToken !== null) {
      this.board.revokeTurnToken(turn.coldToken);
    }
    const finished: TurnRecord = {
      ...turn.record,
      endedAt: this.now().toISOString(),
      exitReason: "error",
      error: reason,
      toolCalls: turn.transcript.filter((entry) => entry.event.type === "tool_call").length,
    };
    await this.board.finishTurn(finished, turn.transcript);
    this.log.warn({ agent: turn.job.agent, project: turn.job.scope, reason }, "turn aborted");
    turn.done(finished);
  }

  /** Records a turn that could never start, as when no runner could take its agent's CLI. */
  async refuseTurn(dispatch: TurnDispatch, runner: Name, reason: string): Promise<TurnRecord> {
    const agent = await this.board.readAgent(dispatch.agent).catch(() => null);
    return this.fail(
      {
        agent: dispatch.agent,
        project: dispatch.project,
        ...(dispatch.thread === undefined ? {} : { thread: dispatch.thread.id }),
        runner,
        cli: agent?.cli ?? null,
        session: null,
        trigger: dispatch.trigger,
        startedAt: this.now().toISOString(),
        endedAt: null,
        exitReason: null,
        status: null,
        error: null,
        usage: null,
        costUsd: 0,
        toolCalls: 0,
        model: agent?.model ?? null,
      },
      reason,
    );
  }

  /**
   * The conversations a runner keeps warm changed: the token of every session it no longer keeps
   * is revoked, unless a turn of that session is still in flight.
   */
  warmChanged(runner: Name, warm: readonly string[]): void {
    const keep = new Set(warm.map((key) => `${runner}|${key}`));
    const busy = new Set([...this.open.values()].map((turn) => turn.residentKey));
    for (const [key, token] of this.residentTokens) {
      if (key.startsWith(`${runner}|`) && !keep.has(key) && !busy.has(key)) {
        this.board.revokeTurnToken(token);
        this.residentTokens.delete(key);
      }
    }
  }

  /** A warm session keeps the token it started with; a session the runner does not report warm gets a new one. */
  private residentToken(runner: RunnerSeat, key: string, actor: Actor, scope: Name): string {
    const slot = `${runner.name}|${key}`;
    const ttl = this.tokenLifetime(this.residentIdleMs + 60_000);
    const known = this.residentTokens.get(slot);
    if (known !== undefined && runner.isWarm(key) && this.board.extendTurnToken(known, ttl)) {
      return known;
    }
    if (known !== undefined) {
      this.board.revokeTurnToken(known);
    }
    const token = this.board.issueTurnToken(actor.name, actor.role, ttl, scope);
    this.residentTokens.set(slot, token);
    return token;
  }

  private async workspaceOf(
    project: Project | null,
    taskId: Ulid | undefined,
  ): Promise<TurnWorkspace> {
    if (project === null) {
      return { kind: "home" };
    }
    const repo: ProjectRepo = {
      slug: project.slug,
      origin: project.repo,
      defaultBranch: project.defaultBranch,
    };
    if (taskId !== undefined) {
      return { kind: "task", repo, taskId };
    }
    // Every task in play gets its branch before a home turn, so a holder only has to switch to it.
    const branches = (await this.board.listTasks(project.slug))
      .filter((task) => task.status === "open" || task.status === "claimed")
      .map((task) => `task/${task.id}`);
    return { kind: "project", repo, branches };
  }

  /** Whether a task conversation's task has ended, which frees its worktree. */
  private async taskEnded(taskId: Ulid | undefined): Promise<boolean> {
    if (taskId === undefined) {
      return false;
    }
    try {
      const { task } = await this.board.findTask(taskId);
      return task.status === "done" || task.status === "abandoned";
    } catch {
      return false;
    }
  }

  /**
   * A turn that reported the user must decide asks where the question belongs, with a mention of
   * the user, which is what puts it before them. One that mentioned the user nowhere asks in its
   * own thread when it was in one that is still open, so the answer comes back to the same
   * conversation, and otherwise in a thread of its own on its scope's general channel, opened as the
   * citizen with its summary. One that proposed something the user decides has put its decision
   * before the user already, where deciding it clears it; a mention would stay until the user
   * posted beside it.
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
      const proposed = (await this.board.listProposals()).some(
        (proposal) =>
          proposal.proposedBy === actor.name &&
          proposal.createdAt >= since &&
          ROLE_KIND_APPROVERS[proposal.kind].includes(USER_ROLE),
      );
      if (proposed) {
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
    const started = await this.board.beginTurn(base);
    const record: TurnRecord = {
      ...started,
      endedAt: this.now().toISOString(),
      exitReason: "error",
      error,
    };
    await this.board.finishTurn(record);
    this.log.error({ agent: base.agent, project: base.project, error }, "turn could not start");
    return record;
  }
}
