import { randomUUID } from "node:crypto";
import {
  CLOSING_ATTEMPTS,
  type Actor,
  type Board,
  type SignalRecord,
  type TurnInFlight,
} from "@stellaris/board-core";
import {
  channelRef,
  conversationPart,
  mayHoldStage,
  parseChannelRef,
  PATH_TOKENS,
  proposalApprovers,
  sessionKey,
  SOCIETY_SCOPE,
  USER_NAME,
  USER_ROLE,
  wakeScope,
  type AgentEvent,
  type CliKind,
  type Cron,
  type Message,
  type Name,
  type Project,
  projectRepo,
  type RunningTurn,
  type StuckWork,
  type Task,
  type Thread,
  type TranscriptEntry,
  type TurnAck,
  type TurnDispatch,
  type TurnJob,
  type TurnOutcome,
  type TurnRecord,
  type TurnSteer,
  type TurnWorkspace,
  type Ulid,
  workspaceConversationOf,
} from "@stellaris/shared";
import {
  buildSteerText,
  buildTurnPrompt,
  type Conversation,
  type Ending,
  type KnowledgeView,
  type RunnersView,
  type SocietyView,
} from "./prompt.js";
import {
  instructionsHash,
  renderInstructions,
  type OnboardingContext,
  type RenderInstructionsInput,
} from "./render.js";

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
  /** The CLIs whose running turns the runner can steer and stop. */
  readonly steerableClis?: readonly string[] | undefined;
  readonly stoppableClis?: readonly string[] | undefined;
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
  /** Every event of a turn as it arrives, with the turn's scope and conversation there. */
  readonly onEvent?:
    | ((agent: Name, scope: Name, event: AgentEvent, conversation: TurnConversation) => void)
    | undefined;
}

/**
 * A turn's conversation beside its scope's home: a thread's, a channel's, or, in the society scope,
 * a project's channels'; none for home.
 */
export interface TurnConversation {
  readonly thread?: Ulid | undefined;
  readonly channel?: Name | undefined;
  readonly place?: Name | undefined;
}

/** A job's conversation beside its scope's home, as the board names it. */
function conversationOfJob(job: TurnJob): TurnConversation {
  return {
    ...(job.thread === undefined ? {} : { thread: job.thread }),
    ...(job.channel === undefined ? {} : { channel: job.channel }),
    ...(job.place === undefined ? {} : { place: job.place }),
  };
}

/** A steer sent into a turn: the newest message it delivers, and what it delivers. */
interface SentSteer {
  readonly through: Ulid;
  readonly messages: readonly Ulid[];
  readonly text: string;
}

/** A turn whose job went out and whose outcome has not come back. */
interface OpenTurn {
  readonly job: TurnJob;
  readonly runner: Name;
  readonly actor: Actor;
  readonly record: TurnRecord;
  /** The newest message the turn has been shown, at its start or by a steer it took. */
  delivered: Ulid | null;
  /** Every steer sent into the turn, by id, so one taken late still moves `delivered`. */
  readonly steers: Map<string, SentSteer>;
  /** The steer sent and not yet taken or refused; a turn has at most one. */
  outstanding: string | null;
  /** Who asked the turn to stop. */
  stopRequestedBy: Name | null;
  readonly held: readonly Ulid[];
  readonly costSoFarUsd: number;
  /** The hash of the job's instructions (`instructionsHash`), which its session holds once it took them. */
  readonly instructionsNow: string;
  /** How many turns in a row before this one could not resume the job's session for a `retry`. */
  readonly resumeRetries: number;
  readonly configuredModel: string | null;
  readonly transcript: TranscriptEntry[];
  /** The turn's own token, revoked when the turn ends; a warm session's lives on with the session. */
  readonly coldToken: string | null;
  readonly residentKey: string | null;
  /** Whether a reflection that completes here ends the session: a society role's home. */
  readonly afreshAfterReflection: boolean;
  readonly keepLeases: ReturnType<typeof setInterval>;
  readonly done: (record: TurnRecord) => void;
  /** Ends the turn for the scheduler when its end could not be recorded. */
  readonly fail: (error: unknown) => void;
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
/**
 * How many turns in a row may fail to resume a conversation's session for a `retry` before it is
 * dropped as `lost`, so a resume that never works costs a few failed turns rather than every one.
 */
export const RESUME_RETRIES = 3;

/** What a task's thread is told of commits its branch cannot take. */
function stuckNotice(stuck: StuckWork): string {
  const more = stuck.total - stuck.commits.length;
  const commits = `${stuck.commits.map((commit) => `\`${commit}\``).join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
  return `${stuck.agent}'s worktree for this task holds commits that \`${stuck.branch}\` lacks and that the runner cannot fast-forward it to, because they no longer build on its tip or another worktree's commits build on it too: ${commits}. Until someone puts them on the branch, it lacks them, and so does what lands from it; any worktree of the project's clone can cherry-pick or merge them by id.`;
}

