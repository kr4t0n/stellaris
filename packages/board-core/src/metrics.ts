import {
  METRICS_WINDOW_MS,
  USER_NAME,
  type BoardEvent,
  type HeartbeatCause,
  type Metrics,
  type MetricsWindow,
  type Task,
} from "@stellaris/shared";
import { z } from "zod";
import { MentionMatcher, MessagePayload, TurnPayload } from "./mention-matching.js";

/** A citizen as the metrics need it: its role, and where a channel mention would wake it. */
export interface MetricsCitizen {
  readonly name: string;
  readonly role: string;
  readonly memberships: readonly string[];
}

export interface MetricsInput {
  /** The whole event log, oldest first: a window still needs what came before it. */
  readonly events: readonly BoardEvent[];
  /** Every task, archived projects' included, for titles and stage names. */
  readonly tasks: readonly Task[];
  readonly citizens: readonly MetricsCitizen[];
  /** Board actions each finished turn took, by turn id; null for a turn without a transcript. */
  readonly actions: ReadonlyMap<string, number | null>;
  /** Keys of the operations conditions holding now. */
  readonly activeSignals: ReadonlySet<string>;
  readonly window: MetricsWindow;
  readonly now: Date;
}

export const TaskPayload = z.object({
  taskId: z.string(),
  project: z.string(),
  from: z.string().optional(),
});
export const SignalPayload = z.object({
  kind: z.string(),
  key: z.string(),
  summary: z.string(),
  taskId: z.string().optional(),
  project: z.string().optional(),
});
export type SignalPayload = z.infer<typeof SignalPayload>;

/** A decision of the user's, as the decisions measure counts them by day. */
export type DecisionKind = "proposals" | "answers" | "stages";

/** The start of a window, in milliseconds since the epoch, or null for the whole log. */
export function windowStart(window: MetricsWindow, now: Date): number | null {
  const span = METRICS_WINDOW_MS[window];
  return span === null ? null : now.getTime() - span;
}

function median(values: readonly number[]): number | null {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) {
    return null;
  }
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function byCount<T extends { count: number }>(a: T, b: T): number {
  return b.count - a.count;
}

/**
 * What the six measures gather over a window, one counted event at a time, and the answer shaped
 * from it. `computeMetrics` feeds one from the log and the index from what it kept, so the two
 * differ only in which events they count, and in the order they count them, which sets the order
 * of rows that tie.
 */
export class MetricsTally {
  private readonly tasks: ReadonlyMap<string, Task>;
  private readonly citizens: ReadonlyMap<string, MetricsCitizen>;
  // Turns that changed nothing on the board, by trigger and, for a heartbeat, what it woke for.
  private readonly turnRows = new Map<
    string,
    { trigger: string; heartbeat: HeartbeatCause | undefined; turns: number; idle: number }
  >();
  private readonly agentRows = new Map<string, { turns: number; idle: number }>();
  private turns = 0;
  private idle = 0;
  private unknown = 0;
  private readonly finished = new Map<string, string>();
  private readonly movedFrom = new Map<string, number>();
  private readonly movedBy = new Map<string, number>();
  // The user's decisions by day.
  private readonly days = new Map<string, { proposals: number; answers: number; stages: number }>();
  private readonly latencies = new Map<string, number[]>();
  private readonly blocked = new Map<
    string,
    { project: string | null; summary: string; firstAt: string; lastAt: string; key: string }
  >();

  constructor(
    private readonly input: Pick<
      MetricsInput,
      "tasks" | "citizens" | "activeSignals" | "window" | "now"
    >,
  ) {
    this.tasks = new Map(input.tasks.map((task) => [task.id, task]));
    this.citizens = new Map(input.citizens.map((citizen) => [citizen.name, citizen]));
  }

  /** A finished turn that is not a reflection, with its board actions, null when unknown. */
  turnEnded(
    agent: string,
    trigger: string,
    heartbeat: HeartbeatCause | undefined,
    actions: number | null,
  ): void {
    if (actions === null) {
      this.unknown += 1;
      return;
    }
    const nothing = actions === 0 ? 1 : 0;
    this.turns += 1;
    this.idle += nothing;
    const key = heartbeat === undefined ? trigger : `${trigger}\u0000${heartbeat}`;
    const row = this.turnRows.get(key) ?? { trigger, heartbeat, turns: 0, idle: 0 };
    this.turnRows.set(key, { ...row, turns: row.turns + 1, idle: row.idle + nothing });
    const own = this.agentRows.get(agent) ?? { turns: 0, idle: 0 };
    this.agentRows.set(agent, { turns: own.turns + 1, idle: own.idle + nothing });
  }

