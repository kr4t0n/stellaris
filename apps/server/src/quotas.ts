import type { CliKind, CliQuota, Name } from "@stellaris/shared";

/** Where the interface's quota refreshes go; the server asks the runner. */
export interface QuotaSource {
  /** `cli`'s plan quota on a runner, read without a turn and recorded on the runner's record. */
  read(runner: Name, cli: CliKind): Promise<CliQuota>;
}

/** The runners a quota read goes to, as the runner hub offers them. */
export interface QuotaRunners {
  quota(runner: Name, cli: CliKind): Promise<CliQuota>;
}

const MINUTE = 60_000;

/**
 * Reads of each runner's CLI quotas. Each read starts a CLI process on the runner, so callers that
 * ask at once share one read, and a read that succeeded is answered again for a minute rather than
 * asked anew; a failed one is dropped so the next ask retries.
 */
export class QuotaReads implements QuotaSource {
  private readonly kept = new Map<string, { at: number; quota: Promise<CliQuota> }>();

  constructor(
    private readonly runners: QuotaRunners,
    private readonly floorMs = MINUTE,
    private readonly now: () => number = Date.now,
  ) {}

  read(runner: Name, cli: CliKind): Promise<CliQuota> {
    const key = `${runner}/${cli}`;
    const kept = this.kept.get(key);
    if (kept !== undefined && this.now() - kept.at < this.floorMs) {
      return kept.quota;
    }
    const quota = this.runners.quota(runner, cli);
    this.kept.set(key, { at: this.now(), quota });
    quota.catch(() => {
      if (this.kept.get(key)?.quota === quota) {
        this.kept.delete(key);
      }
    });
    return quota;
  }
}
