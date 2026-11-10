import {
  HeartbeatCauseSchema,
  channelConversation,
  parseChannelRef,
  placeConversation,
  wakeScope,
  type BoardEvent,
} from "@stellaris/shared";
import { z } from "zod";

// A turn's events carry its thread as the thread's id, its channel by name, and a project's channels'
// conversation by the project, all absent for a home turn. A heartbeat's carry what it woke for,
// since the board kept it; one it does not know counts as a heartbeat without one.
export const TurnPayload = z.object({
  turnId: z.string().optional(),
  project: z.string(),
  thread: z.string().optional(),
  channel: z.string().optional(),
  place: z.string().optional(),
  trigger: z.string(),
  heartbeat: HeartbeatCauseSchema.optional().catch(undefined),
});
export const MessagePayload = z.object({
  id: z.string().optional(),
  channel: z.string(),
  thread: z.string().nullable().optional(),
  mentions: z.array(z.string()).default([]),
});
const SteeredPayload = z.object({ messages: z.array(z.string()) });

/**
 * How long a mention waits for its answer: a week, the longest windowed view. Once the log has
 * gone further past it, no turn or steer answers it and it counts as unanswered, so a mention
 * nobody answers is held no longer.
 */
export const MENTION_WAIT_MS = 7 * 24 * 3_600_000;

/** A citizen as the matching needs it: where a mention in a project's channel would wake it. */
export interface MatchingCitizen {
  readonly name: string;
  readonly memberships: readonly string[];
}

/** A mention waiting for its turn: who was named, where, and when. */
export interface Mention {
  readonly agent: string;
  readonly at: number;
  /** The post that made it, which a turn already running may have been handed. */
  readonly message: string | null;
  /** The thread it was made in, or null for a top-level post. */
  readonly thread: string | null;
  /** The channel it was posted in. */
  readonly channel: string;
  /**
   * Scopes the mention may have woken its citizen in: the channel's project, and the scope the
   * wake rule gives with today's memberships, which an archive since may have changed.
   */
  readonly scopes: readonly string[];
}

/** A turn's start as a mention's answer reads it. */
export interface TurnStart {
  readonly agent: string;
  readonly at: number;
  readonly thread: string | null;
  readonly channel: string | null;
  readonly place: string | null;
  readonly project: string;
  readonly trigger: string;
}

/**
 * Whether a turn is the one a mention woke: in the mention's thread, or for a top-level mention
 * the conversation of its channel in the scope it wakes, the home for general, and in the society
 * scope that of its project's channels for a project's channel. Before threads, channels, and
 * projects seen from the society had conversations of their own, a mention in one woke the home
 * of the scope, so a home turn woken by a mention answers one.
 */
export function answers(mention: Mention, turn: TurnStart): boolean {
  if (mention.agent !== turn.agent || mention.at > turn.at) {
    return false;
  }
  if (turn.thread !== null) {
    return mention.thread === turn.thread;
  }
  if (!mention.scopes.includes(turn.project)) {
    return false;
  }
  const topLevel = mention.thread === null;
  const own = topLevel ? channelConversation(turn.project, mention.channel) : undefined;
  const place = topLevel ? placeConversation(turn.project, mention.channel) : undefined;
  if (turn.channel !== null) {
    return topLevel && own === turn.channel;
  }
  if (turn.place !== null) {
    return topLevel && place === turn.place;
  }
  return (topLevel && own === undefined && place === undefined) || turn.trigger === "mention";
}

/**
 * Pairs each mention of a citizen with the turn that answered it, as wake latency counts them:
 * its delivery into a turn already running in its conversation, the `turn.steered` naming its
 * post, else the first later turn of its citizen that `answers` it, while the log is within
 * `MENTION_WAIT_MS` of it. Feed it the log's posts, turn starts, and steers in the log's order.
 * A mention's answer depends on that mention and the events after it alone, so a window counts the
 * mentions made in it, however many others were fed. The log's latest moment, which ends a wait,
 * is read from the turn starts, the steers, and the posts that make a mention, which every caller
 * feeds alike; a post made earlier than a mention can't move it past that mention.
 */
export class MentionMatcher {
  // By citizen, in the order they were made, since only the citizen's own turns answer them.
  private readonly waiting = new Map<string, Mention[]>();
  // By citizen, the mentions that waited past `MENTION_WAIT_MS` unanswered.
  private readonly expired = new Map<string, number>();
  // The latest moment the log has reached, which never falls, as the board's clock can step back.
  private latest = -Infinity;
  // When the oldest waiting mention was made, so the waits are looked over only once one is due.
  private oldest = Infinity;

  /**
   * `citizens` are those a mention can name, with their memberships: read as each post is
   * matched, so a map kept current names a citizen added since.
   */
  constructor(private readonly citizens: ReadonlyMap<string, MatchingCitizen>) {}