/** How many signals a reader's prompt lists at most, newest kept. */
const MAX_SIGNALS = 30;
/** How many of the log's newest signal records a reader's prompt is drawn from. */
const SIGNAL_READ = 500;
/** The turn count that leads the summary of the scheduler's spend report (`reportCost`). */
const REPORT_TURNS = /^(\d+) turn\(s\) completed /;

/**
 * The hourly spend reports among signal records summed into one record at the latest of them, so
 * a reader learns the spend reported since its last turn, not the last hour's alone, and the
 * dearest report stays in sight. The first of those reports can count turns from before the
 * reader's last turn, and turns since the newest are not reported yet. A report whose summary
 * names no turn count leaves the total uncounted. `partial` says the read cut signals logged since
 * the reader's last turn, so the sums are lower bounds.
 */
function sumSpend(records: readonly SignalRecord[], partial: boolean): SignalRecord[] {
  const reports = records.filter((record) => record.signal.kind === "turn_cost");
  const last = reports.at(-1);
  if (last === undefined || (reports.length === 1 && !partial)) {
    return [...records];
  }
  let cost = 0;
  let turns: number | null = 0;
  let dearest = last;
  for (const report of reports) {
    cost += report.signal.value;
    const counted = REPORT_TURNS.exec(report.signal.summary)?.[1];
    turns = turns === null || counted === undefined ? null : turns + Number(counted);
    if (report.signal.value > dearest.signal.value) {
      dearest = report;
    }
  }
  const first = reports[0] ?? last;
  const one = reports.length === 1;
  const summary = [
    `${turns === null ? "turns" : `${turns} turn(s)`} completed for $${cost.toFixed(2)} in ${reports.length} hourly report(s) logged ${one ? `at ${last.ts}` : `from ${first.ts} to ${last.ts}`}`,
    ...(one
      ? []
      : [`the dearest, logged at ${dearest.ts}, was $${dearest.signal.value.toFixed(2)}`]),
    ...(partial
      ? [`the read holds the newest ${SIGNAL_READ} signals, so these are lower bounds`]
      : []),
  ].join("; ");
  const summed: SignalRecord = { ...last, signal: { ...last.signal, summary, value: cost } };
  return records.flatMap((record) =>
    record === last ? [summed] : record.signal.kind === "turn_cost" ? [] : [record],
  );
}

/**
 * Each condition's latest log among signal records, oldest first by that log, so the repeats of
 * a persisting condition cannot push other conditions past the cap; `sumSpend` has already
 * folded the hourly spend reports into one.
 */