  taskFinished(taskId: string, project: string): void {
    this.finished.set(taskId, project);
  }

  /** A send-back, named by the stage its task left as the task names it now. */
  sentBack(taskId: string, project: string, from: string | undefined, by: string): void {
    const stage =
      this.tasks.get(taskId)?.stages.find((each) => each.id === from)?.name ?? from ?? "?";
    bump(this.movedFrom, `${project}\u0000${stage}`);
    bump(this.movedBy, by);
  }

  decided(ts: string, kind: DecisionKind): void {
    const day = ts.slice(0, 10);
    const row = this.days.get(day) ?? { proposals: 0, answers: 0, stages: 0 };
    row[kind] += 1;
    this.days.set(day, row);
  }

  /** A mention answered `ms` after it was made. */
  answered(agent: string, ms: number): void {
    const list = this.latencies.get(agent);
    if (list === undefined) {
      this.latencies.set(agent, [ms]);
    } else {
      list.push(ms);
    }
  }

  /** A `blocked_capability` signal naming a task. */
  blockedOn(taskId: string, ts: string, signal: SignalPayload): void {
    const seen = this.blocked.get(taskId);
    this.blocked.set(taskId, {
      project: signal.project ?? null,
      summary: signal.summary,
      firstAt: seen?.firstAt ?? ts,
      lastAt: ts,
      key: signal.key,
    });
  }

  /**
   * The answer, with the send-backs and thread posts of every task over the whole log, and the
   * mentions made in the window that still wait.
   */
  finish(
    moves: ReadonlyMap<string, number>,
    posts: ReadonlyMap<string, number>,
    unanswered: number,
  ): Metrics {
    const { now, window } = this.input;
    const since = windowStart(window, now);
    const finishedIds = [...this.finished.keys()];
    const messagesOf = (id: string): number => posts.get(id) ?? 0;
    const projects = new Map<string, { finished: number; messages: number }>();
    for (const [id, project] of this.finished) {
      const row = projects.get(project) ?? { finished: 0, messages: 0 };
      projects.set(project, {
        finished: row.finished + 1,
        messages: row.messages + messagesOf(id),
      });
    }
    const allLatencies = [...this.latencies.values()].flat();

    return {
      window,
      since: since === null ? null : new Date(since).toISOString(),
      until: now.toISOString(),
      idle: {
        turns: this.turns,
        idle: this.idle,
        unknown: this.unknown,
        byTrigger: [...this.turnRows.values()]
          .map(({ heartbeat, ...row }) => ({
            ...row,
            ...(heartbeat === undefined ? {} : { heartbeat }),
          }))
          .toSorted((a, b) => b.idle - a.idle || b.turns - a.turns),
        byAgent: [...this.agentRows]
          .map(([agent, row]) => ({ agent, role: this.citizens.get(agent)?.role ?? null, ...row }))
          .toSorted((a, b) => b.idle - a.idle || b.turns - a.turns),
      },
      sentBack: {
        finished: finishedIds.length,
        sendBacks: finishedIds.reduce((sum, id) => sum + (moves.get(id) ?? 0), 0),
        tasksSentBack: finishedIds.filter((id) => (moves.get(id) ?? 0) > 0).length,
        byStage: [...this.movedFrom]
          .map(([key, count]) => {
            const [project = "", stage = ""] = key.split("\u0000");
            return { project, stage, count };
          })
          .toSorted(byCount),
        bySender: [...this.movedBy].map(([agent, count]) => ({ agent, count })).toSorted(byCount),
      },
      messages: {
        finished: finishedIds.length,
        messages: finishedIds.reduce((sum, id) => sum + messagesOf(id), 0),
        byProject: [...projects]
          .map(([project, row]) => ({ project, ...row }))
          .toSorted((a, b) => b.messages - a.messages),
        busiest: finishedIds
          .map((id) => ({
            taskId: id,
            title: this.tasks.get(id)?.title ?? id,
            project: this.finished.get(id) ?? "",
            messages: messagesOf(id),
          }))
          .toSorted((a, b) => b.messages - a.messages)
          .slice(0, 5),
      },
      latency: {
        mentions: allLatencies.length,
        unanswered,
        medianMs: median(allLatencies),
        slowestMs: allLatencies.length === 0 ? null : Math.max(...allLatencies),
        byAgent: [...this.latencies]
          .map(([agent, list]) => ({
            agent,
            mentions: list.length,
            medianMs: median(list) ?? 0,
            slowestMs: Math.max(...list),
          }))
          .toSorted((a, b) => b.medianMs - a.medianMs),
      },
      decisions: {
        total: [...this.days.values()].reduce(
          (sum, row) => sum + row.proposals + row.answers + row.stages,
          0,
        ),
        byDay: [...this.days]
          .map(([day, row]) => ({ day, ...row }))
          .toSorted((a, b) => b.day.localeCompare(a.day)),
      },
      blocked: [...this.blocked].map(([taskId, row]) => ({
        taskId,
        title: this.tasks.get(taskId)?.title ?? null,
        project: row.project,
        summary: row.summary,
        firstAt: row.firstAt,
        lastAt: row.lastAt,
        holds: this.input.activeSignals.has(row.key),
      })),
    };
  }
}

