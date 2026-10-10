import { randomUUID } from "node:crypto";
import { BoardError, SYSTEM_ACTOR, type Board } from "@stellaris/board-core";
import type { SteerOutcome, TurnAssignment, TurnRunner } from "@stellaris/scheduler";
import {
  BranchChangesSchema,
  BranchFileSchema,
  MergeOutcomeSchema,
  ModelListSchema,
  RUNNER_PROTOCOL,
  SOCIETY_SCOPE,
  SweepResultSchema,
  type BranchChanges,
  type BranchFile,
  type CliKind,
  type ModelOption,
  type Name,
  projectRepo,
  type ProjectRepo,
  type RunnerAnswer,
  type RunnerHello,
  type RunnerMessage,
  type RunnerWelcome,
  type RunningTurn,
  type TranscriptEntry,
  type TurnAck,
  type TurnDispatch,
  type TurnOutcome,
  type TurnRecord,
  type TurnJob,
  type Ulid,
  type HeldWorkspace,
  type WorkspaceConversation,
} from "@stellaris/shared";
import type { HostLog, RunnerSeat, TurnHost } from "./host.js";

/** Sends one message down a runner's stream; false when the stream is gone. */
export type RunnerSend = (message: RunnerMessage) => boolean;

export interface RunnerHubOptions {
  readonly board: Board;
  readonly host: TurnHost;
  readonly version: string;
  /** How long a runner may be away before its turns in flight are failed. */
  readonly graceMs?: number | undefined;
  /** How long a request to a runner, a landing or a model list, may take. */
  readonly requestTimeoutMs?: number | undefined;
  /** How long a runner may take to acknowledge a job before no more turns go to it. */
  readonly ackTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: HostLog | undefined;
}

/** A runner the hub knows: what it registered with, its stream, and the slots it has in use. */
interface Seat {
  readonly name: Name;
  hello: RunnerHello;
  send: RunnerSend | null;
  /** Turns placed on it, from assignment until their record is written. */
  inUse: number;
  warm: Set<string>;
  disconnectedAt: number | null;
  grace: ReturnType<typeof setTimeout> | null;
  /** Jobs sent down its stream that it has not acknowledged, sent again when it reconnects. */
  readonly unacked: Map<Ulid, Unacked>;
  /**
   * A job went unacknowledged for too long, so its stream may be delivering nothing although it
   * looks open; no turn goes there until the runner acknowledges a job or connects again.
   */
  unconfirmed: boolean;
}

interface Unacked {
  readonly job: TurnJob;
  timer: ReturnType<typeof setTimeout>;
}

interface Pending {
  readonly runner: Name;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class RunnerProtocolError extends Error {}

/** A request a runner could not take: it is not connected, went away, or did not answer in time. */
export class RunnerAwayError extends Error {}

const SILENT: HostLog = { info() {}, warn() {}, error() {} };
const DEFAULT_GRACE_MS = 2 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;
/** A steer or a stop is answered at once by a runner that has the turn; waiting longer is pointless. */
const CONTROL_TIMEOUT_MS = 15_000;
/** A file read is a few git calls and up to 8 MB on the way back, which someone is waiting for. */
const FILE_TIMEOUT_MS = 60_000;
/** A sweep is a few git calls and a removal per citizen who took part in the conversation. */
const SWEEP_TIMEOUT_MS = 2 * 60_000;
/** A runner acknowledges a job as it arrives, before preparing anything. */
const DEFAULT_ACK_TIMEOUT_MS = 30_000;

/**
 * The runners connected to the board server, and the scheduler's way to them. It places each
 * queued turn on a runner, the one its project lives on or, in the society scope, the one its
 * session lives on, sends it the job, and resolves when the outcome is recorded. It also lands
 * tasks on their project's runner, reads files from their branches there and lists what the
 * branches changed, and asks a runner for a CLI's models.
 */
export class RunnerHub implements TurnRunner {
  private readonly board: Board;
  private readonly host: TurnHost;
  private readonly version: string;
  private readonly graceMs: number;
  private readonly requestTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly now: () => Date;
  private readonly log: HostLog;
  private readonly seats = new Map<Name, Seat>();
  /** When this hub started, which counts as when a runner that has not connected since went away. */
  private readonly startedAt: number;
  private readonly pending = new Map<string, Pending>();
  /** Disconnects being recorded, which `close` waits for. */
  private readonly detaching = new Set<Promise<void>>();
  private readonly runnerListeners = new Set<(runner: Name) => void>();

