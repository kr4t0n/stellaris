import type { BoardEvent } from "@stellaris/shared";
import { MentionMatcher, type MatchingCitizen } from "./mention-matching.js";

/**
 * The upper bounds of the wake-latency histogram's buckets, in seconds, before `+Inf`: steps
 * around the 5 s debounce of the user's posts and the 30 s of a citizen's, up to two hours.
 */
export const WAKE_LATENCY_BUCKETS = [
  1, 2.5, 5, 7.5, 10, 20, 40, 60, 120, 300, 600, 1800, 3600, 7200,
] as const;

/** One citizen's answered mentions, as a Prometheus histogram counts them. */
export interface WakeLatencySeries {
  readonly agent: string;
  /** The answers at or under each bound of `WAKE_LATENCY_BUCKETS`, in its order, cumulative. */
  readonly buckets: readonly number[];
  readonly count: number;
  /** Their latencies' total, in milliseconds. */
  readonly sumMs: number;
}

/** One citizen's mentions no turn has answered. */
export interface MentionWaitSeries {
  readonly agent: string;
  /** Waiting now, each for at most `MENTION_WAIT_MS`. */
  readonly waiting: number;
  /** Waited past `MENTION_WAIT_MS` with no answer, so never answered. */
  readonly unanswered: number;
}

/** Orders by UTF-16 code units, as the board sorts names, never by the host's locale. */
function byAgent(a: { agent: string }, b: { agent: string }): number {
  return a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0;
}

/**
 * Wake latency as the metrics measure it, counted for Prometheus as each answer comes: the same
 * `MentionMatcher` pairs each mention with its answer, fed the log's posts, turn starts, and
 * steers in its order, so over one log and roster the answers it counts are the Metrics view's
 * for the window `all`. A histogram only grows, so it never matches again: each mention is matched
 * with the citizens the map names when the mention is posted.
 */
export class WakeLatency {
  private readonly matcher: MentionMatcher;
  // By citizen, the answers in each bucket and past the last, not yet cumulative.
  private readonly histograms = new Map<string, { counts: number[]; sumMs: number }>();

  /** `citizens` are those a mention can name, read as each post is matched. */
  constructor(citizens: ReadonlyMap<string, MatchingCitizen>) {
    this.matcher = new MentionMatcher(citizens);
  }

  /** Counts a post, a turn's start, or a steer; any other event passes. */
  add(event: BoardEvent): void {
    if (event.type === "message.posted") {
      this.matcher.post(event);
      return;
    }
    if (event.type !== "turn.started" && event.type !== "turn.steered") {
      return;
    }
    const at = Date.parse(event.ts);
    for (const mention of this.matcher.answer(event)) {
      const ms = at - mention.at;
      const histogram = this.histograms.get(mention.agent) ?? {
        counts: Array.from({ length: WAKE_LATENCY_BUCKETS.length + 1 }, () => 0),
        sumMs: 0,
      };
      const bucket = WAKE_LATENCY_BUCKETS.findIndex((bound) => ms <= bound * 1000);
      const slot = bucket < 0 ? WAKE_LATENCY_BUCKETS.length : bucket;
      histogram.counts[slot] = (histogram.counts[slot] ?? 0) + 1;
      histogram.sumMs += ms;
      this.histograms.set(mention.agent, histogram);
    }
  }

  /** Each citizen's answered mentions, in an order that holds from one read to the next. */
  latencies(): WakeLatencySeries[] {
    return [...this.histograms]
      .map(([agent, { counts, sumMs }]) => {
        const cumulative: number[] = [];
        let total = 0;
        for (const count of counts) {
          total += count;
          cumulative.push(total);
        }
        return {
          agent,
          buckets: cumulative.slice(0, WAKE_LATENCY_BUCKETS.length),
          count: total,
          sumMs,
        };
      })
      .toSorted(byAgent);
  }

  /** Each mentioned citizen's unanswered mentions, in an order that holds too. */
  unanswered(): MentionWaitSeries[] {
    return [...this.matcher.unansweredBy()]
      .map(([agent, { waiting, expired }]) => ({ agent, waiting, unanswered: expired }))
      .toSorted(byAgent);
  }
}