/**
 * Six measures of how the society works, from its event log alone (and the action counts read
 * from the turns' transcripts). A window counts what happened in it; what a measure needs from
 * before it, such as the send-backs of a task finished inside it, is read from the whole log.
 *
 * This is the measures' definition, which the server answers from `MetricsIndex` instead so that
 * no request reads the log: a change to a measure changes both, and the index's equality test
 * holds them to the same answer.
 */
export function computeMetrics(input: MetricsInput): Metrics {
  const { events, now, window } = input;
  const since = windowStart(window, now);
  const inWindow = (ts: string): boolean => since === null || Date.parse(ts) >= since;
  const tally = new MetricsTally(input);
  const matcher = new MentionMatcher(new Map(input.citizens.map((each) => [each.name, each])));
  // Send-backs and thread posts, by task, over the whole log.
  const moves = new Map<string, number>();
  const posts = new Map<string, number>();
  // The places where a question to the user waits for an answer.
  const asked = new Set<string>();

  for (const event of events) {
    const counted = inWindow(event.ts);
    switch (event.type) {
      case "turn.completed": {
        const turn = TurnPayload.safeParse(event.payload);
        if (!counted || !turn.success || turn.data.trigger === "reflection") {
          break;
        }
        const actions =
          turn.data.turnId === undefined ? null : (input.actions.get(turn.data.turnId) ?? null);
        tally.turnEnded(event.actor, turn.data.trigger, turn.data.heartbeat, actions);
        break;
      }
      case "turn.started":
      case "turn.steered": {
        // Mentions are made only in the window, so every one answered here counts.
        const at = Date.parse(event.ts);
        for (const mention of matcher.answer(event)) {
          tally.answered(event.actor, at - mention.at);
        }
        break;
      }
      case "task.completed": {
        const task = TaskPayload.safeParse(event.payload);
        if (counted && task.success) {
          tally.taskFinished(task.data.taskId, task.data.project);
        }
        break;
      }
      case "task.moved": {
        const task = TaskPayload.safeParse(event.payload);
        if (!task.success) {
          break;
        }
        bump(moves, task.data.taskId);
        if (counted) {
          tally.sentBack(task.data.taskId, task.data.project, task.data.from, event.actor);
          if (event.actor === USER_NAME) {
            tally.decided(event.ts, "stages");
          }
        }
        break;
      }
      case "task.advanced": {
        if (counted && event.actor === USER_NAME) {
          tally.decided(event.ts, "stages");
        }
        break;
      }
      case "proposal.decided": {
        if (counted && event.actor === USER_NAME) {
          tally.decided(event.ts, "proposals");
        }
        break;
      }
      case "message.posted": {
        const message = MessagePayload.safeParse(event.payload);
        if (!message.success) {
          break;
        }
        const thread = message.data.thread ?? null;
        if (thread !== null && event.actor !== "board") {
          bump(posts, thread);
        }
        const place = thread ?? `#${message.data.channel}`;
        if (event.actor === USER_NAME) {
          if (asked.delete(place) && counted) {
            tally.decided(event.ts, "answers");
          }
        } else if (message.data.mentions.includes(USER_NAME)) {
          asked.add(place);
        }
        if (counted) {
          matcher.post(event);
        }
        break;
      }
      case "ops.signal": {
        const signal = SignalPayload.safeParse(event.payload);
        if (!counted || !signal.success || signal.data.kind !== "blocked_capability") {
          break;
        }
        const id = signal.data.taskId;
        if (id !== undefined) {
          tally.blockedOn(id, event.ts, signal.data);
        }
        break;
      }
      default:
        break;
    }
  }

  return tally.finish(moves, posts, matcher.unanswered);
}
