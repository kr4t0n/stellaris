import {
  USER_NAME,
  type BoardEvent,
  type HeartbeatCause,
  type Metrics,
  type MetricsWindow,
} from "@stellaris/shared";
import { z } from "zod";
import {
  MentionMatcher,
  MessagePayload,
  TurnPayload,
  type MatchingCitizen,
  type Mention,
} from "./mention-matching.js";
import {
  MetricsTally,
  SignalPayload,
  TaskPayload,
  windowStart,
  type DecisionKind,
  type MetricsInput,
} from "./metrics.js";

/** Something that happened, at milliseconds since the epoch. */
interface Dated {
  readonly at: number;
}

/**
 * Records in the log's order, read from a moment on without visiting those long before it. The
 * board's clock can step back, so a record may be older than one before it: each position keeps
 * the latest moment up to it, which never falls, and a window starts where that reaches it.
 */
class Timeline<T extends Dated> {
  private readonly records: T[] = [];
  private readonly latest: number[] = [];

  push(record: T): void {
    const before = this.latest.at(-1) ?? -Infinity;
    this.records.push(record);
    this.latest.push(Number.isNaN(record.at) ? before : Math.max(before, record.at));
  }

  /** The records at or after `since`, in the log's order; every record when it is null. */
  *from(since: number | null): Generator<T> {
    let low = 0;
    if (since !== null) {
      let high = this.latest.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if ((this.latest[middle] ?? -Infinity) < since) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
    }
    for (let at = low; at < this.records.length; at += 1) {
      const record = this.records[at];
      if (record !== undefined && (since === null || record.at >= since)) {
        yield record;
      }
    }
  }
}

interface TurnEnd extends Dated {
  readonly agent: string;
  readonly trigger: string;
  readonly heartbeat: HeartbeatCause | undefined;
  readonly actions: number | null;
}

interface Finished extends Dated {
  readonly taskId: string;
  readonly project: string;
}

interface SentBack extends Dated {
  readonly taskId: string;
  readonly project: string;
  readonly from: string | undefined;
  readonly by: string;
}

interface Decision extends Dated {
  readonly ts: string;
  readonly kind: DecisionKind;
}

interface Blocked extends Dated {
  readonly ts: string;
  readonly taskId: string;
  readonly signal: SignalPayload;
}

/** Every mention matched to its answer for one roster, in the order they were made and answered. */
interface Matching {
  readonly roster: string;
  readonly matcher: MentionMatcher;
  readonly made: Mention[];
  readonly answered: { readonly mention: Mention; readonly at: number }[];
  readonly answeredSet: Set<Mention>;
}

const BoardActions = z.number().int().nonnegative();

/** The board actions a turn's end carries, counted from its transcript as it ended. */
function boardActionsOf(event: BoardEvent): number | undefined {
  const counted = BoardActions.safeParse(event.payload["boardActions"]);
  return counted.success ? counted.data : undefined;
}

/**
 * The metrics kept up as the log grows, so that answering one reads neither the log nor a
 * transcript: each event `computeMetrics` counts is added once, as it is appended, to a record
 * of its own kind, in the log's order, with what the measures need of it. A window counts the
 * records in it; a task's send-backs and thread posts, and the questions to the user still open,
 * are kept over the whole log as they arrive. Mentions are matched to their answers once, and
 * again only when the citizens or their memberships change, since the wake rule reads those.
 *
 * Its answer for a log equals `computeMetrics`' for the same log, window, tasks, and citizens,
 * which the equality test holds it to.
 */
export class MetricsIndex {
  private readonly ends = new Timeline<TurnEnd>();
  private readonly finished = new Timeline<Finished>();
  private readonly sentBack = new Timeline<SentBack>();
  private readonly decisions = new Timeline<Decision>();
  private readonly blocked = new Timeline<Blocked>();
  // Send-backs and thread posts, by task, over the whole log.
  private readonly moves = new Map<string, number>();
  private readonly posts = new Map<string, number>();
  // The places where a question to the user waits for an answer.
  private readonly asked = new Set<string>();
  // Posts that name someone, turn starts, and steers, which the matching reads again for a new roster.
  private readonly conversation: BoardEvent[] = [];
  private matching: Matching | null = null;

  /**
   * `actionsOf` gives the board actions of a turn whose end was logged before ends carried them,
   * read from its transcript, and null or nothing for a turn that kept none.
   */
  constructor(
    private readonly actionsOf: (turnId: string) => number | null | undefined = () => undefined,
  ) {}

  /**
   * The turn whose transcript an end needs read for its board actions: a finished turn the
   * metrics count, logged with an id before ends carried the count. Null for any other event.
   */
  static transcriptToRead(event: BoardEvent): string | null {
    if (event.type !== "turn.completed" || boardActionsOf(event) !== undefined) {
      return null;
    }
    const turn = TurnPayload.safeParse(event.payload);
    return turn.success && turn.data.trigger !== "reflection" ? (turn.data.turnId ?? null) : null;
  }

