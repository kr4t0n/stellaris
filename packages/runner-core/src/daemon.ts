import { setTimeout as wait } from "node:timers/promises";
import {
  RUNNER_PROTOCOL,
  sameConversation,
  workspaceConversationOf,
  type AgentEvent,
  type CliKind,
  type HeldWorkspace,
  type Name,
  type RunnerMessage,
  type TranscriptEntry,
  type TurnAck,
  type TurnJob,
  type TurnOutcome,
} from "@stellaris/shared";
import { RunnerClient, RunnerHttpError } from "./client.js";
import { TurnControl } from "./control.js";
import { runnerOs } from "./enroll.js";
import { describeError } from "./errors.js";
import { TurnExecutor, type RunnerLog } from "./executor.js";
import { HomeSync } from "./home.js";
import type { GitOps } from "./git.js";
import { RunnerLayout } from "./layout.js";
import type { AgentBackend } from "./types.js";
import { TreeCopy } from "./sync.js";
import { ZERO_USAGE } from "./types.js";

export interface RunnerDaemonOptions {
  readonly client: RunnerClient;
  readonly executor: TurnExecutor;
  readonly layout: RunnerLayout;
  readonly version: string;
  /** Turns this machine runs at once, or null for no limit. */
  readonly slots: number | null;
  readonly capabilities?: readonly string[] | undefined;
  readonly log?: RunnerLog | undefined;
  /** How long to wait before connecting again after the stream ends; doubles up to 15 seconds. */
  readonly retryMs?: number | undefined;
  /** How long a turn's steps and outcome are posted again while the server is out of reach. */
  readonly postForMs?: number | undefined;
}

const SILENT: RunnerLog = { info() {}, warn() {}, error() {} };
const MAX_RETRY_MS = 15_000;
/** Long enough to outlast a server restart or a node's network coming back. */
const POST_FOR_MS = 15 * 60_000;
/** A job's receipt matters only until the stream is known to work again, as a reconnect says. */
const RECEIPT_ATTEMPTS = 3;
/** Steps of a turn travel in small batches, so the live picture lags by at most this much. */
const EVENT_BATCH_MS = 100;

/**
 * Waits, or until `signal` aborts. The timer holds the process open: while the server is away and
 * no turn runs, it is all that does, and an unref'd one let the runner exit in its first wait.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return wait(ms, undefined, signal === undefined ? {} : { signal }).catch(() => undefined);
}

/** Whether a failed call may succeed later: the server was out of reach or failed, not refused it. */
function transient(error: unknown): boolean {
  return !(error instanceof RunnerHttpError) || error.status >= 500 || error.status === 429;
}

export interface Persistence {
  /** The first wait between attempts, doubling up to 15 seconds. */
  readonly retryMs: number;
  /** How long to keep trying before giving up. */
  readonly forMs: number;
}

/**
 * Calls until it succeeds, the server refuses, or `forMs` has passed, waiting longer each time.
 * Null when it gave up, after `onFailure` heard of every failure.
 */
export async function persist<T>(
  call: () => Promise<T>,
  { retryMs, forMs }: Persistence,
  onFailure: (error: unknown) => void,
): Promise<T | null> {
  const until = Date.now() + forMs;
  let delay = retryMs;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      onFailure(error);
      if (!transient(error) || Date.now() + delay > until) {
        return null;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  }
}

/**
 * The steps of one turn, posted in order and in batches as they arrive. A batch the server could
 * not take is posted again, and those after it wait, so the transcript keeps every step in order.
 */
export class EventSender {
  private buffer: TranscriptEntry[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (entries: TranscriptEntry[]) => Promise<void>,
    private readonly log: RunnerLog,
    private readonly persistence: Persistence,
  ) {}

  push(event: AgentEvent): void {
    this.buffer.push({ ts: new Date().toISOString(), event });
    this.timer ??= setTimeout(() => this.post(), EVENT_BATCH_MS);
  }

  async flush(): Promise<void> {
    this.post();
    await this.chain;
  }

  private post(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.buffer;
    this.buffer = [];
    if (batch.length === 0) {
      return;
    }
    this.chain = this.chain.then(() => this.deliver(batch));
  }