  constructor(options: RunnerHubOptions) {
    this.board = options.board;
    this.host = options.host;
    this.version = options.version;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? SILENT;
    this.startedAt = this.now().getTime();
  }

  /** Runners with a stream open now. */
  get connected(): Name[] {
    return [...this.seats.values()]
      .filter((seat) => seat.send !== null)
      .map((seat) => seat.name)
      .toSorted();
  }

  /** Conversations a connected runner keeps warm, as session keys. */
  get residentPairs(): string[] {
    return [...this.seats.values()]
      .filter((seat) => seat.send !== null)
      .flatMap((seat) => [...seat.warm])
      .toSorted();
  }

  // -------------------------------------------------------------------------------------------
  // The protocol, as the server's routes call it
  // -------------------------------------------------------------------------------------------

  /** The jobs sent to a runner that it has not acknowledged yet. */
  unacknowledged(runner: Name): Ulid[] {
    return [...(this.seats.get(runner)?.unacked.keys() ?? [])];
  }

  /**
   * A runner registers, first or again. A turn in flight it still runs, or whose job it never
   * acknowledged, carries on, the latter sent again once its stream opens, since a job written
   * into a stream that had stopped delivering never arrived; one it took and no longer runs,
   * because it restarted, ends as failed.
   */
  async register(name: Name, hello: RunnerHello): Promise<RunnerWelcome> {
    if (hello.protocol !== RUNNER_PROTOCOL) {
      throw new RunnerProtocolError(
        `runner protocol ${hello.protocol} is not ${RUNNER_PROTOCOL}; upgrade the runner or the server`,
      );
    }
    const seat = this.seats.get(name);
    if (seat === undefined) {
      this.seats.set(name, {
        name,
        hello,
        send: null,
        inUse: 0,
        warm: new Set(),
        disconnectedAt: null,
        grace: null,
        unacked: new Map(),
        unconfirmed: false,
      });
    } else {
      seat.hello = hello;
      seat.warm = new Set();
    }
    const still = new Set(hello.turns);
    const unacked = this.seats.get(name)?.unacked ?? new Map<Ulid, Unacked>();
    for (const turnId of this.host.turnsOn(name)) {
      if (still.has(turnId)) {
        this.settle(unacked, turnId);
      } else if (!unacked.has(turnId)) {
        await this.host.abortTurn(turnId, `runner ${name} restarted during the turn`);
      }
    }
    await this.board.markRunner(name, {
      os: hello.os,
      clis: hello.clis,
      capabilities: hello.capabilities,
      version: hello.version,
    });
    this.runnerChanged(name);
    this.log.info(
      { runner: name, version: hello.version, clis: hello.clis, slots: hello.slots },
      "runner registered",
    );
    return { name, version: this.version };
  }

  /** A registered runner's stream opened. Returns what to call when it closes. */
  async attach(name: Name, send: RunnerSend): Promise<() => Promise<void>> {
    const seat = this.seats.get(name);
    if (seat === undefined) {
      throw new RunnerProtocolError(`runner ${name} must register before it streams`);
    }
    seat.send = send;
    seat.disconnectedAt = null;
    seat.unconfirmed = false;
    if (seat.grace !== null) {
      clearTimeout(seat.grace);
      seat.grace = null;
    }
    for (const { job } of seat.unacked.values()) {
      if (send({ type: "turn", job })) {
        this.expectAck(seat, job);
        this.log.info(
          { runner: name, turnId: job.turnId },
          "sent again a job the runner never took",
        );
      }
    }
    await this.board.markRunner(name, { status: "connected" });
    this.runnerChanged(name);
    return async () => {
      if (seat.send !== send) {
        return;
      }
      const detached = this.detach(seat).finally(() => {
        this.detaching.delete(detached);
      });
      this.detaching.add(detached);
      await detached;
    };
  }

  /**
   * Lets every runner go, as the server stops: streams count as closed from here on, and the
   * disconnects under way are recorded before this resolves.
   */
  async close(): Promise<void> {
    for (const seat of this.seats.values()) {
      seat.send = null;
      if (seat.grace !== null) {
        clearTimeout(seat.grace);
        seat.grace = null;
      }
      for (const { timer } of seat.unacked.values()) {
        clearTimeout(timer);
      }
    }
    await Promise.allSettled(this.detaching);
  }

