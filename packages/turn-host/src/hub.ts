import { randomUUID } from "node:crypto";
import { BoardError, SYSTEM_ACTOR, type Actor, type Board } from "@stellaris/board-core";
import type { SteerOutcome, TurnAssignment, TurnRunner } from "@stellaris/scheduler";
import {
  BranchChangesSchema,
  BranchFileDiffSchema,
  CliQuotaSchema,
  BranchFileSchema,
  MergeOutcomeSchema,
  ModelListSchema,
  MOVE_PACK_LIMIT_BYTES,
  ProjectExportedSchema,
  ProjectImportedSchema,
  ProjectReleasedSchema,
  RUNNER_PROTOCOL,
  SOCIETY_SCOPE,
  SweepResultSchema,
  TurnImageSchema,
  type BranchChanges,
  type BranchFile,
  type BranchFileDiff,
  type CliKind,
  type CliQuota,
  type ModelOption,
  type Name,
  type ProjectMoved,
  type RepoRefs,
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
  type ImageRefusal,
  type Ulid,
  type HeldWork,
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

/**
 * A move refused because the runner the project lives on is away, so nothing can travel: the
 * user may move the project without its branches, which stay on that runner.
 */
export class MoveSourceAwayError extends Error {}

/** A move under way: its repository on the server, once made, and how far it has come. */
interface Move {
  id: Ulid | null;
  from: Name | null;
  readonly to: Name;
  phase: "checking" | "export" | "import" | "recording";
}

const SILENT: HostLog = { info() {}, warn() {}, error() {} };
const DEFAULT_GRACE_MS = 2 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;
/** A steer or a stop is answered at once by a runner that has the turn; waiting longer is pointless. */
const CONTROL_TIMEOUT_MS = 15_000;
/** A file read is a few git calls and up to 8 MB on the way back, which someone is waiting for. */
const FILE_TIMEOUT_MS = 60_000;
/** What a refusal of `upload_image` reads as: a file not there, one out of reach, one no image. */
const IMAGE_REFUSALS: Record<ImageRefusal, "NOT_FOUND" | "FORBIDDEN" | "VALIDATION"> = {
  missing: "NOT_FOUND",
  outside: "FORBIDDEN",
  not_image: "VALIDATION",
  too_big: "VALIDATION",
};
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
  /** The project being moved, by slug: none of its turns is placed and nothing lands there until it ends. */
  private readonly moving = new Map<Name, Move>();
  /** Turns of each project placed on a runner and not yet opened, which the board cannot see yet. */
  private readonly starting = new Map<Name, number>();

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
      gitIdentityMissing: hello.gitIdentityMissing ?? null,
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
    place?: Name;
  }): Promise<SteerOutcome> {
    const turn = this.host.turnIn(conversation.agent, conversation.project, {
      thread: conversation.thread,
      channel: conversation.channel,
      place: conversation.place,
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
      if (this.moving.has(dispatch.project)) {
        return null;
      }
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
    if (dispatch.project !== SOCIETY_SCOPE) {
      this.starting.set(dispatch.project, (this.starting.get(dispatch.project) ?? 0) + 1);
    }
    return { runner: chosen.name };
  }

  async runTurn(dispatch: TurnDispatch, assignment: TurnAssignment): Promise<TurnRecord> {
    if ("refused" in assignment) {
      return this.host.refuseTurn(dispatch, "none", assignment.refused);
    }
    const seat = this.seats.get(assignment.runner);
    let turnId: Ulid | null = null;
    // Once the turn is open the board sees it, which a move checks for; until then the hub counts it.
    let placed = dispatch.project !== SOCIETY_SCOPE;
    const opening = (): void => {
      if (placed) {
        placed = false;
        const left = (this.starting.get(dispatch.project) ?? 1) - 1;
        if (left > 0) {
          this.starting.set(dispatch.project, left);
        } else {
          this.starting.delete(dispatch.project);
        }
      }
    };
    try {
      if (seat === undefined) {
        return await this.host.refuseTurn(dispatch, assignment.runner, "the runner is gone");
      }
      const opened = await this.host.openTurn(dispatch, this.seatView(seat)).finally(opening);
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
      opening();
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
    if (this.moving.has(project)) {
      return "deferred";
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
   * Closes the pull request of a `ghpr` task abandoned with one linked, on the runner its project
   * lives on, whose `gh` login reaches GitHub, and records how it went on the task; `deferred`
   * while that runner is away.
   */
  async closePullRequest(project: Name, taskId: Ulid): Promise<"done" | "deferred"> {
    const { task } = await this.board.findTask(taskId);
    const pull = task.pullRequest;
    if (
      task.status !== "abandoned" ||
      task.onDone !== "ghpr" ||
      pull === undefined ||
      pull.closed !== undefined
    ) {
      return "done";
    }
    if (this.moving.has(project)) {
      return "deferred";
    }
    const record = await this.board.readProject(project);
    let outcome = {
      ok: false,
      detail: `${project} lives on no runner yet, so none could close ${pull.url}`,
    };
    if (record.runner !== undefined) {
      const seat = this.seats.get(record.runner);
      if (seat === undefined || seat.send === null) {
        return "deferred";
      }
      try {
        outcome = MergeOutcomeSchema.parse(
          await this.request(seat, (request) => ({
            type: "close",
            request,
            close: {
              repo: projectRepo(record),
              url: pull.url,
              comment: `Closed by Stellaris: the task this pull request was opened for, "${task.title}", was abandoned.`,
            },
          })),
        );
      } catch (error) {
        this.log.warn({ project, taskId, error: String(error) }, "closing a pull request deferred");
        return "deferred";
      }
    }
    await this.board.recordPullRequestClosed(SYSTEM_ACTOR, {
      taskId,
      ok: outcome.ok,
      detail: outcome.detail,
    });
    return "done";
  }

  /**
   * Moves a project to another runner, which only the user does, carrying every branch and tag of
   * its repository: the project's turns, landings, and pull-request closes wait while it runs.
   * The old runner pushes to a repository on the server once no worktree of the project holds work
   * no branch does, the new runner clones it, and the board records the new runner only once that
   * runner holds every branch and tag at the commit the old one had; until then the project works
   * where it was. The server's repository goes as the move ends, and the old runner then removes
   * its copy. With the old runner away nothing can travel, so the move goes ahead only when the
   * user says `withoutBranches`, and the branches stay there.
   */
  async moveProject(
    actor: Actor,
    slug: Name,
    to: Name,
    options: { readonly withoutBranches?: boolean | undefined } = {},
  ): Promise<ProjectMoved> {
    const under = [...this.moving.keys()];
    if (under.length > 0) {
      throw new BoardError(
        "INVALID_STATE",
        `a move of ${under.join(", ")} is under way; try again once it ends`,
      );
    }
    const move: Move = { id: null, from: null, to, phase: "checking" };
    this.moving.set(slug, move);
    let source: Seat | undefined;
    let moved: { project: ProjectMoved["project"]; carried: number | null };
    try {
      if ((this.starting.get(slug) ?? 0) > 0) {
        throw new BoardError(
          "INVALID_STATE",
          `a turn of ${slug} is starting; try again once it has started and ended`,
        );
      }
      const { project, inPlay } = await this.board.prepareProjectMove(actor, slug, to);
      const from = project.runner;
      move.from = from;
      const target = this.seats.get(to);
      if (target === undefined || target.send === null) {
        throw new BoardError("INVALID_STATE", `runner ${to} is not connected`);
      }
      await this.assertCanHost(target, project, inPlay);
      source = this.seats.get(from);
      if (source === undefined || source.send === null) {
        if (options.withoutBranches !== true) {
          throw new MoveSourceAwayError(sourceAwayMessage(project, from, to, inPlay));
        }
        move.phase = "recording";
        const recorded = await this.board.recordProjectMove(actor, {
          slug,
          from,
          to,
          carried: null,
        });
        this.log.info({ project: slug, from, to }, "project moved without its branches");
        return { project: recorded, carried: null, released: null };
      }
      if (options.withoutBranches === true) {
        throw new BoardError(
          "INVALID_STATE",
          `runner ${from}, where ${slug} lives, is connected, so the move carries its branches`,
        );
      }
      if (!source.hello.projectMoves) {
        throw new BoardError(
          "INVALID_STATE",
          `runner ${from}, where ${slug} lives, cannot carry a project yet; upgrade it`,
        );
      }
      const repo = projectRepo(project);
      move.id = await this.board.openMoveRepo();
      const id = move.id;
      move.phase = "export";
      const exported = ProjectExportedSchema.parse(
        await this.request(source, (request) => ({
          type: "export",
          request,
          export: { move: id, repo },
        })).catch((error: unknown) => {
          throw new BoardError(
            "INVALID_STATE",
            `${from} could not send ${slug}: ${describe(error)}`,
          );
        }),
      );
      if (!exported.ok) {
        throw new BoardError(
          "INVALID_STATE",
          exported.held.length === 0
            ? `${slug}'s repository on ${from} is ${mebibytes(exported.bytes)}, more than a move carries (${mebibytes(MOVE_PACK_LIMIT_BYTES)})`
            : `${slug} cannot be moved while work no branch holds sits in its worktrees on ${from}: ${exported.held.map(heldLine).join("; ")}. Have each citizen commit it or clear it, then move again`,
        );
      }
      move.phase = "import";
      const imported = ProjectImportedSchema.parse(
        await this.request(target, (request) => ({
          type: "import",
          request,
          import: { move: id, repo, pullRequests: project.onDone === "ghpr" },
        })).catch((error: unknown) => {
          throw new BoardError("INVALID_STATE", `${to} could not take ${slug}: ${describe(error)}`);
        }),
      );
      move.phase = "recording";
      const differ = differentRefs(exported.refs, imported.refs);
      if (differ.length > 0) {
        await this.releaseOn(target, slug);
        throw new BoardError(
          "INVALID_STATE",
          `${slug} arrived on ${to} unlike it left ${from} (${differ.slice(0, 5).join(", ")}${differ.length > 5 ? ", …" : ""}); it stays on ${from}`,
        );
      }
      const carried = Object.keys(exported.refs).length;
      const recorded = await this.board
        .recordProjectMove(actor, { slug, from, to, carried })
        .catch(async (error: unknown) => {
          await this.releaseOn(target, slug);
          throw error;
        });
      this.log.info({ project: slug, from, to, carried }, "project moved");
      moved = { project: recorded, carried };
    } finally {
      this.moving.delete(slug);
      if (move.id !== null) {
        const id = move.id;
        await this.board.dropMoveRepo(id).catch((error: unknown) => {
          this.log.warn({ move: id, error: String(error) }, "could not remove a move's repository");
        });
      }
    }
    return { ...moved, released: await this.releaseOn(source, slug) };
  }

  /**
   * Whether a runner may reach a move's repository on the server: the old runner to push while it
   * exports, the new one to fetch while it imports. `unknown` for a move that is not under way.
   */
  moveAccess(runner: Name, id: string, push: boolean): "allowed" | "refused" | "unknown" {
    const move = [...this.moving.values()].find((each) => each.id !== null && each.id === id);
    if (move === undefined) {
      return "unknown";
    }
    const allowed = push
      ? move.phase === "export" && runner === move.from
      : move.phase === "import" && runner === move.to;
    return allowed ? "allowed" : "refused";
  }

  /** Refuses a runner that cannot take a project's turns: its members' CLIs, the capabilities, a git identity. */
  private async assertCanHost(
    seat: Seat,
    project: ProjectMoved["project"],
    inPlay: readonly { readonly requiredCapabilities: readonly string[] }[],
  ): Promise<void> {
    if (!seat.hello.projectMoves) {
      throw new BoardError(
        "INVALID_STATE",
        `runner ${seat.name} cannot take a project yet; upgrade it`,
      );
    }
    const lacking: string[] = [];
    for (const name of project.members) {
      const agent = await this.board.readAgent(name).catch(() => null);
      if (
        agent !== null &&
        agent.status === "active" &&
        agent.cli !== null &&
        !seat.hello.clis.includes(agent.cli)
      ) {
        lacking.push(`${agent.cli} for ${agent.name}`);
      }
    }
    const needs = new Set([
      ...project.requiredCapabilities,
      ...inPlay.flatMap((task) => task.requiredCapabilities),
    ]);
    const missing = [...needs].filter((each) => !seat.hello.capabilities.includes(each));
    if (missing.length > 0) {
      lacking.push(
        `the ${missing.length === 1 ? "capability" : "capabilities"} ${missing.join(", ")}`,
      );
    }
    const identity = seat.hello.gitIdentityMissing ?? [];
    if (identity.length > 0) {
      lacking.push(`a git ${identity.join(" and ")} for citizens' commits`);
    }
    if (lacking.length > 0) {
      throw new BoardError(
        "INVALID_STATE",
        `runner ${seat.name} cannot take ${project.slug}: it lacks ${lacking.join("; ")}`,
      );
    }
  }

  /** Asks a runner to remove its copy of a project that lives elsewhere now; how that went, never a throw. */
  private async releaseOn(
    seat: Seat | undefined,
    slug: Name,
  ): Promise<{ ok: boolean; detail: string } | null> {
    if (seat === undefined) {
      return null;
    }
    try {
      const released = ProjectReleasedSchema.parse(
        await this.request(
          seat,
          (request) => ({ type: "release", request, release: { slug } }),
          SWEEP_TIMEOUT_MS,
        ),
      );
      return {
        ok: true,
        detail: `${seat.name} removed ${released.worktrees} worktree(s)${released.clone ? " and its clone" : ""}`,
      };
    } catch (error) {
      this.log.warn(
        { runner: seat.name, project: slug, error: String(error) },
        "could not release a project",
      );
      return { ok: false, detail: `${seat.name} kept its copy of ${slug}: ${describe(error)}` };
    }
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

  /**
   * What a branch of a project's repository did to one file since it left the default branch, read
   * on the runner the project lives on, with the same refusals as `branchChanges`.
   */
  async branchDiff(project: Name, branch: string, path: string): Promise<BranchFileDiff> {
    const { seat, repo } = await this.projectSeat(project, "branchChanges", "list changes");
    const diff = BranchFileDiffSchema.nullable().parse(
      await this.request(
        seat,
        (request) => ({ type: "diff", request, read: { repo, branch, path } }),
        FILE_TIMEOUT_MS,
      ),
    );
    if (diff === null) {
      throw new BoardError("NOT_FOUND", `${branch} did not change ${path}`);
    }
    return diff;
  }

  /**
   * The image file a citizen's turn names for `upload_image`, read on the runner that turn runs on,
   * which refuses a file outside the turn's worktree, its citizen's home, and the system temp
   * folder, and anything but a PNG, JPEG, GIF, or WebP within the size limit; each refusal comes
   * back as a `BoardError` in the runner's words.
   */
  async readTurnImage(actor: Actor, file: string): Promise<Uint8Array> {
    const turn = this.host
      .runningTurns()
      .find(
        (each) =>
          each.agent === actor.name &&
          each.scope === actor.scope &&
          each.thread === actor.thread &&
          each.channel === actor.channel &&
          each.place === actor.place,
      );
    if (turn === undefined) {
      throw new BoardError(
        "INVALID_STATE",
        `${actor.name} has no turn running in this conversation to read ${file} from`,
      );
    }
    const seat = this.seats.get(turn.runner);
    if (seat === undefined || seat.send === null) {
      throw new RunnerAwayError(`runner ${turn.runner}, where the turn runs, is not connected`);
    }
    if (!seat.hello.imageReads) {
      throw new BoardError(
        "INVALID_STATE",
        `runner ${seat.name}, where the turn runs, cannot read images yet; upgrade it`,
      );
    }
    const image = TurnImageSchema.nullable().parse(
      await this.request(
        seat,
        (request) => ({ type: "image", request, read: { turnId: turn.turnId, path: file } }),
        FILE_TIMEOUT_MS,
      ),
    );
    if (image === null) {
      throw new BoardError("INVALID_STATE", `the turn is no longer running on runner ${seat.name}`);
    }
    if (image.kind === "refused") {
      throw new BoardError(IMAGE_REFUSALS[image.why], image.detail);
    }
    return Buffer.from(image.content, "base64");
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

  /**
   * A CLI's plan quota, read on a runner without a turn and recorded on the runner's record.
   * Refused for a runner not connected with the CLI, and for one from before quota reads, which
   * would skip the request and leave the reader waiting.
   */
  async quota(runner: Name, cli: CliKind): Promise<CliQuota> {
    const seat = this.seats.get(runner);
    if (seat === undefined || seat.send === null || !seat.hello.clis.includes(cli)) {
      throw new RunnerAwayError(`runner ${runner} is not connected with ${cli}`);
    }
    if (!seat.hello.quotaReads) {
      throw new BoardError("INVALID_STATE", `runner ${runner} cannot read quotas yet; upgrade it`);
    }
    const quota = CliQuotaSchema.nullable().parse(
      await this.request(seat, (request) => ({ type: "quota", request, cli }), FILE_TIMEOUT_MS),
    );
    if (quota === null) {
      throw new BoardError("NOT_FOUND", `${cli} on runner ${runner} cannot read its quota`);
    }
    await this.board.recordQuota(runner, cli, quota);
    return quota;
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

/** An error's own message, for a refusal the user reads. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** One worktree's work no branch holds, as a refusal names it. */
function heldLine(held: HeldWork): string {
  const where =
    held.conversation === null
      ? "its own worktree"
      : held.conversation.kind === "thread"
        ? `thread ${held.conversation.id}`
        : held.conversation.kind === "channel"
          ? `channel ${held.conversation.name}`
          : `the channels of ${held.conversation.project}`;
  const parts = [
    held.uncommitted > 0 ? `${held.uncommitted} uncommitted file(s)` : "",
    held.onNoBranch > 0 ? `${held.onNoBranch} commit(s) on no branch` : "",
  ].filter((part) => part !== "");
  return `${held.agent}, ${where}: ${parts.join(" and ")}`;
}

/** The refs two lists disagree on, by name: missing from one, or at another object. */
function differentRefs(left: RepoRefs, right: RepoRefs): string[] {
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...names].filter((name) => left[name] !== right[name]).toSorted();
}

/** What stays on an away runner when a project moves without its branches. */
function sourceAwayMessage(
  project: ProjectMoved["project"],
  from: Name,
  to: Name,
  inPlay: readonly { readonly id: string }[],
): string {
  const stays = [
    "its local branches and worktrees",
    project.repo === null
      ? `its whole history, since ${project.slug} has no remote (${to} would start an empty repository)`
      : "",
    inPlay.length === 0
      ? ""
      : `the work of ${inPlay.length} task(s) in play (${inPlay.map((task) => task.id).join(", ")})`,
  ].filter((part) => part !== "");
  return `runner ${from}, where ${project.slug} lives, is not connected, so nothing can travel. Staying on ${from}: ${stays.join("; ")}. Move it without them to go ahead`;
}
