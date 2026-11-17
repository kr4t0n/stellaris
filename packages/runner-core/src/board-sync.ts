import { setTimeout as wait } from "node:timers/promises";
import type { RunnerSyncReport } from "@stellaris/shared";
import { describeError } from "./errors.js";
import type { RunnerLog } from "./executor.js";
import type { RemoteTree, TreeCopy, TreeProgress, TreeStream } from "./sync.js";

export interface BoardSyncOptions {
  readonly copy: TreeCopy;
  readonly remote: RemoteTree;
  readonly stream: TreeStream;
  /** Sends a report to the server. */
  readonly report: (report: RunnerSyncReport) => Promise<void>;
  readonly log: RunnerLog;
  /** The first wait after a failed try, doubling up to `maxRetryMs`. */
  readonly retryMs: number;
  readonly maxRetryMs?: number | undefined;
  /** How often progress is reported at most; failures and the end are reported at once. */
  readonly reportEveryMs?: number | undefined;
  /** How long the end is reported again while the server is out of reach. */
  readonly reportEndForMs: number;
  /** Ends the sync, as the runner stops. */
  readonly signal: AbortSignal;
}

const MAX_RETRY_MS = 30_000;
const REPORT_EVERY_MS = 1_000;

/** Waits, or until `signal` aborts; the timer holds the process open, as the runner's waits do. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return wait(ms, undefined, { signal }).catch(() => undefined);
}

/**
 * The reports of one sync, in order: progress at most every `everyMs`, the latest replacing one
 * not sent yet, and a failure or the end at once. A report the server could not take is let go,
 * since the next carries everything it said; only the end is sent again until it lands.
 */
class SyncReporter {
  private chain: Promise<void> = Promise.resolve();
  private pending: RunnerSyncReport | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sentAt = 0;

  constructor(
    private readonly send: (report: RunnerSyncReport) => Promise<void>,
    private readonly log: RunnerLog,
    private readonly everyMs: number,
  ) {}

  note(report: RunnerSyncReport): void {
    this.pending = report;
    this.timer ??= setTimeout(
      () => void this.flush(),
      Math.max(0, this.everyMs - (Date.now() - this.sentAt)),
    );
  }

  now(report: RunnerSyncReport): Promise<void> {
    this.pending = report;
    return this.flush();
  }

  /** Waits for what was sent, dropping what was not. */
  async close(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    await this.chain;
  }

  private flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const report = this.pending;
    this.pending = null;
    if (report !== null) {
      this.sentAt = Date.now();
      this.chain = this.chain.then(() =>
        this.send(report).catch((error: unknown) => {
          this.log.warn({ error: describeError(error) }, "could not report the board sync");
        }),
      );
    }
    return this.chain;
  }
}

/**
 * Brings the runner's board copy up to date as it connects, before the server gives it a turn:
 * the whole projection in one stream while it has no copy, from where a cut stream stopped, and an
 * incremental pull once it has. A failed try is reported with its error and when the next one is,
 * and made again, from what is on disk, until one finishes or `signal` ends the sync; a try that
 * wrote something is made again at once. The end is reported until the server takes it, which
 * lifts its hold on the runner. True once done.
 */
export async function syncBoard(options: BoardSyncOptions): Promise<boolean> {
  const { copy, log, signal } = options;
  const maxRetryMs = options.maxRetryMs ?? MAX_RETRY_MS;
  const reporter = new SyncReporter(options.report, log, options.reportEveryMs ?? REPORT_EVERY_MS);
  let attempt = 1;
  let delay = options.retryMs;
  let progress: TreeProgress = {
    phase: "listing",
    files: 0,
    totalFiles: null,
    bytes: 0,
    totalBytes: null,
  };
  const started = Date.now();
  try {
    while (!signal.aborted) {
      // Whether this try wrote a file: the count past the first it gave once it was writing.
      let wrote = false;
      let base: number | null = null;
      const noted = (next: TreeProgress): void => {
        if (next.phase !== "listing") {
          base ??= next.files;
          wrote ||= next.files > base;
        }
        progress = next;
        reporter.note({ ...next, attempt });
      };
      try {
        const plan = await copy.plan();
        if (plan.kind === "copy") {
          // Reported from the stream's first record, which counts what a cut copy wrote already,
          // so the progress the server kept from before a restart stands until then.
          await copy.copy(options.stream, signal, noted);
        } else {
          await copy.pull(options.remote, noted);
        }
      } catch (error) {
        if (signal.aborted) {
          return false;
        }
        if (wrote) {
          delay = options.retryMs;
        }
        const reason = describeError(error);
        log.warn(
          { attempt, error: reason, retryInMs: delay, files: progress.files },
          "board sync failed; trying again",
        );
        // Not waited for: a report stuck on a dead connection would hold the next try.
        void reporter.now({
          ...progress,
          attempt,
          error: reason.slice(0, 1000),
          retryInMs: delay,
        });
        await sleep(delay, signal);
        delay = Math.min(delay * 2, maxRetryMs);
        attempt += 1;
        continue;
      }
      await reporter.close();
      const done: RunnerSyncReport = { ...progress, phase: "done", attempt };
      const until = Date.now() + options.reportEndForMs;
      let pause = options.retryMs;
      for (;;) {
        try {
          await options.report(done);
          break;
        } catch (error) {
          if (signal.aborted || Date.now() + pause > until) {
            log.error({ error: describeError(error) }, "gave up reporting the board synced");
            return false;
          }
          log.warn({ error: describeError(error) }, "could not report the board synced");
          await sleep(pause, signal);
          pause = Math.min(pause * 2, maxRetryMs);
        }
      }
      log.info(
        {
          files: progress.files,
          bytes: progress.bytes,
          attempts: attempt,
          ms: Date.now() - started,
        },
        "board synced",
      );
      return true;
    }
    return false;
  } finally {
    await reporter.close();
  }
}