  async turnEvents(runner: Name, turnId: Ulid, entries: readonly TranscriptEntry[]): Promise<void> {
    this.assertOwns(runner, turnId);
    await this.host.addEvents(turnId, entries);
  }

  /** A runner's word that a turn's job arrived, which also shows its stream delivers again. */
  received(runner: Name, turnId: Ulid): void {
    const seat = this.seats.get(runner);
    if (seat === undefined || !seat.unacked.has(turnId)) {
      return;
    }
    this.settle(seat.unacked, turnId);
    if (seat.unconfirmed) {
      seat.unconfirmed = false;
      this.log.info({ runner }, "runner is taking jobs again");
    }
  }

  async turnOutcome(runner: Name, turnId: Ulid, outcome: TurnOutcome): Promise<TurnAck> {
    this.assertOwns(runner, turnId);
    const ack = await this.host.closeTurn(turnId, outcome);
    return ack ?? { dropWorkspace: false };
  }

  answer(runner: Name, request: string, answer: RunnerAnswer): void {
    const pending = this.pending.get(request);
    if (pending === undefined || pending.runner !== runner) {
      return;
    }
    this.pending.delete(request);
    clearTimeout(pending.timer);
    if (answer.ok) {
      pending.resolve(answer.value);
    } else {
      pending.reject(new Error(answer.error));
    }
  }

  /**
   * The workspaces a runner holds, reported when its stream opens: those of conversations that
   * ended while it was away are swept there now, as a sweep at their end would have.
   */
  heldWorkspaces(runner: Name, workspaces: readonly HeldWorkspace[]): void {
    const seat = this.seats.get(runner);
    if (seat === undefined) {
      return;
    }
    const conversations = new Map<string, WorkspaceConversation>();
    for (const { conversation } of workspaces) {
      conversations.set(JSON.stringify(conversation), conversation);
    }
    for (const conversation of conversations.values()) {
      void this.board
        .conversationEnded(conversation)
        .then((ended) => (ended ? this.sweepOn(seat, conversation) : undefined))
        .catch((error: unknown) => {
          this.log.warn({ runner, conversation, error: String(error) }, "could not sweep");
        });
    }
  }

  warmChanged(runner: Name, warm: readonly string[]): void {
    const seat = this.seats.get(runner);
    if (seat !== undefined) {
      seat.warm = new Set(warm);
    }
    this.host.warmChanged(runner, warm);
  }

  /** Whether a runner may read and write an agent's home now: it has a turn of that agent in flight. */
  mayTouchHome(runner: Name, agent: Name): boolean {
    return this.host.hasTurnFor(runner, agent);
  }

  /** The turns in flight, and whether each one's runner can steer and stop it. */
  liveTurns(): RunningTurn[] {
    return this.host.runningTurns().map(({ runner, ...turn }) => {
      const seat = this.seats.get(runner);
      const connected = seat !== undefined && seat.send !== null;
      return {
        ...turn,
        steerable: connected && seat.hello.steerableClis.includes(turn.cli),
        stoppable: connected && seat.hello.stoppableClis.includes(turn.cli),
      };
    });
  }