  /**
   * Starts the mentions a post makes waiting, and returns them: one per citizen it names other
   * than its author. The board's own posts make none.
   */
  post(event: BoardEvent): Mention[] {
    if (event.type !== "message.posted" || event.actor === "board") {
      return [];
    }
    const message = MessagePayload.safeParse(event.payload);
    if (!message.success) {
      return [];
    }
    const thread = message.data.thread ?? null;
    const project = parseChannelRef(message.data.channel).project;
    const at = Date.parse(event.ts);
    const made: Mention[] = [];
    for (const name of new Set(message.data.mentions)) {
      const citizen = this.citizens.get(name);
      if (citizen === undefined || name === event.actor) {
        continue;
      }
      const mention: Mention = {
        agent: name,
        at,
        message: message.data.id ?? null,
        thread,
        channel: message.data.channel,
        scopes: [project, wakeScope(citizen, project)].filter(
          (scope): scope is string => scope !== null,
        ),
      };
      this.reach(at);
      // A mention made a week before a moment the log has already passed, as when the clock
      // steps back that far, never waits.
      if (this.latest - at > MENTION_WAIT_MS) {
        this.expired.set(name, (this.expired.get(name) ?? 0) + 1);
      } else {
        const waiting = this.waiting.get(name);
        if (waiting === undefined) {
          this.waiting.set(name, [mention]);
        } else {
          waiting.push(mention);
        }
        this.oldest = Math.min(this.oldest, at);
      }
      made.push(mention);
    }
    return made;
  }

  /**
   * The waiting mentions a turn's start or a steer answers, which wait no more: a turn in a
   * conversation answers every mention of its citizen waiting there.
   */
  answer(event: BoardEvent): Mention[] {
    if (event.type === "turn.started" || event.type === "turn.steered") {
      this.reach(Date.parse(event.ts));
    }
    const waiting = this.waiting.get(event.actor) ?? [];
    let answered: Mention[] = [];
    if (event.type === "turn.started") {
      const turn = TurnPayload.safeParse(event.payload);
      if (!turn.success) {
        return [];
      }
      const started: TurnStart = {
        agent: event.actor,
        at: Date.parse(event.ts),
        thread: turn.data.thread ?? null,
        channel: turn.data.channel ?? null,
        place: turn.data.place ?? null,
        project: turn.data.project,
        trigger: turn.data.trigger,
      };
      answered = waiting.filter((mention) => answers(mention, started));
    } else if (event.type === "turn.steered") {
      // A mention delivered into a turn already running in its conversation is answered there.
      const steered = SteeredPayload.safeParse(event.payload);
      if (!steered.success) {
        return [];
      }
      const delivered = new Set(steered.data.messages);
      answered = waiting.filter(
        (mention) => mention.message !== null && delivered.has(mention.message),
      );
    }
    if (answered.length > 0) {
      this.waiting.set(
        event.actor,
        waiting.filter((mention) => !answered.includes(mention)),
      );
    }
    return answered;
  }

  /** The mentions no turn has answered: those waiting still, and those that waited too long. */
  get unanswered(): number {
    let count = 0;
    for (const { waiting, expired } of this.unansweredBy().values()) {
      count += waiting + expired;
    }
    return count;
  }

  /**
   * By citizen, for every citizen mentioned so far, the mentions waiting now and those that
   * waited past `MENTION_WAIT_MS` unanswered.
   */
  unansweredBy(): Map<string, { readonly waiting: number; readonly expired: number }> {
    const counts = new Map<string, { waiting: number; expired: number }>();
    for (const [agent, waiting] of this.waiting) {
      counts.set(agent, { waiting: waiting.length, expired: 0 });
    }
    for (const [agent, expired] of this.expired) {
      counts.set(agent, { waiting: counts.get(agent)?.waiting ?? 0, expired });
    }
    return counts;
  }

  /** Moves the log's latest moment on to `at`, and lets go of the mentions that waited past it. */
  private reach(at: number): void {
    if (!(at > this.latest)) {
      return;
    }
    this.latest = at;
    if (this.latest - this.oldest <= MENTION_WAIT_MS) {
      return;
    }
    let oldest = Infinity;
    for (const [agent, waiting] of this.waiting) {
      const kept = waiting.filter((mention) => this.latest - mention.at <= MENTION_WAIT_MS);
      if (kept.length < waiting.length) {
        this.waiting.set(agent, kept);
        this.expired.set(agent, (this.expired.get(agent) ?? 0) + waiting.length - kept.length);
      }
      for (const mention of kept) {
        oldest = Math.min(oldest, mention.at);
      }
    }
    this.oldest = oldest;
  }
}