  /** Counts an event; one the metrics don't read passes. */
  add(event: BoardEvent): void {
    const at = Date.parse(event.ts);
    switch (event.type) {
      case "turn.completed": {
        const turn = TurnPayload.safeParse(event.payload);
        if (!turn.success || turn.data.trigger === "reflection") {
          break;
        }
        const { turnId, trigger, heartbeat } = turn.data;
        const actions =
          turnId === undefined ? null : (boardActionsOf(event) ?? this.actionsOf(turnId) ?? null);
        this.ends.push({ at, agent: event.actor, trigger, heartbeat, actions });
        break;
      }
      case "turn.started":
      case "turn.steered":
        this.converse(event);
        break;
      case "task.completed": {
        const task = TaskPayload.safeParse(event.payload);
        if (task.success) {
          this.finished.push({ at, taskId: task.data.taskId, project: task.data.project });
        }
        break;
      }
      case "task.moved": {
        const task = TaskPayload.safeParse(event.payload);
        if (!task.success) {
          break;
        }
        const { taskId, project, from } = task.data;
        this.moves.set(taskId, (this.moves.get(taskId) ?? 0) + 1);
        this.sentBack.push({ at, taskId, project, from, by: event.actor });
        this.decide(event, "stages");
        break;
      }
      case "task.advanced":
        this.decide(event, "stages");
        break;
      case "proposal.decided":
        this.decide(event, "proposals");
        break;
      case "message.posted": {
        const message = MessagePayload.safeParse(event.payload);
        if (!message.success) {
          break;
        }
        const thread = message.data.thread ?? null;
        if (thread !== null && event.actor !== "board") {
          this.posts.set(thread, (this.posts.get(thread) ?? 0) + 1);
        }
        const place = thread ?? `#${message.data.channel}`;
        if (event.actor === USER_NAME) {
          if (this.asked.delete(place)) {
            this.decide(event, "answers");
          }
        } else if (message.data.mentions.includes(USER_NAME)) {
          this.asked.add(place);
        }
        if (event.actor !== "board" && message.data.mentions.length > 0) {
          this.converse(event);
        }
        break;
      }
      case "ops.signal": {
        const signal = SignalPayload.safeParse(event.payload);
        if (
          signal.success &&
          signal.data.kind === "blocked_capability" &&
          signal.data.taskId !== undefined
        ) {
          this.blocked.push({ at, ts: event.ts, taskId: signal.data.taskId, signal: signal.data });
        }
        break;
      }
      default:
        break;
    }
  }

  /** The tasks whose title or stage names the answer for a window reads. */
  tasksRead(window: MetricsWindow, now: Date): Set<string> {
    const since = windowStart(window, now);
    const ids = new Set<string>();
    for (const { taskId } of this.finished.from(since)) ids.add(taskId);
    for (const { taskId } of this.sentBack.from(since)) ids.add(taskId);
    for (const { taskId } of this.blocked.from(since)) ids.add(taskId);
    return ids;
  }

  /** The measures over a window, given the tasks `tasksRead` names and today's citizens. */
  answer(input: Omit<MetricsInput, "events" | "actions">): Metrics {
    const since = windowStart(input.window, input.now);
    const inWindow = (at: number): boolean => since === null || at >= since;
    const tally = new MetricsTally(input);
    for (const end of this.ends.from(since)) {
      tally.turnEnded(end.agent, end.trigger, end.heartbeat, end.actions);
    }
    // In the order they were answered, as replaying the log meets them.
    const matching = this.matchingFor(input.citizens);
    for (const { mention, at } of matching.answered) {
      if (inWindow(mention.at)) {
        tally.answered(mention.agent, at - mention.at);
      }
    }
    for (const { taskId, project } of this.finished.from(since)) {
      tally.taskFinished(taskId, project);
    }
    for (const { taskId, project, from, by } of this.sentBack.from(since)) {
      tally.sentBack(taskId, project, from, by);
    }
    for (const { ts, kind } of this.decisions.from(since)) {
      tally.decided(ts, kind);
    }
    for (const { ts, taskId, signal } of this.blocked.from(since)) {
      tally.blockedOn(taskId, ts, signal);
    }
    let unanswered = 0;
    for (const mention of matching.made) {
      if (inWindow(mention.at) && !matching.answeredSet.has(mention)) {
        unanswered += 1;
      }
    }
    return tally.finish(this.moves, this.posts, unanswered);
  }

  private decide(event: BoardEvent, kind: DecisionKind): void {
    if (event.actor === USER_NAME) {
      this.decisions.push({ at: Date.parse(event.ts), ts: event.ts, kind });
    }
  }

  private converse(event: BoardEvent): void {
    this.conversation.push(event);
    if (this.matching !== null) {
      this.match(this.matching, event);
    }
  }

  private match(matching: Matching, event: BoardEvent): void {
    if (event.type === "message.posted") {
      matching.made.push(...matching.matcher.post(event));
      return;
    }
    const at = Date.parse(event.ts);
    for (const mention of matching.matcher.answer(event)) {
      matching.answered.push({ mention, at });
      matching.answeredSet.add(mention);
    }
  }

  /** The matching for these citizens, made again from the kept events when the roster changed. */
  private matchingFor(citizens: readonly MatchingCitizen[]): Matching {
    const roster = JSON.stringify(
      citizens
        .map((citizen) => [citizen.name, citizen.memberships] as const)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    if (this.matching?.roster === roster) {
      return this.matching;
    }
    const matching: Matching = {
      roster,
      matcher: new MentionMatcher(new Map(citizens.map((citizen) => [citizen.name, citizen]))),
      made: [],
      answered: [],
      answeredSet: new Set(),
    };
    for (const event of this.conversation) {
      this.match(matching, event);
    }
    this.matching = matching;
    return matching;
  }
}