  /**
   * Stops a turn in flight, as the user asked: its runner interrupts the CLI and the turn ends
   * `stopped`. False for a turn not in flight or on a runner that cannot stop it.
   */
  async stop(turnId: Ulid, by: Name): Promise<boolean> {
    const runner = this.host.runnerOf(turnId);
    const seat = runner === undefined ? undefined : this.seats.get(runner);
    const cli = this.host.runningTurns().find((turn) => turn.turnId === turnId)?.cli;
    if (seat === undefined || seat.send === null || cli === undefined) {
      return false;
    }
    if (!seat.hello.stoppableClis.includes(cli) || !this.host.requestStop(turnId, by)) {
      return false;
    }
    try {
      const answered = await this.request(
        seat,
        (request) => ({ type: "stop", request, turnId }),
        CONTROL_TIMEOUT_MS,
      );
      this.log.info({ turnId, runner: seat.name, by }, "turn stop requested");
      return answered === true;
    } catch (error) {
      this.log.warn({ turnId, error: String(error) }, "could not stop a turn");
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // The scheduler's runner
  // -------------------------------------------------------------------------------------------

  /**
   * A conversation ended: every connected runner removes its citizens' workspaces for it, and
   * those kept for holding work on no branch are recorded, which gives their citizens a closing
   * turn. A runner away now sweeps when it reports its workspaces on reconnecting.
   */
  async sweep(conversation: WorkspaceConversation): Promise<void> {
    await Promise.all(
      [...this.seats.values()]
        .filter((seat) => seat.send !== null)
        .map((seat) =>
          this.sweepOn(seat, conversation).catch((error: unknown) => {
            this.log.warn(
              { runner: seat.name, conversation, error: String(error) },
              "could not sweep",
            );
          }),
        ),
    );
  }

  /**
   * Delivers what arrived in a conversation into its turn in flight, when that turn's runner can
   * steer its CLI. `refused` leaves the wake to a turn of its own once this one ends.
   */
  async steer(conversation: {
    agent: Name;
    project: Name;
    thread?: Ulid;
    channel?: Name;
  }): Promise<SteerOutcome> {
    const turn = this.host.turnIn(conversation.agent, conversation.project, {
      thread: conversation.thread,
      channel: conversation.channel,
    });
    const seat = turn === null ? undefined : this.seats.get(turn.runner);
    if (turn === null || seat === undefined || seat.send === null) {
      return "refused";
    }
    if (!seat.hello.steerableClis.includes(turn.cli)) {
      return "refused";
    }
    const steer = await this.host.prepareSteer(turn.turnId);
    if (steer === "busy" || steer === "nothing") {
      return steer;
    }
    if (steer === "gone") {
      return "refused";
    }
    let accepted = false;
    try {
      accepted =
        (await this.request(
          seat,
          (request) => ({ type: "steer", request, turnId: turn.turnId, steer }),
          CONTROL_TIMEOUT_MS,
        )) === true;
    } catch (error) {
      this.log.warn({ turnId: turn.turnId, error: String(error) }, "could not steer a turn");
    }
    this.host.steerAnswered(turn.turnId, steer.id, accepted);
    if (accepted) {
      this.log.info({ ...conversation, turnId: turn.turnId }, "steered a turn in flight");
    }
    return accepted ? "sent" : "refused";
  }

  async assign(dispatch: TurnDispatch): Promise<TurnAssignment | null> {
    const agent = await this.board.readAgent(dispatch.agent).catch(() => null);
    if (agent === null) {
      return { refused: `no agent ${dispatch.agent}` };
    }
    if (agent.status === "retired") {
      return { refused: `${agent.name} is retired` };
    }
    if (agent.cli === null) {
      return { refused: `${agent.name} has no CLI binding` };
    }
    const cli = agent.cli;
    const free = (seat: Seat): boolean =>
      seat.send !== null &&
      !seat.unconfirmed &&
      seat.hello.clis.includes(cli) &&
      (seat.hello.slots === null || seat.inUse < seat.hello.slots);
    let chosen: Seat | undefined;
    if (dispatch.project === SOCIETY_SCOPE) {
      chosen = await this.pinnedSeat(agent.name, agent.homeRunner, cli, free);
    } else {
      const project = await this.board.readProject(dispatch.project);
      let home = project.runner;
      if (home === undefined) {
        const needs = new Set(project.requiredCapabilities);
        if (dispatch.thread?.task === true) {
          const task = await this.board
            .findTask(dispatch.thread.id)
            .then((found) => found.task)
            .catch(() => null);
          for (const capability of task?.requiredCapabilities ?? []) {
            needs.add(capability);
          }
        }
        const offers = (seat: Seat): boolean =>
          [...needs].every((capability) => seat.hello.capabilities.includes(capability));
        const candidate = [this.homeSeat(agent.homeRunner), ...this.byLoad()].find(
          (seat): seat is Seat => seat !== undefined && free(seat) && offers(seat),
        );
        if (candidate === undefined) {
          return null;
        }
        home = await this.board.placeProject(project.slug, candidate.name);
        if (home === candidate.name) {
          this.log.info({ project: project.slug, runner: home }, "project placed");
        }
      }
      const seat = this.seats.get(home);
      chosen = seat !== undefined && free(seat) ? seat : undefined;
    }
    if (chosen === undefined) {
      return null;
    }
    chosen.inUse += 1;
    return { runner: chosen.name };
  }

  async runTurn(dispatch: TurnDispatch, assignment: TurnAssignment): Promise<TurnRecord> {
    if ("refused" in assignment) {
      return this.host.refuseTurn(dispatch, "none", assignment.refused);
    }
    const seat = this.seats.get(assignment.runner);
    let turnId: Ulid | null = null;
    try {
      if (seat === undefined) {
        return await this.host.refuseTurn(dispatch, assignment.runner, "the runner is gone");
      }
      const opened = await this.host.openTurn(dispatch, this.seatView(seat));
      if ("failed" in opened) {
        return opened.failed;
      }
      if (seat.send === null || !seat.send({ type: "turn", job: opened.job })) {
        await this.host.abortTurn(
          opened.job.turnId,
          `runner ${seat.name} went away before the turn`,
        );
      } else {
        this.expectAck(seat, opened.job);
      }
      turnId = opened.job.turnId;
      return await opened.ended;
    } finally {
      if (seat !== undefined) {
        seat.inUse = Math.max(0, seat.inUse - 1);
        if (turnId !== null) {
          this.settle(seat.unacked, turnId);
        }
      }
    }
  }

  async completeTask(project: Name, taskId: Ulid): Promise<"done" | "deferred"> {
    const { task } = await this.board.findTask(taskId);
    if (!task.completing) {
      return "done";
    }
    if (task.onDone === "none") {
      await this.board.finishCompletion(SYSTEM_ACTOR, {
        taskId,
        ok: true,
        detail: "no completion effect",
      });
      return "done";
    }
    const record = await this.board.readProject(project);
    const branch = `task/${taskId}`;
    const pull = task.onDone === "ghpr" ? task.pullRequest : undefined;
    if (task.onDone === "ghpr" && pull === undefined) {
      await this.board.finishCompletion(SYSTEM_ACTOR, {
        taskId,
        ok: false,
        detail: "no pull request is linked to the task",
      });
      return "done";
    }
    let outcome = { ok: true, detail: "nothing to land, since the task left no branch" };
    if (record.runner !== undefined) {
      const seat = this.seats.get(record.runner);
      if (seat === undefined || seat.send === null) {
        return "deferred";
      }
      try {
        outcome = MergeOutcomeSchema.parse(
          await this.request(seat, (request) => ({
            type: "land",
            request,
            land: {
              repo: projectRepo(record),
              branch,
              ...(pull === undefined
                ? {}
                : {
                    pullRequest: {
                      url: pull.url,
                      ...(pull.subject === undefined ? {} : { subject: pull.subject }),
                      ...(pull.body === undefined ? {} : { body: pull.body }),
                    },
                  }),
            },
          })),
        );
      } catch (error) {
        this.log.warn({ project, taskId, error: String(error) }, "landing deferred");
        return "deferred";
      }
    }
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
    return "done";
  }

  /**
   * One path on a branch of a project's repository, read on the runner the project lives on.
   * NOT_FOUND when the project has no runner yet or the branch or the path does not exist, and
   * `RunnerAwayError` while its runner is away.
   */
  async readBranch(project: Name, branch: string, path: string): Promise<BranchFile> {
    const { seat, repo } = await this.projectSeat(project, "branchReads", "read files");
    const file = BranchFileSchema.nullable().parse(
      await this.request(
        seat,
        (request) => ({ type: "file", request, read: { repo, branch, path } }),
        FILE_TIMEOUT_MS,
      ),
    );
    if (file === null) {
      throw new BoardError("NOT_FOUND", `${branch} has no ${path === "" ? "commit" : path}`);
    }
    return file;
  }

  /**
   * What a branch of a project's repository changed since it left the default branch, listed on
   * the runner the project lives on, with the same refusals as `readBranch`.
   */
  async branchChanges(project: Name, branch: string): Promise<BranchChanges> {
    const { seat, repo } = await this.projectSeat(project, "branchChanges", "list changes");
    const changes = BranchChangesSchema.nullable().parse(
      await this.request(
        seat,
        (request) => ({ type: "changes", request, read: { repo, branch } }),
        FILE_TIMEOUT_MS,
      ),
    );
    if (changes === null) {
      throw new BoardError("NOT_FOUND", `${project} has no ${branch} yet`);
    }
    return changes;
  }

  /** The models a CLI offers, asked of a connected runner that has it; none when no runner has it. */
  /**
   * The connected runner a model list for `cli` comes from: the first of `prefer` that has the CLI,
   * else the least busy that does; null when no connected runner has it.
   */
  modelRunner(cli: CliKind, prefer: readonly Name[] = []): Name | null {
    const able = (seat: Seat | undefined): seat is Seat =>
      seat !== undefined && seat.send !== null && seat.hello.clis.includes(cli);
    const preferred = prefer.map((name) => this.seats.get(name)).find(able);
    return (preferred ?? this.byLoad().find(able))?.name ?? null;
  }

  /** The models `cli` lists on a runner, `modelRunner`'s choice when none is named. */
  async models(cli: CliKind, runner?: Name): Promise<ModelOption[]> {
    const name = runner ?? this.modelRunner(cli);
    const seat = name === null ? undefined : this.seats.get(name);
    if (seat === undefined || seat.send === null || !seat.hello.clis.includes(cli)) {
      throw new RunnerAwayError(
        runner === undefined
          ? `no connected runner has ${cli}`
          : `runner ${runner} is not connected with ${cli}`,
      );
    }
    return ModelListSchema.parse(
      await this.request(seat, (request) => ({ type: "models", request, cli })),
    );
  }

  /** Calls `listener` whenever a runner registers, connects, or goes away. */
  onRunnerChange(listener: (runner: Name) => void): void {
    this.runnerListeners.add(listener);
  }

  private runnerChanged(runner: Name): void {
    for (const listener of this.runnerListeners) {
      listener(runner);
    }
  }

  // -------------------------------------------------------------------------------------------

  /**
   * Waits for a runner to acknowledge a job. One that does not in time may be behind a stream that
   * looks open but delivers nothing, as when its machine's network stops passing traffic, so no
   * more turns go to it until it acknowledges or connects again; the turns it has carry on, since
   * they report by posts.
   */
  private expectAck(seat: Seat, job: TurnJob): void {
    const previous = seat.unacked.get(job.turnId);
    if (previous !== undefined) {
      clearTimeout(previous.timer);
    }
    const timer = setTimeout(() => {
      if (!seat.unacked.has(job.turnId) || seat.unconfirmed || seat.send === null) {
        return;
      }
      seat.unconfirmed = true;
      this.log.warn(
        { runner: seat.name, turnId: job.turnId, waitedMs: this.ackTimeoutMs },
        "runner has not acknowledged a job; no more turns go to it until it does or reconnects",
      );
    }, this.ackTimeoutMs);
    timer.unref?.();
    seat.unacked.set(job.turnId, { job, timer });
  }

  private settle(unacked: Map<Ulid, Unacked>, turnId: Ulid): void {
    const entry = unacked.get(turnId);
    if (entry !== undefined) {
      clearTimeout(entry.timer);
      unacked.delete(turnId);
    }
  }

  private async detach(seat: Seat): Promise<void> {
    seat.send = null;
    this.runnerChanged(seat.name);
    seat.disconnectedAt = this.now().getTime();
    for (const [id, pending] of this.pending) {
      if (pending.runner === seat.name) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new RunnerAwayError(`runner ${seat.name} disconnected`));
      }
    }
    await this.board.markRunner(seat.name, { status: "disconnected" }).catch((error: unknown) => {
      this.log.warn({ runner: seat.name, error: String(error) }, "could not record a disconnect");
    });
    // Events and outcomes travel as posts, so a dropped stream alone ends no turn; a runner that
    // stays away has its turns ended, which frees their conversations.
    seat.grace = setTimeout(() => {
      seat.grace = null;
      if (seat.send !== null) {
        return;
      }
      for (const turnId of this.host.turnsOn(seat.name)) {
        void this.host.abortTurn(
          turnId,
          seat.unacked.has(turnId)
            ? `the turn never reached runner ${seat.name}, which went away`
            : `runner ${seat.name} went away during the turn`,
        );
      }
    }, this.graceMs);
    seat.grace.unref?.();
    this.log.warn({ runner: seat.name }, "runner disconnected");
  }