  private async deliver(batch: TranscriptEntry[]): Promise<void> {
    const sent = await persist(
      () => this.send(batch),
      this.persistence,
      (error) => this.log.warn({ error: describeError(error) }, "could not post a turn's steps"),
    );
    if (sent === null) {
      this.log.error({ steps: batch.length }, "gave up posting a turn's steps");
    }
  }
}

/**
 * A runner: it registers with the board server, holds the server's event stream, and runs what
 * arrives on it. Each turn pulls the board's projection and the agent's home before it starts,
 * pushes the home back after it ends, and only then reports the outcome. A broken stream is
 * reconnected; the turns in flight carry on, since everything they send travels as posts.
 */
export class RunnerDaemon {
  private readonly client: RunnerClient;
  private readonly executor: TurnExecutor;
  private readonly layout: RunnerLayout;
  private readonly version: string;
  private readonly slots: number | null;
  private readonly capabilities: readonly string[];
  private readonly log: RunnerLog;
  private readonly retryMs: number;
  private readonly postForMs: number;
  private readonly running = new Map<string, Promise<void>>();
  /** The jobs running, whose workspaces a sweep leaves to the end of their turn. */
  private readonly jobs = new Map<string, TurnJob>();
  /** Each turn in flight's handle, for the steers and stops the server sends it. */
  private readonly controls = new Map<string, TurnControl>();
  private readonly homes: HomeSync;
  private readonly board: TreeCopy;
  private abort: AbortController | null = null;
  /** Aborted by `stop`, which ends the wait between connections at once. */
  private readonly stopping = new AbortController();
  private stopped = false;
  private loop: Promise<void> | null = null;
  private assigned: Name | null = null;
  /** Warm-session reports in order; an outcome waits for them, so the next job sees the session warm. */
  private warmChain: Promise<void> = Promise.resolve();

  constructor(options: RunnerDaemonOptions) {
    this.client = options.client;
    this.executor = options.executor;
    this.layout = options.layout;
    this.version = options.version;
    this.slots = options.slots;
    this.capabilities = options.capabilities ?? [];
    this.log = options.log ?? SILENT;
    this.retryMs = options.retryMs ?? 1_000;
    this.postForMs = options.postForMs ?? POST_FOR_MS;
    this.board = new TreeCopy(options.layout.board, options.layout.syncState("board"));
    this.homes = new HomeSync(options.layout, options.client.homeRemote(), this.log);
  }

  /** The name the server knows this runner by, once it has welcomed it. */
  get name(): Name {
    if (this.assigned === null) {
      throw new Error("the runner has not registered yet");
    }
    return this.assigned;
  }

  /** Where this runner keeps the board mirror, homes, repositories, and worktrees. */
  get paths(): RunnerLayout {
    return this.layout;
  }

  /** Turns in flight, by turn id. */
  get turns(): string[] {
    return [...this.running.keys()];
  }

  /**
   * Connects, and keeps connecting after the stream ends. Resolves once the first stream is open,
   * and rejects with the server's 401 if it refuses the token before then.
   */
  async start(): Promise<void> {
    const { promise: first, resolve: opened, reject: refused } = Promise.withResolvers<void>();
    this.loop = this.connectLoop(opened, refused);
    await first;
  }

  /**
   * Stops taking work, waits for the turns in flight to report, and lets warm sessions go. The
   * stream closes first, so no job arrives while the runner drains; everything else travels as
   * posts, which still reach the server.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    this.stopping.abort();
    await Promise.allSettled(this.running.values());
    await this.executor.close();
    await this.warmChain;
    await this.loop?.catch(() => undefined);
  }

  /** Tells the server which conversations are warm now. */
  reportWarm(keys: readonly string[]): void {
    if (this.assigned === null) {
      return;
    }
    const report = [...keys];
    this.warmChain = this.warmChain.then(() =>
      this.client.warm(report).catch((error: unknown) => {
        this.log.warn({ error: describeError(error) }, "could not report warm sessions");
      }),
    );
  }

