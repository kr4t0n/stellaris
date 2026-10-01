import { randomUUID } from "node:crypto";
import { SYSTEM_ACTOR, type Board } from "@stellaris/board-core";
import type { TurnAssignment, TurnRunner } from "@stellaris/scheduler";
import {
  MergeOutcomeSchema,
  ModelListSchema,
  RUNNER_PROTOCOL,
  SOCIETY_SCOPE,
  type CliKind,
  type ModelOption,
  type Name,
  type RunnerAnswer,
  type RunnerHello,
  type RunnerMessage,
  type RunnerWelcome,
  type TranscriptEntry,
  type TurnAck,
  type TurnDispatch,
  type TurnOutcome,
  type TurnRecord,
  type Ulid,
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
}

interface Pending {
  readonly runner: Name;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class RunnerProtocolError extends Error {}

const SILENT: HostLog = { info() {}, warn() {}, error() {} };
const DEFAULT_GRACE_MS = 2 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;

/**
 * The runners connected to the board server, and the scheduler's way to them. It places each
 * queued turn on a runner, the one its project lives on or, in the society scope, the one its
 * session lives on, sends it the job, and resolves when the outcome is recorded. It also lands
 * tasks on their project's runner and asks a runner for a CLI's models.
 */
export class RunnerHub implements TurnRunner {
  private readonly board: Board;
  private readonly host: TurnHost;
  private readonly version: string;
  private readonly graceMs: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => Date;
  private readonly log: HostLog;
  private readonly seats = new Map<Name, Seat>();
  private readonly pending = new Map<string, Pending>();
  /** Disconnects being recorded, which `close` waits for. */
  private readonly detaching = new Set<Promise<void>>();

  constructor(options: RunnerHubOptions) {
    this.board = options.board;
    this.host = options.host;
    this.version = options.version;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? SILENT;
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

  /**
   * A runner registers, first or again. Its turns in flight that it no longer runs, because it
   * restarted, end as failed.
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
      });
    } else {
      seat.hello = hello;
      seat.warm = new Set();
    }
    const still = new Set(hello.turns);
    for (const turnId of this.host.turnsOn(name)) {
      if (!still.has(turnId)) {
        await this.host.abortTurn(turnId, `runner ${name} restarted during the turn`);
      }
    }
    await this.board.markRunner(name, {
      os: hello.os,
      clis: hello.clis,
      capabilities: hello.capabilities,
    });
    this.log.info({ runner: name, clis: hello.clis, slots: hello.slots }, "runner registered");
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
    if (seat.grace !== null) {
      clearTimeout(seat.grace);
      seat.grace = null;
    }
    await this.board.markRunner(name, { status: "connected" });
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
    }
    await Promise.allSettled(this.detaching);
  }

  async turnEvents(runner: Name, turnId: Ulid, entries: readonly TranscriptEntry[]): Promise<void> {
    this.assertOwns(runner, turnId);
    this.host.addEvents(turnId, entries);
  }

  async turnOutcome(runner: Name, turnId: Ulid, outcome: TurnOutcome): Promise<TurnAck> {
    this.assertOwns(runner, turnId);
    const ack = await this.host.closeTurn(turnId, outcome);
    return ack ?? { dropWorktree: false };
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

  // -------------------------------------------------------------------------------------------
  // The scheduler's runner
  // -------------------------------------------------------------------------------------------

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
    if (
      dispatch.project === SOCIETY_SCOPE &&
      !(await this.board.readRole(agent.role)).societyScope
    ) {
      return { refused: `${agent.role} cannot take society-scope turns` };
    }
    const cli = agent.cli;
    const free = (seat: Seat): boolean =>
      seat.send !== null &&
      seat.hello.clis.includes(cli) &&
      (seat.hello.slots === null || seat.inUse < seat.hello.slots);
    let chosen: Seat | undefined;
    if (dispatch.project === SOCIETY_SCOPE) {
      const sessions = await this.board.readSessions(
        agent.name,
        SOCIETY_SCOPE,
        dispatch.thread?.id,
      );
      const own = sessions.runner === undefined ? undefined : this.seats.get(sessions.runner);
      if (own !== undefined && own.send === null && this.recentlyAway(own)) {
        // Its session's runner was here a moment ago, as across a restart: wait rather than start afresh.
        return null;
      }
      if (own !== undefined && own.send !== null && own.hello.clis.includes(cli) && !free(own)) {
        // Its session's runner is busy: wait for a slot there rather than lose the conversation.
        return null;
      }
      chosen = [own, this.homeSeat(agent.homeRunner), ...this.byLoad()].find(
        (seat): seat is Seat => seat !== undefined && free(seat),
      );
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
      }
      return await opened.ended;
    } finally {
      if (seat !== undefined) {
        seat.inUse = Math.max(0, seat.inUse - 1);
      }
    }
  }

  async completeTask(project: Name, taskId: Ulid): Promise<"done" | "deferred"> {
    const { task } = await this.board.findTask(taskId);
    if (!task.completing) {
      return "done";
    }
    if (task.onDone !== "merge") {
      await this.board.finishCompletion(SYSTEM_ACTOR, {
        taskId,
        ok: true,
        detail: "no completion effect",
      });
      return "done";
    }
    const record = await this.board.readProject(project);
    const branch = `task/${taskId}`;
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
              repo: { slug: record.slug, origin: record.repo, defaultBranch: record.defaultBranch },
              branch,
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

  /** The models a CLI offers, asked of a connected runner that has it; none when no runner has it. */
  async models(cli: CliKind): Promise<ModelOption[]> {
    const seat = this.byLoad().find((each) => each.send !== null && each.hello.clis.includes(cli));
    if (seat === undefined) {
      throw new Error(`no connected runner has ${cli}`);
    }
    return ModelListSchema.parse(
      await this.request(seat, (request) => ({ type: "models", request, cli })),
    );
  }

  // -------------------------------------------------------------------------------------------

  private async detach(seat: Seat): Promise<void> {
    seat.send = null;
    seat.disconnectedAt = this.now().getTime();
    for (const [id, pending] of this.pending) {
      if (pending.runner === seat.name) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error(`runner ${seat.name} disconnected`));
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
        void this.host.abortTurn(turnId, `runner ${seat.name} went away during the turn`);
      }
    }, this.graceMs);
    seat.grace.unref?.();
    this.log.warn({ runner: seat.name }, "runner disconnected");
  }

  private recentlyAway(seat: Seat): boolean {
    return (
      seat.disconnectedAt !== null && this.now().getTime() - seat.disconnectedAt < this.graceMs
    );
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
      isWarm: (key) => seat.warm.has(key),
    };
  }

  private assertOwns(runner: Name, turnId: Ulid): void {
    const owner = this.host.runnerOf(turnId);
    if (owner !== undefined && owner !== runner) {
      throw new RunnerProtocolError(`turn ${turnId} is not ${runner}'s`);
    }
  }

  private request(seat: Seat, message: (request: string) => RunnerMessage): Promise<unknown> {
    const request = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request);
        reject(new Error(`runner ${seat.name} did not answer in time`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(request, { runner: seat.name, resolve, reject, timer });
      if (seat.send === null || !seat.send(message(request))) {
        this.pending.delete(request);
        clearTimeout(timer);
        reject(new Error(`runner ${seat.name} is not connected`));
      }
    });
  }
}
