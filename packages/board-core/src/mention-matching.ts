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
 * post, else the first later turn of its citizen that `answers` it. Feed it the log's posts, turn
 * starts, and steers in the log's order. A mention's answer depends on that mention and the events
 * after it alone, so a window counts the mentions made in it, however many others were fed.
 */
export class MentionMatcher {
  // By citizen, in the order they were made, since only the citizen's own turns answer them.
  private readonly waiting = new Map<string, Mention[]>();

  /** `citizens` are those a mention can name, with today's memberships. */
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
    const made: Mention[] = [];
    for (const name of new Set(message.data.mentions)) {
      const citizen = this.citizens.get(name);
      if (citizen === undefined || name === event.actor) {
        continue;
      }
      const mention: Mention = {
        agent: name,
        at: Date.parse(event.ts),
        message: message.data.id ?? null,
        thread,
        channel: message.data.channel,
        scopes: [project, wakeScope(citizen, project)].filter(
          (scope): scope is string => scope !== null,
        ),
      };
      const waiting = this.waiting.get(name);
      if (waiting === undefined) {
        this.waiting.set(name, [mention]);
      } else {
        waiting.push(mention);
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

  /** The mentions no turn has answered yet. */
  get unanswered(): number {
    let count = 0;
    for (const waiting of this.waiting.values()) {
      count += waiting.length;
    }
    return count;
  }
}
