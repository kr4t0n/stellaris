import os from "node:os";
import {
  homeFileTravels,
  RUNNER_PROTOCOL,
  type AgentEvent,
  type CliKind,
  type Name,
  type RunnerMessage,
  type TranscriptEntry,
  type TurnJob,
  type TurnOutcome,
} from "@stellaris/shared";
import { RunnerClient } from "./client.js";
import { TurnExecutor, type RunnerLog } from "./executor.js";
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
}

const SILENT: RunnerLog = { info() {}, warn() {}, error() {} };
const MAX_RETRY_MS = 15_000;
/** Steps of a turn travel in small batches, so the live picture lags by at most this much. */
const EVENT_BATCH_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** The steps of one turn, posted in order and in batches as they arrive. */
class EventSender {
  private buffer: TranscriptEntry[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (entries: TranscriptEntry[]) => Promise<void>,
    private readonly log: RunnerLog,
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
    this.chain = this.chain.then(() =>
      this.send(batch).catch((error: unknown) => {
        this.log.warn({ error: String(error) }, "could not post a turn's steps");
      }),
    );
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
  private readonly running = new Map<string, Promise<void>>();
  private readonly homes = new Map<Name, TreeCopy>();
  private readonly board: TreeCopy;
  private abort: AbortController | null = null;
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
    this.board = new TreeCopy(
      options.layout.board,
      options.layout.syncState("board"),
      () => "down",
    );
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

  /** Connects, and keeps connecting after the stream ends. Resolves once the first stream is open. */
  async start(): Promise<void> {
    const { promise: first, resolve: opened } = Promise.withResolvers<void>();
    this.loop = this.connectLoop(opened);
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
        this.log.warn({ error: String(error) }, "could not report warm sessions");
      }),
    );
  }

  private async connectLoop(opened: () => void): Promise<void> {
    let delay = this.retryMs;
    while (!this.stopped) {
      try {
        const { all, resident } = this.executor.clis;
        const welcome = await this.client.hello({
          protocol: RUNNER_PROTOCOL,
          version: this.version,
          os:
            os.platform() === "win32" ? "windows" : os.platform() === "darwin" ? "darwin" : "linux",
          clis: all,
          residentClis: resident,
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
            opened();
          },
          onMessage: (message) => this.handle(message),
          onMalformed: (problem) =>
            this.log.warn({ problem }, "skipped a message the runner does not understand"),
        });
      } catch (error) {
        if (!this.stopped) {
          this.log.warn({ error: String(error) }, "runner connection failed");
        }
      }
      if (this.stopped) {
        break;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  }

  private handle(message: RunnerMessage): void {
    if (message.type === "turn") {
      if (this.stopped || this.running.has(message.job.turnId)) {
        return;
      }
      const run = this.runJob(message.job).finally(() => {
        this.running.delete(message.job.turnId);
      });
      this.running.set(message.job.turnId, run);
      return;
    }
    const answer = (work: Promise<unknown>): void => {
      work
        .then(
          (value) => this.client.answer(message.request, { ok: true, value }),
          (error: unknown) =>
            this.client.answer(message.request, { ok: false, error: String(error) }),
        )
        .catch((error: unknown) => {
          this.log.warn({ error: String(error) }, "could not answer a request");
        });
    };
    if (message.type === "land") {
      answer(this.executor.land(message.land));
    } else {
      answer(this.executor.models(message.cli));
    }
  }

  private async runJob(job: TurnJob): Promise<void> {
    const sender = new EventSender((entries) => this.client.events(job.turnId, entries), this.log);
    const home = this.homeCopy(job.agent);
    let outcome: TurnOutcome;
    try {
      await this.board.pull(this.client.boardTree());
      await home.pull(this.client.homeTree(job.agent));
      outcome = await this.executor.run(job, (event) => sender.push(event));
    } catch (error) {
      outcome = {
        exitReason: "error",
        status: null,
        error: `the runner could not run the turn: ${String(error)}`,
        usage: ZERO_USAGE,
        costUsd: 0,
        session: job.session ?? "unstarted",
        model: null,
        work: null,
      };
    }
    try {
      await home.push(this.client.homeTree(job.agent));
    } catch (error) {
      this.log.warn({ agent: job.agent, error: String(error) }, "could not push the agent's home");
    }
    await sender.flush();
    await this.warmChain;
    const ack = await this.report(job.turnId, outcome);
    if (ack?.dropWorktree === true) {
      await this.executor.dropTaskWorktree(job);
    }
  }

  /** Posts a turn's outcome, trying again while the server is unreachable, as across its restart. */
  private async report(
    turnId: string,
    outcome: TurnOutcome,
  ): Promise<{ dropWorktree: boolean } | null> {
    let delay = this.retryMs;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await this.client.outcome(turnId, outcome);
      } catch (error) {
        this.log.warn({ turnId, error: String(error) }, "could not report a turn's outcome");
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_RETRY_MS);
      }
    }
    return null;
  }

  private homeCopy(agent: Name): TreeCopy {
    let copy = this.homes.get(agent);
    if (copy === undefined) {
      copy = new TreeCopy(
        this.layout.agent(agent),
        this.layout.syncState(`home-${agent}`),
        homeFileTravels,
      );
      this.homes.set(agent, copy);
    }
    return copy;
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
  readonly fetch?: typeof fetch | undefined;
}

/** A runner with its client, layout, and executor wired together; call `start` to connect it. */
export function createRunner(options: CreateRunnerOptions): RunnerDaemon {
  const layout = new RunnerLayout(options.dataDir);
  const client = new RunnerClient(options.serverUrl, options.token, options.fetch);
  let daemon: RunnerDaemon | null = null;
  const executor = new TurnExecutor({
    layout,
    backends: options.backends,
    runnerName: () => daemon?.name ?? "runner",
    git: options.git,
    log: options.log,
    onWarmChanged: (keys) => daemon?.reportWarm(keys),
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
  });
  return daemon;
}
