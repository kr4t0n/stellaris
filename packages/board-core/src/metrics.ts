import {
  METRICS_WINDOW_MS,
  parseChannelRef,
  USER_NAME,
  wakeScope,
  type BoardEvent,
  type Metrics,
  type MetricsWindow,
  type Task,
} from "@stellaris/shared";
import { z } from "zod";

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

// A turn's events carry its thread as the thread's id, absent for a home turn.
const TurnPayload = z.object({
  turnId: z.string().optional(),
  project: z.string(),
  thread: z.string().optional(),
  trigger: z.string(),
});
const TaskPayload = z.object({
  taskId: z.string(),
  project: z.string(),
  from: z.string().optional(),
});
const MessagePayload = z.object({
  id: z.string().optional(),
  channel: z.string(),
  thread: z.string().nullable().optional(),
  mentions: z.array(z.string()).default([]),
});
const SteeredPayload = z.object({ messages: z.array(z.string()) });
const SignalPayload = z.object({
  kind: z.string(),
  key: z.string(),
  summary: z.string(),
  taskId: z.string().optional(),
  project: z.string().optional(),
});

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

/** A mention waiting for its turn: who was named, where, and when. */
interface Mention {
  readonly agent: string;
  readonly at: number;
  /** The post that made it, which a turn already running may have been handed. */
  readonly message: string | null;
  /** The thread it was made in, or null for a channel, whose wake goes to the scope's home. */
  readonly thread: string | null;
  /**
   * Scopes the mention may have woken its citizen in: the channel's project, and the scope the
   * wake rule gives with today's memberships, which an archive since may have changed.
   */
  readonly scopes: readonly string[];
}

/**
 * Whether a turn is the one a mention woke: in the mention's thread, or for a channel mention the
 * home of the scope it wakes. Before threads had conversations of their own, a mention in a thread
 * woke the home of the scope too, so a home turn woken by a mention answers one.
 */
function answers(
  mention: Mention,
  turn: { agent: string; at: number; thread: string | null; project: string; trigger: string },
): boolean {
  if (mention.agent !== turn.agent || mention.at > turn.at) {
    return false;
  }
  if (turn.thread !== null) {
    return mention.thread === turn.thread;
  }
  return (
    mention.scopes.includes(turn.project) && (mention.thread === null || turn.trigger === "mention")
  );
}

/**
 * Six measures of how the society works, from its event log alone (and the action counts read
 * from the turns' transcripts). A window counts what happened in it; what a measure needs from
 * before it, such as the send-backs of a task finished inside it, is read from the whole log.
 */