function latestPerKey(records: readonly SignalRecord[]): SignalRecord[] {
  const latest = new Map<string, SignalRecord>();
  for (const record of records) {
    latest.delete(record.signal.key);
    latest.set(record.signal.key, record);
  }
  return [...latest.values()];
}

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
    const channel = thread === undefined ? dispatch.channel : undefined;
    // A project's channels have a conversation of their own only for a turn in the society scope.
    const place =
      thread === undefined && channel === undefined && dispatch.project === SOCIETY_SCOPE
        ? dispatch.place
        : undefined;
    const part = conversationPart({ thread: thread?.id, channel, place });
    const startedAt = this.now().toISOString();
    const base: TurnRecord = {
      agent: agent.name,
      project: dispatch.project,
      ...(thread === undefined ? {} : { thread: thread.id }),
      ...(channel === undefined ? {} : { channel }),
      ...(place === undefined ? {} : { place }),
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
      ...(dispatch.crons === undefined ? {} : { crons: dispatch.crons }),
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
    const task: Task | null =
      taskId === undefined
        ? null
        : await this.board
            .findTask(taskId)
            .then((found) => found.task)
            .catch(() => null);
    const project = societyScope ? null : await this.board.readProject(dispatch.project);
    const workspace = await this.workspaceOf(project, thread, channel, place, task);
    const sessions = await this.board.readSessions(agent.name, dispatch.project, part);
    // A session lives on the runner it began on; anywhere else the conversation starts afresh.
    const recorded = sessions.runner === runner.name ? sessions[agent.cli] : undefined;
    const newSession = recorded === undefined;
    const lastTurn = await this.board.readLastTurn(agent.name, dispatch.project, part);
    // A resumed session reports a running total that includes its earlier turns. Records from
    // before `sessionCostUsd` held that total as the turn's cost.
    const costSoFarUsd =
      !newSession && lastTurn?.session === recorded
        ? (lastTurn.sessionCostUsd ?? lastTurn.costUsd)
        : 0;
    // Its running usage too, which records from before `sessionUsage`, or from a runner that
    // reports none, do not hold: the adapter then counts the turn without it.
    const usageSoFar =
      !newSession && lastTurn?.session === recorded ? lastTurn.sessionUsage : undefined;
    // Failed resumes of this session counted so far, while they come one after another.
    const resumeRetries =
      !newSession && lastTurn?.session === recorded && lastTurn.resumeFailed === "retry"
        ? (lastTurn.resumeRetries ?? 1)
        : 0;
    // A society role's home keeps no session past a reflection, which saved what it keeps into the
    // home's files; the turn after one starts afresh, and is no citizen's first turn.
    const afreshAfterReflection =
      charter.societyScope && agent.role !== USER_ROLE && societyScope && part === undefined;
    const afterReflection =
      lastTurn?.trigger.kind === "reflection" && lastTurn.sessionDropped === true;

    // The digest of this turn's conversation only: a citizen's turns in its other conversations
    // may run at the same time, and each reads and acts on its own. A new thread conversation
    // is shown the whole thread, since nothing of it is in the session yet.
    const digest = await this.board.readDigest(
      {
        ...actor,
        scope: dispatch.project,
        ...(thread === undefined ? {} : { thread: thread.id }),
        ...(channel === undefined ? {} : { channel }),
        ...(place === undefined ? {} : { place }),
      },
      { advance: false, limit: thread === undefined ? 50 : 100 },
    );
    const threadSoFar =
      thread !== undefined && newSession
        ? (await this.board.listThread(thread.id).catch(() => [] as Message[])).slice(-100)
        : null;
    const messages = threadSoFar ?? digest.messages;
    const cursorAfter = threadSoFar?.at(-1)?.id ?? digest.cursor;
    // Stages are a task conversation's business: its own task's, and nothing in other conversations.
    const held =
      task === null
        ? []
        : (await this.board.heldClaims(agent.name)).filter((each) => each.id === task.id);
    const onboarding: OnboardingContext | null =
      dispatch.onboarding || (newSession && part === undefined && !afterReflection)
        ? {
            agentName: agent.name,
            roleSummary: charter.purpose,
            project: dispatch.project,
            worktree: PATH_TOKENS.worktree,
            otherChannels: (project?.channels ?? [])
              .map((name) => channelRef(dispatch.project, name))
              .filter((ref) => !agent.subscriptions.includes(ref)),
          }
        : null;
    const rendered: RenderInstructionsInput = {
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
    };
    const instructions = renderInstructions(rendered);
    // Both CLIs keep the instructions a session began with when they resume it, whatever they are
    // given then, so a resumed session whose instructions changed since it last received them gets
    // them in the prompt, as does one the board knows nothing of, as from before it kept them.
    const instructionsNow = instructionsHash(rendered);
    const instructionsHeld =
      !newSession && lastTurn?.session === recorded ? lastTurn.sessionInstructionsHash : undefined;
    const changedInstructions = !newSession && instructionsHeld !== instructionsNow;
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
    // Readers of operations signals get those logged for this scope since their last home turn
    // here, each condition once and the spend reports summed.
    const signals =
      part === undefined && charter.wakeTriggers.includes(OPS_TRIGGER)
        ? await this.signalsSince(agent, dispatch.project, lastTurn)
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
        : {
            thread: threadRecord,
            task,
            fresh: threadSoFar !== null,
            ...(threadRecord.state === "closed"
              ? { replyIn: await this.replyIn(threadRecord) }
              : {}),
          };
    const ending =
      dispatch.trigger.kind === "closing"
        ? await this.endingOf(dispatch.project, threadRecord, task, channel, place)
        : null;
    const society = await this.board.society();
    const crons: Cron[] = [];
    for (const id of dispatch.crons ?? []) {
      const cron = await this.board.readCron(id).catch(() => null);
      if (cron !== null) {
        crons.push(cron);
      }
    }
    const prompt = buildTurnPrompt({
      dispatch,
      clock: { now: this.now(), timeZone: society.timezone },
      crons,
      messages,
      threads,
      conversation,
      ending,
      heldClaims: held,
      waitingStages: waiting,
      project,
      lastTurn,
      ...(changedInstructions ? { changedInstructions: instructions } : {}),
      onboarding,
      afreshAfterReflection,
      societyView,
      runners,
      knowledge,
      signals,
      conflicts: await this.board.listHomeConflicts(agent.name),
    });

    // Residency keeps a role's home conversation warm; its channel and thread conversations run cold.
    const resident =
      charter.resident && part === undefined && runner.residentClis.includes(agent.cli);
    const residentKey = resident ? sessionKey(agent.name, dispatch.project) : null;
    const token =
      residentKey === null
        ? this.board.issueTurnToken(
            agent.name,
            agent.role,
            this.tokenLifetime(5 * 60_000),
            dispatch.project,
            part,
          )
        : this.residentToken(runner, residentKey, actor, dispatch.project);

    const record = await this.board.beginTurn({
      ...base,
      session: recorded ?? null,
      sessionCostUsd: costSoFarUsd,
      ...(usageSoFar === undefined ? {} : { sessionUsage: usageSoFar }),
      ...(instructionsHeld === undefined ? {} : { sessionInstructionsHash: instructionsHeld }),
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
      ...(agent.effort === undefined ? {} : { effort: agent.effort }),
      scope: dispatch.project,
      ...(thread === undefined ? {} : { thread: thread.id }),
      ...(channel === undefined ? {} : { channel }),
      ...(place === undefined ? {} : { place }),
      session: recorded ?? null,
      costSoFarUsd,
      ...(usageSoFar === undefined ? {} : { usageSoFar }),
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
    const { promise: ended, resolve: done, reject: fail } = Promise.withResolvers<TurnRecord>();
    // A turn may fail before anyone awaits its end; whoever awaits it later still sees the error.
    ended.catch(() => undefined);
    this.open.set(record.id, {
      job,
      runner: runner.name,
      actor,
      record,
      delivered: cursorAfter,
      steers: new Map(),
      outstanding: null,
      stopRequestedBy: null,
      held: held.map((each) => each.id),
      costSoFarUsd,
      instructionsNow,
      resumeRetries,
      configuredModel: agent.model ?? null,
      transcript: [],
      coldToken: residentKey === null ? token : null,
      residentKey: residentKey === null ? null : `${runner.name}|${residentKey}`,
      afreshAfterReflection,
      keepLeases,
      done,
      fail,
    });
    this.log.info(
      {
        agent: agent.name,
        project: dispatch.project,
        thread: thread?.id,
        channel,
        place,
        runner: runner.name,
        session: recorded,
        newSession,
        resident: residentKey !== null,
      },
      "turn starting",
    );
    return { job, ended };
  }

  /**
   * Steps of a turn in flight, as the runner received them. A steer the CLI took moves what the
   * turn has been shown past its messages, and its step carries them and the text it delivered.
   */
  async addEvents(turnId: Ulid, entries: readonly TranscriptEntry[]): Promise<void> {
    const turn = this.open.get(turnId);
    if (turn === undefined) {
      return;
    }
    for (const received of entries) {
      let entry = received;
      const { event } = received;
      if (event.type === "steered") {
        const sent = turn.steers.get(event.steer);
        if (sent !== undefined) {
          entry = {
            ...received,
            event: { ...event, messages: [...sent.messages], text: sent.text },
          };
          if (turn.delivered === null || sent.through > turn.delivered) {
            turn.delivered = sent.through;
          }
          if (turn.outstanding === event.steer) {
            turn.outstanding = null;
          }
          await this.board
            .recordSteered({
              turnId,
              agent: turn.job.agent,
              project: turn.job.scope,
              ...conversationOfJob(turn.job),
              messages: sent.messages,
            })
            .catch((error: unknown) => {
              this.log.warn({ turnId, error: String(error) }, "could not record a steer");
            });
        }
      }
      turn.transcript.push(entry);
      this.onEvent?.(turn.job.agent, turn.job.scope, entry.event, conversationOfJob(turn.job));
    }
  }

  /** The turn in flight in a conversation, if any. */
  turnIn(
    agent: Name,
    scope: Name,
    conversation: TurnConversation = {},
  ): { turnId: Ulid; runner: Name; cli: CliKind } | null {
    for (const turn of this.open.values()) {
      const { job } = turn;
      if (
        job.agent === agent &&
        job.scope === scope &&
        job.thread === conversation.thread &&
        job.channel === conversation.channel &&
        job.place === conversation.place
      ) {
        return { turnId: job.turnId, runner: turn.runner, cli: job.cli };
      }
    }
    return null;
  }

  /** The turns in flight and their conversations, which the board checks before ending one. */
  inFlight(): TurnInFlight[] {
    return [...this.open.values()].map(({ job }) => ({
      agent: job.agent,
      scope: job.scope,
      ...conversationOfJob(job),
    }));
  }

  /** The turns in flight, for the interface: their conversations and where a mention reaches them. */
  runningTurns(): Array<Omit<RunningTurn, "steerable" | "stoppable"> & { runner: Name }> {
    return [...this.open.values()].map((turn) => ({
      turnId: turn.job.turnId,
      agent: turn.job.agent,
      scope: turn.job.scope,
      ...conversationOfJob(turn.job),
      cli: turn.job.cli,
      ...(turn.record.trigger.channel === undefined
        ? {}
        : { askedIn: turn.record.trigger.channel }),
      runner: turn.runner,
    }));
  }

  /**
   * What a steer into a turn would deliver: the conversation's digest from what the turn has been
   * shown, rendered as the prompt renders its digest. `busy` while a steer it was sent is not yet
   * taken or refused, and `nothing` when everything new was in what it was shown.
   */
  async prepareSteer(turnId: Ulid): Promise<TurnSteer | "busy" | "nothing" | "gone"> {
    const turn = this.open.get(turnId);
    if (turn === undefined || turn.stopRequestedBy !== null) {
      return "gone";
    }
    if (turn.outstanding !== null) {
      return "busy";
    }
    const { job } = turn;
    const digest = await this.board.readDigest(
      { ...turn.actor, scope: job.scope, ...conversationOfJob(job) },
      {
        ...(turn.delivered === null ? {} : { since_cursor: turn.delivered }),
        advance: false,
        limit: 50,
      },
    );
    const last = digest.messages.at(-1);
    // The turn may have ended, or taken another steer, while the digest was read.
    if (!this.open.has(turnId) || turn.outstanding !== null) {
      return "gone";
    }
    if (last === undefined) {
      return "nothing";
    }
    const threads = new Map<Ulid, Thread>();
    for (const id of new Set(digest.messages.flatMap((message) => message.thread ?? []))) {
      const record = await this.board.readThread(id).catch(() => undefined);
      if (record !== undefined) {
        threads.set(id, record);
      }
    }
    const steer: TurnSteer = { id: randomUUID(), text: buildSteerText(digest.messages, threads) };
    turn.steers.set(steer.id, {
      through: last.id,
      messages: digest.messages.map((message) => message.id),
      text: steer.text,
    });
    turn.outstanding = steer.id;
    return steer;
  }

  /** The runner's answer to a steer: one it did not take frees the turn for the next. */
  steerAnswered(turnId: Ulid, steerId: string, accepted: boolean): void {
    const turn = this.open.get(turnId);
    if (turn !== undefined && !accepted && turn.outstanding === steerId) {
      turn.outstanding = null;
    }
  }

  /** Marks a turn stopped by `by`; returns false for a turn not in flight. */
  requestStop(turnId: Ulid, by: Name): boolean {
    const turn = this.open.get(turnId);
    if (turn === undefined) {
      return false;
    }
    turn.stopRequestedBy ??= by;
    return true;
  }

  /**
   * Records a turn's end from its outcome. Returns null for a turn the host does not know, else
   * whether the task or thread the turn worked in has ended, so the runner may drop its workspace.
   */
  async closeTurn(turnId: Ulid, outcome: TurnOutcome): Promise<TurnAck | null> {
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
    const part = conversationPart(job);
    // A session the CLI found nothing of is dropped at once, and one it failed to resume too often
    // in a row as well, so the conversation's next turn starts a new one and is told why.
    const resumeRetries = outcome.resumeFailed === "retry" ? turn.resumeRetries + 1 : undefined;
    const dropSession =
      job.session !== null &&
      (outcome.resumeFailed === "lost" || (resumeRetries ?? 0) >= RESUME_RETRIES);
    // A society role's home starts afresh once a reflection there completed: the runner pushed the
    // home before it reported the outcome, so the next turn's instructions carry what it kept.
    const reflected =
      turn.afreshAfterReflection &&
      turn.record.trigger.kind === "reflection" &&
      outcome.exitReason === "completed";
    // The running usage is the runner's to report: it keeps the job's for a turn that saw none.
    const { sessionUsage: _started, sessionInstructionsHash: heldBefore, ...begun } = turn.record;
    // A new session began with the job's instructions, and a resumed one has them once the turn's
    // prompt, which carried any change, counts as delivered, as its digest does below.
    const promptDelivered =
      outcome.exitReason === "completed" ||
      outcome.exitReason === "blocked" ||
      outcome.exitReason === "stopped";
    const instructionsHeld =
      job.session === null
        ? outcome.session === null
          ? undefined
          : turn.instructionsNow
        : promptDelivered
          ? turn.instructionsNow
          : heldBefore;
    const finished: TurnRecord = {
      ...begun,
      session: outcome.session,
      endedAt: this.now().toISOString(),
      exitReason: outcome.exitReason,
      status: outcome.status,
      error: outcome.error,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      sessionCostUsd: outcome.sessionCostUsd ?? turn.costSoFarUsd,
      ...(outcome.sessionUsage === undefined ? {} : { sessionUsage: outcome.sessionUsage }),
      ...(instructionsHeld === undefined ? {} : { sessionInstructionsHash: instructionsHeld }),
      ...(outcome.contextTokens === undefined ? {} : { contextTokens: outcome.contextTokens }),
      toolCalls: turn.transcript.filter((entry) => entry.event.type === "tool_call").length,
      model: outcome.model ?? turn.configuredModel,
      ...(outcome.work === null ? {} : { work: outcome.work }),
      ...(outcome.exitReason === "stopped" ? { stoppedBy: turn.stopRequestedBy ?? USER_NAME } : {}),
      ...(outcome.resumeFailed === undefined ? {} : { resumeFailed: outcome.resumeFailed }),
      ...(outcome.transient === true ? { transient: true } : {}),
      ...(resumeRetries === undefined ? {} : { resumeRetries }),
      ...(dropSession || reflected ? { sessionDropped: true } : {}),
    };
    const ended = await this.conversationEnded(job);
    const closing = turn.record.trigger.kind === "closing";
    // A closing turn decided about what its workspace held, unless it failed before deciding.
    const decided = closing && outcome.exitReason !== "error" && outcome.exitReason !== "timeout";
    const recorded = await this.recorded(turn, async () => {
      if (dropSession && job.session !== null) {
        await this.board.dropSession(job.agent, job.scope, job.cli, job.session, part);
        this.log.warn(
          {
            agent: job.agent,
            project: job.scope,
            thread: job.thread,
            channel: job.channel,
            place: job.place,
            session: job.session,
            resumeFailed: outcome.resumeFailed,
            resumeRetries,
          },
          "dropped a session its CLI could not resume",
        );
      } else if (reflected) {
        // The session the reflection ran in goes, and one it started is never kept.
        if (job.session !== null) {
          await this.board.dropSession(job.agent, job.scope, job.cli, job.session, part);
        }
        this.log.info(
          { agent: job.agent, project: job.scope, session: outcome.session },
          "dropped a home session after its reflection",
        );
      } else if (outcome.session !== null && outcome.session !== job.session) {
        // A fresh session's id, or the real one of a CLI that assigns its own, is kept for the next turn.
        await this.board.writeSession(
          job.agent,
          job.scope,
          job.cli,
          outcome.session,
          turn.runner,
          part,
        );
      }
      // A stop is the user's decision on work it watched, not a failure: what the turn was shown
      // counts as read, so nothing restarts the work, and its stages stay held.
      if (promptDelivered) {
        // The digest was delivered, at the start and by the steers the turn took; only now does the
        // cursor move past it.
        await this.board.setDigestCursor(job.agent, job.scope, turn.delivered, part);
        await this.renewLeases(turn.actor, turn.held);
        if (outcome.status?.needsUserDecision === true) {
          await this.askUser(
            turn.actor,
            job,
            turn.record.trigger.channel,
            turn.record.startedAt,
            outcome.status.summary,
          );
        }
      }
      await this.board.finishTurn(finished, turn.transcript);
      // Work on no branch in an ended conversation's workspace is its citizen's to decide about,
      // in a closing turn, given again when one fails, up to `CLOSING_ATTEMPTS` in all.
      const conversation = ended ? workspaceConversationOf(job) : null;
      if (conversation !== null && (closing ? !decided : outcome.leftovers)) {
        const again = await this.board.recordLeftovers({
          agent: job.agent,
          scope: job.scope,
          conversation,
        });
        if (!again) {
          const where =
            conversation.kind === "thread"
              ? `thread ${conversation.id}`
              : conversation.kind === "channel"
                ? `channel ${conversation.name}`
                : `project ${conversation.project}'s channels`;
          await this.board.publishSignal({
            kind: "stuck_workspace",
            key: `stuck_workspace:${job.agent}:${job.scope}:${conversationPart(job) ?? ""}`,
            summary: `${job.agent}'s workspace in ${where} still holds work on no branch after ${CLOSING_ATTEMPTS} closing turns failed, so it stays on runner ${turn.runner}`,
            value: CLOSING_ATTEMPTS,
            agent: job.agent,
            ...(job.scope === SOCIETY_SCOPE ? {} : { project: job.scope }),
          });
        }
      }
    });
    // What the CLI said of its plan's quota, kept on the runner's record before the turn's end is
    // announced. A failure here is the runner record's, never the turn's.
    if (outcome.quota !== undefined) {
      await this.board.recordQuota(turn.runner, job.cli, outcome.quota).catch((error: unknown) => {
        this.log.warn(
          { runner: turn.runner, cli: job.cli, error: String(error) },
          "could not record a quota",
        );
      });
    }
    // Commits a task's branch could not take are said where everyone on the task reads, rather
    // than only in their citizen's next turn there. A failure here is the post's, never the turn's.
    for (const stuck of outcome.stuck ?? []) {
      await this.board
        .postTaskNotice(stuck.branch.slice("task/".length), stuckNotice(stuck))
        .catch((error: unknown) => {
          this.log.warn(
            { branch: stuck.branch, agent: stuck.agent, error: String(error) },
            "could not tell a task's thread of commits its branch cannot take",
          );
        });
    }
    if (recorded) {
      this.log.info(
        {
          agent: job.agent,
          project: job.scope,
          thread: job.thread,
          channel: job.channel,
          place: job.place,
          exitReason: finished.exitReason,
        },
        "turn finished",
      );
      await this.takeSkillFiles(finished);
      turn.done(finished);
    }
    return { dropWorkspace: ended && (closing ? decided : !outcome.leftovers) };
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
    if (await this.recorded(turn, () => this.board.finishTurn(finished, turn.transcript))) {
      this.log.warn({ agent: turn.job.agent, project: turn.job.scope, reason }, "turn aborted");
      await this.takeSkillFiles(finished);
      turn.done(finished);
    }
  }

  /**
   * Takes the folders of the skills the turn proposed, which reached the board with the home its
   * runner pushed before reporting. A failure only leaves them for approval to take.
   */
  private async takeSkillFiles(record: TurnRecord): Promise<void> {
    try {
      await this.board.takeSkillFiles(record);
    } catch (error) {
      this.log.warn(
        { agent: record.agent, project: record.project, error: String(error) },
        "could not take the folders of the skills a turn proposed",
      );
    }
  }

  /**
   * Records the end of a turn already taken out of `open`, and says whether it could. The scheduler
   * holds the turn's conversation until the turn ends, and nothing would end it once it has left
   * `open`, so a turn whose end could not be recorded ends with the error rather than holding its
   * conversation for good.
   */
  private async recorded(turn: OpenTurn, record: () => Promise<void>): Promise<boolean> {
    try {
      await record();
      return true;
    } catch (error) {
      this.log.error(
        { agent: turn.job.agent, project: turn.job.scope, error: String(error) },
        "could not record the end of a turn",
      );
      turn.fail(error);
      return false;
    }
  }

  /** Records a turn that could never start, as when no runner could take its agent's CLI. */
  async refuseTurn(dispatch: TurnDispatch, runner: Name, reason: string): Promise<TurnRecord> {
    const agent = await this.board.readAgent(dispatch.agent).catch(() => null);
    return this.fail(
      {
        agent: dispatch.agent,
        project: dispatch.project,
        ...(dispatch.thread === undefined ? {} : { thread: dispatch.thread.id }),
        ...(dispatch.thread !== undefined || dispatch.channel === undefined
          ? {}
          : { channel: dispatch.channel }),
        ...(dispatch.thread !== undefined ||
        dispatch.channel !== undefined ||
        dispatch.project !== SOCIETY_SCOPE ||
        dispatch.place === undefined
          ? {}
          : { place: dispatch.place }),
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
        ...(dispatch.crons === undefined ? {} : { crons: dispatch.crons }),
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

  /**
   * The signals a reader's prompt lists: those logged for its scope since its last turn there,
   * the spend reports summed, then each condition once at its latest log, the newest kept.
   */
  private async signalsSince(
    agent: { readonly memberships: readonly string[] },
    scope: Name,
    lastTurn: TurnRecord | null,
  ): Promise<SignalRecord[]> {
    // One record past the newest SIGNAL_READ tells whether they cut any logged since the last turn.
    const read = await this.board.listSignals(SIGNAL_READ + 1);
    const past = read.length > SIGNAL_READ ? read[0] : undefined;
    const partial = past !== undefined && (lastTurn === null || past.ts > lastTurn.startedAt);
    const since = read
      .slice(-SIGNAL_READ)
      .filter(
        (record) =>
          wakeScope(agent, record.signal.project ?? null) === scope &&
          (lastTurn === null || record.ts > lastTurn.startedAt),
      );
    return latestPerKey(sumSpend(since, partial)).slice(-MAX_SIGNALS);
  }

  /**
   * Where a conversation works: a task's on its branch, which its stage's holder has to itself,
   * any other thread's, a channel's, and a project's channels' seen from the society scope in a
   * place of its own, and the home in the citizen's own.
   */
  private async workspaceOf(
    project: Project | null,
    thread: TurnDispatch["thread"],
    channel: Name | undefined,
    place: Name | undefined,
    task: Task | null,
  ): Promise<TurnWorkspace> {
    const own =
      thread !== undefined
        ? thread.task
          ? {}
          : { thread: thread.id }
        : channel === undefined
          ? {}
          : { channel };
    if (project === null) {
      return { kind: "home", ...own, ...(place === undefined ? {} : { place }) };
    }
    const repo = projectRepo(project);
    if (thread?.task === true) {
      // A claim held past its lease is open to anyone, as the board treats it, and the user, who
      // takes no turns, keeps the branch from nobody.
      const holder =
        task?.status === "claimed" &&
        task.claimedBy !== undefined &&
        task.claimedBy !== USER_NAME &&
        (task.leaseExpiresAt === undefined ||
          new Date(task.leaseExpiresAt).getTime() > this.now().getTime())
          ? task.claimedBy
          : undefined;
      return { kind: "task", repo, taskId: thread.id, ...(holder === undefined ? {} : { holder }) };
    }
    // Every task in play gets its branch before a home turn, so a holder only has to switch to it.
    const branches = (await this.board.listTasks(project.slug))
      .filter((each) => each.status === "open" || each.status === "claimed")
      .map((each) => `task/${each.id}`);
    return { kind: "project", repo, branches, ...own };
  }

  /**
   * Whether a thread conversation's task or thread has ended, a channel conversation's channel was
   * archived, or a project conversation's project was, which frees its workspace.
   */
  private async conversationEnded(job: TurnJob): Promise<boolean> {
    const conversation = workspaceConversationOf(job);
    return conversation !== null && (await this.board.conversationEnded(conversation));
  }

  /** Where a closed thread's citizens say what still needs saying: its channel, else its place's general. */
  private async replyIn(thread: Thread): Promise<string> {
    return (await this.board.channelOpen(thread.channel))
      ? thread.channel
      : channelRef(parseChannelRef(thread.channel).project, "general");
  }

  /**
   * How a closing turn's conversation ended, and where its citizen asks someone else to take over
   * work that is not its own: the thread's channel while it is open, else the place's general.
   */
  private async endingOf(
    scope: Name,
    thread: Thread | undefined,
    task: Task | null,
    channel: Name | undefined,
    project: Name | undefined,
  ): Promise<Ending | null> {
    const place = scope === SOCIETY_SCOPE ? null : scope;
    if (thread !== undefined) {
      const closed = `the thread "${thread.title}" on ${thread.channel} was closed${
        thread.closedBy === undefined ? "" : ` by ${thread.closedBy}`
      }${task === null ? "" : `, its task ${task.status}`}`;
      return { how: closed, askIn: await this.replyIn(thread) };
    }
    if (channel === undefined) {
      return project === undefined
        ? null
        : { how: `project ${project} was archived`, askIn: channelRef(place, "general") };
    }
    const ref = channelRef(place, channel);
    const archived = (await this.board.listChannels()).find((each) => each.ref === ref)?.archived;
    return {
      how:
        archived === undefined
          ? `${ref} was archived`
          : `${ref} was archived by ${archived.by}: ${archived.reason}`,
      askIn: channelRef(place, "general"),
    };
  }

  /**
   * A turn that reported the user must decide asks where the question belongs, with a mention of
   * the user, which is what puts it before them. One that mentioned the user nowhere asks in its
   * own thread when it was in one that is still open, so the answer comes back to the same
   * conversation, and otherwise in a thread of its own on its conversation's channel, or its scope's
   * general for the home, opened as the citizen with its summary; a project's conversation in the
   * society scope asks on the channel of the project its wake came from, else the project's general.
   * One that proposed something the user decides has put its decision before the user already,
   * where deciding it clears it; a mention would stay until the user posted beside it.
   */
  private async askUser(
    actor: Actor,
    job: TurnJob,
    askedIn: string | undefined,
    since: string,
    summary: string,
  ): Promise<void> {
    const threadId = job.thread;
    const place = job.scope === SOCIETY_SCOPE ? null : job.scope;
    const channel =
      job.place === undefined
        ? channelRef(place, job.channel ?? "general")
        : askedIn !== undefined && parseChannelRef(askedIn).project === job.place
          ? askedIn
          : channelRef(job.place, "general");
    try {
      if (await this.board.hasMentioned(actor.name, USER_NAME, since)) {
        return;
      }
      const proposed = (await this.board.listProposals()).some(
        (proposal) =>
          proposal.proposedBy === actor.name &&
          proposal.createdAt >= since &&
          proposalApprovers(proposal.kind, proposal.charter).includes(USER_ROLE),
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
        channel,
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