  private async connectLoop(
    opened: () => void,
    refused: (error: RunnerHttpError) => void,
  ): Promise<void> {
    let delay = this.retryMs;
    let everOpened = false;
    while (!this.stopped) {
      try {
        const { all, resident, steerable, stoppable } = this.executor.clis;
        const welcome = await this.client.hello({
          protocol: RUNNER_PROTOCOL,
          version: this.version,
          os: runnerOs(),
          clis: all,
          residentClis: resident,
          steerableClis: steerable,
          stoppableClis: stoppable,
          branchReads: true,
          branchChanges: true,
          capabilities: [...this.capabilities],
          slots: this.slots,
          turns: this.turns,
        });
        this.assigned = welcome.name;
        await this.client.warm(this.executor.warmKeys);
        this.abort = new AbortController();
        this.log.info({ runner: welcome.name, server: welcome.version }, "runner connected");
        await this.client.stream(this.abort.signal, {
          onOpen: () => {
            delay = this.retryMs;
            everOpened = true;
            opened();
            void this.reportHeld();
          },
          onMessage: (message) => this.handle(message),
          onMalformed: (problem) =>
            this.log.warn({ problem }, "skipped a message the runner does not understand"),
        });
      } catch (error) {
        // A token refused before the first connection will not be accepted by waiting; one refused
        // later may be a server restored from an older copy, so the runner keeps trying.
        if (!everOpened && error instanceof RunnerHttpError && error.status === 401) {
          this.stopped = true;
          refused(error);
          return;
        }
        if (!this.stopped) {
          this.log.warn({ error: describeError(error) }, "runner connection failed");
        }
      }
      if (this.stopped) {
        break;
      }
      await sleep(delay, this.stopping.signal);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  }

  private handle(message: RunnerMessage): void {
    if (message.type === "turn") {
      if (this.stopped || this.running.has(message.job.turnId)) {
        return;
      }
      const control = new TurnControl();
      this.controls.set(message.job.turnId, control);
      this.jobs.set(message.job.turnId, message.job);
      const run = this.runJob(message.job, control).finally(() => {
        this.running.delete(message.job.turnId);
        this.controls.delete(message.job.turnId);
        this.jobs.delete(message.job.turnId);
      });
      this.running.set(message.job.turnId, run);
      void this.acknowledge(message.job.turnId);
      return;
    }
    const answer = (work: Promise<unknown>): void => {
      work
        .then(
          (value) => this.client.answer(message.request, { ok: true, value }),
          (error: unknown) =>
            this.client.answer(message.request, { ok: false, error: describeError(error) }),
        )
        .catch((error: unknown) => {
          this.log.warn({ error: describeError(error) }, "could not answer a request");
        });
    };
    switch (message.type) {
      case "land":
        answer(this.executor.land(message.land));
        return;
      case "models":
        answer(this.executor.models(message.cli));
        return;
      case "file":
        answer(this.executor.readBranch(message.read));
        return;
      case "changes":
        answer(this.executor.branchChanges(message.read));
        return;
      case "steer": {
        const control = this.controls.get(message.turnId);
        answer(control === undefined ? Promise.resolve(false) : control.steer(message.steer));
        return;
      }
      case "stop": {
        const control = this.controls.get(message.turnId);
        control?.stop();
        answer(Promise.resolve(control !== undefined));
        return;
      }
      case "sweep":
        answer(this.executor.sweep(message.conversation, (held) => this.inUse(held)));
        return;
    }
  }

  /** Whether a turn running here is in that citizen's conversation, whose end removes the workspace. */
  private inUse(held: HeldWorkspace): boolean {
    return [...this.jobs.values()].some((job) => {
      const conversation = workspaceConversationOf(job);
      return (
        job.agent === held.agent &&
        conversation !== null &&
        sameConversation(conversation, held.conversation)
      );
    });
  }

  /** Reports the workspaces held here, so the server sweeps those whose conversations ended meanwhile. */
  private async reportHeld(): Promise<void> {
    try {
      await this.client.workspaces(await this.executor.held());
    } catch (error) {
      this.log.warn({ error: describeError(error) }, "could not report the workspaces held here");
    }
  }

  /**
   * Tells the server a job arrived. A receipt that never gets through costs nothing: the turn is
   * among those the next hello lists, which the server takes as received too.
   */
  private async acknowledge(turnId: string): Promise<void> {
    await persist(
      () => this.client.received(turnId),
      { retryMs: this.retryMs, forMs: this.retryMs * 2 ** RECEIPT_ATTEMPTS },
      (error) =>
        this.log.warn({ turnId, error: describeError(error) }, "could not acknowledge a job"),
    );
  }

  private async runJob(job: TurnJob, control: TurnControl): Promise<void> {
    const sender = new EventSender((entries) => this.client.events(job.turnId, entries), this.log, {
      retryMs: this.retryMs,
      forMs: this.postForMs,
    });
    let outcome: TurnOutcome;
    try {
      await this.board.pull(this.client.boardTree());
      await this.homes.prepare(job.agent);
      outcome = await this.executor.run(job, (event) => sender.push(event), control);
    } catch (error) {
      outcome = {
        exitReason: "error",
        status: null,
        error: `the runner could not run the turn: ${describeError(error)}`,
        usage: ZERO_USAGE,
        costUsd: 0,
        session: job.session ?? "unstarted",
        model: null,
        work: null,
        leftovers: false,
      };
    }
    try {
      await this.homes.publish(job.agent, job.turnId);
    } catch (error) {
      this.log.warn(
        { agent: job.agent, error: describeError(error) },
        "could not push the agent's home",
      );
    }
    await sender.flush();
    await this.warmChain;
    const ack = await this.report(job.turnId, outcome);
    if (ack?.dropWorkspace === true) {
      await this.executor.dropWorkspace(job);
    }
  }

  /** Posts a turn's outcome, trying again while the server is out of reach, as across its restart. */
  private async report(turnId: string, outcome: TurnOutcome): Promise<TurnAck | null> {
    return persist(
      () => this.client.outcome(turnId, outcome),
      { retryMs: this.retryMs, forMs: this.postForMs },
      (error) =>
        this.log.warn({ turnId, error: describeError(error) }, "could not report a turn's outcome"),
    );
  }
}

export interface CreateRunnerOptions {
  readonly serverUrl: string;
  readonly token: string;
  /** The runner's own data directory. */
  readonly dataDir: string;
  readonly backends: Partial<Record<CliKind, AgentBackend>>;
  readonly version: string;
  readonly slots: number | null;
  readonly capabilities?: readonly string[] | undefined;
  readonly log?: RunnerLog | undefined;
  readonly git?: GitOps | undefined;
  readonly retryMs?: number | undefined;
  /** How long a turn's steps and outcome are posted again while the server is out of reach. */
  readonly postForMs?: number | undefined;
  readonly fetch?: typeof fetch | undefined;
  /** How long the event stream may stay silent before the runner connects again. */
  readonly streamIdleMs?: number | undefined;
  /** How often a project's remote is fetched at most; a minute unless set. */
  readonly fetchIntervalMs?: number | undefined;
}

/** A runner with its client, layout, and executor wired together; call `start` to connect it. */
export function createRunner(options: CreateRunnerOptions): RunnerDaemon {
  const layout = new RunnerLayout(options.dataDir);
  const client = new RunnerClient(
    options.serverUrl,
    options.token,
    options.fetch,
    options.streamIdleMs,
  );
  let daemon: RunnerDaemon | null = null;
  const executor = new TurnExecutor({
    layout,
    backends: options.backends,
    runnerName: () => daemon?.name ?? "runner",
    git: options.git,
    log: options.log,
    onWarmChanged: (keys) => daemon?.reportWarm(keys),
    serverUrl: options.serverUrl,
    fetchIntervalMs: options.fetchIntervalMs,
  });
  daemon = new RunnerDaemon({
    client,
    executor,
    layout,
    version: options.version,
    slots: options.slots,
    capabilities: options.capabilities,
    log: options.log,
    retryMs: options.retryMs,
    postForMs: options.postForMs,
  });
  return daemon;
}