export function computeMetrics(input: MetricsInput): Metrics {
  const { events, now, window } = input;
  const span = METRICS_WINDOW_MS[window];
  const since = span === null ? null : now.getTime() - span;
  const inWindow = (ts: string): boolean => since === null || Date.parse(ts) >= since;
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const citizens = new Map(input.citizens.map((citizen) => [citizen.name, citizen]));

  // Turns that changed nothing on the board.
  const turnRows = new Map<string, { turns: number; idle: number }>();
  const agentRows = new Map<string, { turns: number; idle: number }>();
  let turns = 0;
  let idle = 0;
  let unknown = 0;
  // Send-backs and thread posts, by task, over the whole log.
  const moves = new Map<string, number>();
  const posts = new Map<string, number>();
  const finished = new Map<string, string>();
  const movedFrom = new Map<string, number>();
  const movedBy = new Map<string, number>();
  // The user's decisions by day, and the places where a question to the user waits for an answer.
  const days = new Map<string, { proposals: number; answers: number; stages: number }>();
  const asked = new Set<string>();
  const decide = (ts: string, kind: "proposals" | "answers" | "stages"): void => {
    const day = ts.slice(0, 10);
    const row = days.get(day) ?? { proposals: 0, answers: 0, stages: 0 };
    row[kind] += 1;
    days.set(day, row);
  };
  // Mentions waiting for the turn they woke, and the latencies found.
  let waiting: Mention[] = [];
  const latencies = new Map<string, number[]>();
  const blocked = new Map<
    string,
    { project: string | null; summary: string; firstAt: string; lastAt: string; key: string }
  >();

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
        if (actions === null) {
          unknown += 1;
          break;
        }
        const nothing = actions === 0 ? 1 : 0;
        turns += 1;
        idle += nothing;
        for (const [rows, key] of [
          [turnRows, turn.data.trigger],
          [agentRows, event.actor],
        ] as const) {
          const row = rows.get(key) ?? { turns: 0, idle: 0 };
          rows.set(key, { turns: row.turns + 1, idle: row.idle + nothing });
        }
        break;
      }
      case "turn.started": {
        const turn = TurnPayload.safeParse(event.payload);
        if (!turn.success) {
          break;
        }
        const at = Date.parse(event.ts);
        const started = {
          agent: event.actor,
          at,
          thread: turn.data.thread ?? null,
          project: turn.data.project,
          trigger: turn.data.trigger,
        };
        // A turn in a conversation answers every mention of its citizen waiting there.
        const answered = waiting.filter((mention) => answers(mention, started));
        if (answered.length > 0) {
          latencies.set(event.actor, [
            ...(latencies.get(event.actor) ?? []),
            ...answered.map((mention) => at - mention.at),
          ]);
          waiting = waiting.filter((mention) => !answered.includes(mention));
        }
        break;
      }
      case "turn.steered": {
        // A mention delivered into a turn already running in its conversation is answered there.
        const steered = SteeredPayload.safeParse(event.payload);
        if (!steered.success) {
          break;
        }
        const delivered = new Set(steered.data.messages);
        const at = Date.parse(event.ts);
        const answered = waiting.filter(
          (mention) =>
            mention.agent === event.actor &&
            mention.message !== null &&
            delivered.has(mention.message),
        );
        if (answered.length > 0) {
          latencies.set(event.actor, [
            ...(latencies.get(event.actor) ?? []),
            ...answered.map((mention) => at - mention.at),
          ]);
          waiting = waiting.filter((mention) => !answered.includes(mention));
        }
        break;
      }
      case "task.completed": {
        const task = TaskPayload.safeParse(event.payload);
        if (counted && task.success) {
          finished.set(task.data.taskId, task.data.project);
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
          const stage =
            tasks.get(task.data.taskId)?.stages.find((each) => each.id === task.data.from)?.name ??
            task.data.from ??
            "?";
          bump(movedFrom, `${task.data.project}\u0000${stage}`);
          bump(movedBy, event.actor);
          if (event.actor === USER_NAME) {
            decide(event.ts, "stages");
          }
        }
        break;
      }
      case "task.advanced": {
        if (counted && event.actor === USER_NAME) {
          decide(event.ts, "stages");
        }
        break;
      }
      case "proposal.decided": {
        if (counted && event.actor === USER_NAME) {
          decide(event.ts, "proposals");
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
            decide(event.ts, "answers");
          }
        } else if (message.data.mentions.includes(USER_NAME)) {
          asked.add(place);
        }
        if (!counted || event.actor === "board") {
          break;
        }
        const project = parseChannelRef(message.data.channel).project;
        for (const name of new Set(message.data.mentions)) {
          const citizen = citizens.get(name);
          if (citizen === undefined || name === event.actor) {
            continue;
          }
          waiting.push({
            agent: name,
            at: Date.parse(event.ts),
            message: message.data.id ?? null,
            thread,
            scopes: [project, wakeScope(citizen, project)].filter(
              (scope): scope is string => scope !== null,
            ),
          });
        }
        break;
      }
      case "ops.signal": {
        const signal = SignalPayload.safeParse(event.payload);
        if (!counted || !signal.success || signal.data.kind !== "blocked_capability") {
          break;
        }
        const id = signal.data.taskId;
        if (id === undefined) {
          break;
        }
        const seen = blocked.get(id);
        blocked.set(id, {
          project: signal.data.project ?? null,
          summary: signal.data.summary,
          firstAt: seen?.firstAt ?? event.ts,
          lastAt: event.ts,
          key: signal.data.key,
        });
        break;
      }
      default:
        break;
    }
  }

  const finishedIds = [...finished.keys()];
  const messagesOf = (id: string): number => posts.get(id) ?? 0;
  const projects = new Map<string, { finished: number; messages: number }>();
  for (const [id, project] of finished) {
    const row = projects.get(project) ?? { finished: 0, messages: 0 };
    projects.set(project, { finished: row.finished + 1, messages: row.messages + messagesOf(id) });
  }
  const allLatencies = [...latencies.values()].flat();

  return {
    window,
    since: since === null ? null : new Date(since).toISOString(),
    until: now.toISOString(),
    idle: {
      turns,
      idle,
      unknown,
      byTrigger: [...turnRows]
        .map(([trigger, row]) => ({ trigger, ...row }))
        .toSorted((a, b) => b.idle - a.idle || b.turns - a.turns),
      byAgent: [...agentRows]
        .map(([agent, row]) => ({ agent, role: citizens.get(agent)?.role ?? null, ...row }))
        .toSorted((a, b) => b.idle - a.idle || b.turns - a.turns),
    },
    sentBack: {
      finished: finishedIds.length,
      sendBacks: finishedIds.reduce((sum, id) => sum + (moves.get(id) ?? 0), 0),
      tasksSentBack: finishedIds.filter((id) => (moves.get(id) ?? 0) > 0).length,
      byStage: [...movedFrom]
        .map(([key, count]) => {
          const [project = "", stage = ""] = key.split("\u0000");
          return { project, stage, count };
        })
        .toSorted(byCount),
      bySender: [...movedBy].map(([agent, count]) => ({ agent, count })).toSorted(byCount),
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
          title: tasks.get(id)?.title ?? id,
          project: finished.get(id) ?? "",
          messages: messagesOf(id),
        }))
        .toSorted((a, b) => b.messages - a.messages)
        .slice(0, 5),
    },
    latency: {
      mentions: allLatencies.length,
      unanswered: waiting.length,
      medianMs: median(allLatencies),
      slowestMs: allLatencies.length === 0 ? null : Math.max(...allLatencies),
      byAgent: [...latencies]
        .map(([agent, list]) => ({
          agent,
          mentions: list.length,
          medianMs: median(list) ?? 0,
          slowestMs: Math.max(...list),
        }))
        .toSorted((a, b) => b.medianMs - a.medianMs),
    },
    decisions: {
      total: [...days.values()].reduce(
        (sum, row) => sum + row.proposals + row.answers + row.stages,
        0,
      ),
      byDay: [...days]
        .map(([day, row]) => ({ day, ...row }))
        .toSorted((a, b) => b.day.localeCompare(a.day)),
    },
    blocked: [...blocked].map(([taskId, row]) => ({
      taskId,
      title: tasks.get(taskId)?.title ?? null,
      project: row.project,
      summary: row.summary,
      firstAt: row.firstAt,
      lastAt: row.lastAt,
      holds: input.activeSignals.has(row.key),
    })),
  };
}