  /**
   * Where a citizen's work outside any project goes: the runner it is pinned to, waiting while that
   * runner is busy or away for less than the grace period. A citizen not pinned yet is pinned to the
   * least busy runner that can take it, and one whose runner has been gone longer, or lacks its CLI,
   * is moved there, starting its conversations afresh while its home follows it.
   */
  private async pinnedSeat(
    agent: Name,
    pinned: Name | undefined,
    cli: CliKind,
    free: (seat: Seat) => boolean,
  ): Promise<Seat | undefined> {
    if (pinned !== undefined) {
      const seat = this.seats.get(pinned);
      if (seat !== undefined && seat.send !== null && seat.hello.clis.includes(cli)) {
        return free(seat) ? seat : undefined;
      }
      const lacksCli = seat !== undefined && seat.send !== null;
      if (!lacksCli && this.awayFor(pinned) < this.graceMs) {
        return undefined;
      }
    }
    const candidate = this.byLoad().find(free);
    if (candidate === undefined) {
      return undefined;
    }
    const home = await this.board.pinAgent(agent, candidate.name, pinned);
    if (home === candidate.name) {
      this.log.info(
        { agent, runner: home, ...(pinned === undefined ? {} : { from: pinned }) },
        pinned === undefined ? "citizen pinned" : "citizen moved",
      );
      return candidate;
    }
    const seat = this.seats.get(home);
    return seat !== undefined && free(seat) ? seat : undefined;
  }

  /** How long a runner has been away: since it disconnected, or since this server started when it has not connected to it. */
  private awayFor(name: Name): number {
    const seat = this.seats.get(name);
    if (seat?.send !== null && seat !== undefined) {
      return 0;
    }
    return this.now().getTime() - (seat?.disconnectedAt ?? this.startedAt);
  }

  private homeSeat(name: Name | undefined): Seat | undefined {
    return name === undefined ? undefined : this.seats.get(name);
  }

  /** Connected runners with the fewest turns in use first, then by name. */
  private byLoad(): Seat[] {
    return [...this.seats.values()]
      .filter((seat) => seat.send !== null)
      .toSorted((a, b) => a.inUse - b.inUse || a.name.localeCompare(b.name));
  }

  private seatView(seat: Seat): RunnerSeat {
    return {
      name: seat.name,
      residentClis: seat.hello.residentClis,
      steerableClis: seat.hello.steerableClis,
      stoppableClis: seat.hello.stoppableClis,
      isWarm: (key) => seat.warm.has(key),
    };
  }

  /**
   * The connected runner a project lives on and where its code is, for a request only runners that
   * said so at registration answer: one from before would skip it and leave the reader waiting.
   */
  private async projectSeat(
    project: Name,
    able: "branchReads" | "branchChanges",
    what: string,
  ): Promise<{ seat: Seat; repo: ProjectRepo }> {
    const record = await this.board.readProject(project);
    if (record.runner === undefined) {
      throw new BoardError(
        "NOT_FOUND",
        `${project} has no repository yet, since no turn has run there`,
      );
    }
    const seat = this.seats.get(record.runner);
    if (seat === undefined || seat.send === null) {
      throw new RunnerAwayError(
        `runner ${record.runner}, where ${project} lives, is not connected`,
      );
    }
    if (!seat.hello[able]) {
      throw new BoardError(
        "INVALID_STATE",
        `runner ${seat.name}, where ${project} lives, cannot ${what} yet; upgrade it`,
      );
    }
    return {
      seat,
      repo: projectRepo(record),
    };
  }

  private assertOwns(runner: Name, turnId: Ulid): void {
    const owner = this.host.runnerOf(turnId);
    if (owner !== undefined && owner !== runner) {
      throw new RunnerProtocolError(`turn ${turnId} is not ${runner}'s`);
    }
  }

  private async sweepOn(seat: Seat, conversation: WorkspaceConversation): Promise<void> {
    const { kept } = SweepResultSchema.parse(
      await this.request(
        seat,
        (request) => ({ type: "sweep", request, conversation }),
        SWEEP_TIMEOUT_MS,
      ),
    );
    for (const workspace of kept) {
      await this.board.recordLeftovers(workspace);
    }
  }

  private request(
    seat: Seat,
    message: (request: string) => RunnerMessage,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    const request = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request);
        reject(new RunnerAwayError(`runner ${seat.name} did not answer in time`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(request, { runner: seat.name, resolve, reject, timer });
      if (seat.send === null || !seat.send(message(request))) {
        this.pending.delete(request);
        clearTimeout(timer);
        reject(new RunnerAwayError(`runner ${seat.name} is not connected`));
      }
    });
  }
}
