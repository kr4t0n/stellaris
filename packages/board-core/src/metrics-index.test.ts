import {
  BoardEventSchema,
  OPS_SIGNAL_KINDS,
  TaskFrontmatterSchema,
  type BoardEvent,
  type MetricsWindow,
  type Task,
} from "@stellaris/shared";
import { describe, expect, it, vi } from "vitest";
import { MetricsIndex } from "./metrics-index.js";
import { computeMetrics, MetricsTally, type MetricsCitizen } from "./metrics.js";
import { signalsIn } from "./signals.js";
import { entriesOf, tokenUse, TurnHistoryPayloadSchema, turnHistoryIn } from "./turn-history.js";
import { WakeLatency } from "./wake-latency.js";

/** A small seeded generator, so a failing log can be made again from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const TASKS = [
  "01ARZ3NDEKTSV4RRFFQ69G5FA1",
  "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  "01ARZ3NDEKTSV4RRFFQ69G5FA3",
];
// A task no project holds any more, whose rows fall back to its id.
const GONE = "01ARZ3NDEKTSV4RRFFQ69G5FA9";
const THREADS = [...TASKS, GONE, "01ARZ3NDEKTSV4RRFFQ69G5FT1"];
// Everyone who acts; `ops-9` is a citizen only in the second roster, `user` and `board` never.
const ACTORS = ["eng-1", "rev-1", "con-1", "ops-9", "user", "board"];
const CHANNELS = ["general", "asks", "lab/general", "lab/build", "ops/general", "ops/deploy"];
const TRIGGERS = ["mention", "heartbeat", "stage", "cron", "reflection", "manual", "user_post"];
// `none` leaves the field out.
const HEARTBEATS = ["unread", "held", "waiting", "not-a-cause", "none"];
const STAGES = ["s1", "s2", "s3", "s9", "none"];
const START = Date.parse("2026-10-01T00:00:00.000Z");
const QUARTER = 15 * 60_000;
const DAY = 24 * 3_600_000;

const ROSTERS: readonly (readonly MetricsCitizen[])[] = [
  [
    { name: "con-1", role: "concierge", memberships: [] },
    { name: "eng-1", role: "engineer", memberships: ["lab"] },
    { name: "rev-1", role: "reviewer", memberships: ["lab", "ops"] },
  ],
  // eng-1 left lab, as an archive leaves it, and ops-9 joined ops.
  [
    { name: "con-1", role: "concierge", memberships: [] },
    { name: "eng-1", role: "engineer", memberships: [] },
    { name: "rev-1", role: "reviewer", memberships: ["lab", "ops"] },
    { name: "ops-9", role: "operator", memberships: ["ops"] },
  ],
];

function task(id: string, names: readonly string[]): Task {
  return {
    ...TaskFrontmatterSchema.parse({
      id,
      project: "lab",
      title: `Task ${id.slice(-2)}`,
      status: "done",
      createdBy: "con-1",
      createdAt: new Date(START).toISOString(),
      updatedAt: new Date(START).toISOString(),
      blockedBy: [],
      requiredCapabilities: [],
      stages: names.map((name, at) => ({ id: `s${at + 1}`, name })),
      stage: "s1",
      stageSince: new Date(START).toISOString(),
      stageSeq: names.length,
    }),
    body: "",
  };
}

const ALL_TASKS = [
  task(TASKS[0] ?? "", ["build", "review"]),
  task(TASKS[1] ?? "", ["draft", "check", "ship"]),
  // Two stages of one name, whose send-backs share a row.
  task(TASKS[2] ?? "", ["review", "review"]),
];

interface Log {
  readonly events: BoardEvent[];
  /** Board actions read from the transcripts of ends logged without them. */
  readonly transcripts: Map<string, number | null>;
}

/**
 * A log of every shape the measures read: turns in threads, channels, and projects' channels,
 * with and without ids, counts, and heartbeat causes; posts naming citizens, others, the author,
 * and the user, by citizens, the user, and the board; steers; finished, sent back, and advanced
 * tasks; decided proposals; signals; payloads the metrics cannot read; a clock that now and
 * then steps back, rarely by more than the week a mention waits; and a few gaps of days, so
 * mentions wait past it.
 */
function generate(seed: number, count: number): Log {
  const next = random(seed);
  const pick = <T>(values: readonly T[]): T => {
    const value = values[Math.floor(next() * values.length)];
    if (value === undefined) {
      throw new Error("nothing to pick from");
    }
    return value;
  };
  const events: BoardEvent[] = [];
  const transcripts = new Map<string, number | null>();
  const messages: string[] = [];
  let clock = START;
  for (let n = 0; n < count; n += 1) {
    // On a quarter-hour grid, so events share moments and rows tie, whose order then shows.
    clock += Math.floor(next() * 6) * QUARTER;
    if (next() < 0.01) {
      clock += (4 + Math.floor(next() * 4)) * DAY;
    }
    // Now and then the board's clock steps back.
    const back = next();
    const at =
      back < 0.04
        ? clock - Math.floor(next() * 12) * QUARTER
        : back < 0.045
          ? clock - 8 * DAY
          : clock;
    const id = `01M3S${String(seed % 1000).padStart(3, "0")}${String(n).padStart(18, "0")}`;
    const actor = pick(ACTORS);
    const turnId =
      next() < 0.85
        ? `01M3T${String(seed % 1000).padStart(3, "0")}${String(n).padStart(18, "0")}`
        : undefined;
    const where = (): object => {
      const place = next();
      if (place < 0.4) {
        return { project: pick(["lab", "ops", "society"]), thread: pick(THREADS) };
      }
      if (place < 0.6) {
        return { project: pick(["lab", "ops"]), channel: pick(["build", "deploy"]) };
      }
      if (place < 0.75) {
        return { project: "society", place: pick(["lab", "ops"]) };
      }
      return { project: pick(["lab", "ops", "society"]) };
    };
    const kind = next();
    let type: BoardEvent["type"];
    let payload: Record<string, unknown>;
    if (kind < 0.22) {
      type = "turn.started";
      payload = {
        ...(turnId === undefined ? {} : { turnId }),
        ...where(),
        trigger: pick(TRIGGERS),
      };
    } else if (kind < 0.42) {
      type = "turn.completed";
      const heartbeat = pick(HEARTBEATS);
      const counted = next();
      payload = {
        ...(turnId === undefined ? {} : { turnId }),
        ...where(),
        trigger: pick(TRIGGERS),
        ...(heartbeat === "none" ? {} : { heartbeat }),
        ...(counted < 0.5 ? { boardActions: Math.floor(next() * 3) } : {}),
      };
      if (turnId !== undefined && counted >= 0.5) {
        transcripts.set(turnId, pick([0, 0, 1, 4, null]));
      }
    } else if (kind < 0.47) {
      type = "turn.steered";
      payload = { messages: [pick(messages.length > 0 ? messages : ["none"]), "other"] };
    } else if (kind < 0.72) {
      type = "message.posted";
      const thread = next();
      const message = `01M3M${String(seed % 1000).padStart(3, "0")}${String(n).padStart(18, "0")}`;
      messages.push(message);
      payload = {
        ...(next() < 0.9 ? { id: message } : {}),
        channel: pick(CHANNELS),
        ...(thread < 0.45 ? { thread: pick(THREADS) } : thread < 0.55 ? { thread: null } : {}),
        mentions: ACTORS.filter(() => next() < 0.25),
      };
    } else if (kind < 0.78) {
      type = "task.moved";
      const from = pick(STAGES);
      payload = {
        taskId: pick([...TASKS, GONE]),
        project: pick(["lab", "ops"]),
        ...(from === "none" ? {} : { from }),
      };
    } else if (kind < 0.83) {
      type = "task.completed";
      payload = { taskId: pick([...TASKS, GONE]), project: pick(["lab", "ops"]) };
    } else if (kind < 0.87) {
      type = "task.advanced";
      payload = { taskId: pick(TASKS), project: "lab" };
    } else if (kind < 0.9) {
      type = "proposal.decided";
      payload = { proposalId: id, decision: "approved" };
    } else if (kind < 0.95) {
      type = "ops.signal";
      payload = {
        kind: pick(["blocked_capability", "blocked_capability", "idle_member"]),
        key: `key-${Math.floor(next() * 3)}`,
        summary: `summary ${n}`,
        ...(next() < 0.8 ? { taskId: pick([...TASKS, GONE]) } : {}),
        ...(next() < 0.7 ? { project: pick(["lab", "ops"]) } : {}),
      };
    } else {
      // A payload the metrics cannot read, or an event they pass over.
      type = pick<BoardEvent["type"]>([
        "turn.completed",
        "message.posted",
        "task.moved",
        "agent.added",
      ]);
      payload = { unreadable: true };
    }
    events.push({ id, ts: new Date(at).toISOString(), type, actor, payload });
  }
  return { events, transcripts };
}

/** The actions `computeMetrics` is given: each end's own count, else its transcript's. */
function actionsFor({ events, transcripts }: Log): Map<string, number | null> {
  const actions = new Map<string, number | null>();
  for (const event of events) {
    const turnId = event.payload["turnId"];
    const counted = event.payload["boardActions"];
    if (event.type === "turn.completed" && typeof turnId === "string") {
      actions.set(
        turnId,
        typeof counted === "number" ? counted : (transcripts.get(turnId) ?? null),
      );
    }
  }
  return actions;
}

const WINDOWS: readonly MetricsWindow[] = ["24h", "7d", "all"];

/** The count of tokens a turn's end carries, as written; empty when it carries none. */
function usageOf(event: BoardEvent): Record<string, unknown> {
  const counted = event.payload["usage"];
  return typeof counted === "object" && counted !== null ? { ...counted } : {};
}

/**
 * The log with what `tokenUse` reads on its turns' ends: some failed, some counting tokens, some
 * an older count without the cache, and some a count or a turn id the turn history cannot read.
 * Reflections, ends of payloads it cannot read, and turns' starts stay as the log has them.
 */
function withTokens(log: Log, seed: number): BoardEvent[] {
  const next = random(seed * 104_729);
  const tokens = (): number => Math.floor(next() * 5_000);
  return log.events.map((event) => {
    if (event.type !== "turn.completed") {
      return event;
    }
    const kind = next();
    const counted =
      kind < 0.45
        ? {
            usage: {
              inputTokens: tokens(),
              outputTokens: tokens(),
              cacheReadTokens: tokens(),
              cacheWriteTokens: tokens(),
            },
          }
        : kind < 0.6
          ? { usage: { inputTokens: tokens(), outputTokens: tokens() } }
          : kind < 0.65
            ? { usage: { inputTokens: -1, outputTokens: tokens() } }
            : kind < 0.7
              ? { turnId: "not-a-turn" }
              : {};
    return {
      ...event,
      type: next() < 0.3 ? "turn.failed" : event.type,
      payload: { ...event.payload, ...counted },
    };
  });
}

/** The shapes of signal `withSignals` gives, by the share of signals below which each falls. */
const SIGNAL_SHAPES = [
  ["bare", 0.25],
  ["full", 0.5],
  ["undefined", 0.65],
  ["unknownKind", 0.72],
  ["noValue", 0.79],
  ["emptySummary", 0.86],
  ["badTask", 0.93],
  ["valueNotANumber", 1],
] as const;
type SignalShape = (typeof SIGNAL_SHAPES)[number][0];

/**
 * The log with every signal in one of the shapes `listSignals` reads or refuses, its name in
 * `shapes` by the event's id: only the fields every signal has, every field it may have, fields
 * appended as undefined, as a publisher may hand them over, and payloads its schema refuses (a
 * kind it does not know, no value, an empty summary, a task that is no id, and a value that is
 * no number). Every other event stays as the log has it.
 */
function withSignals(
  log: Log,
  seed: number,
): { events: BoardEvent[]; shapes: Map<string, SignalShape> } {
  const next = random(seed * 15_485_863);
  const shapes = new Map<string, SignalShape>();
  const events = log.events.map((event, n) => {
    if (event.type !== "ops.signal") {
      return event;
    }
    const kind = OPS_SIGNAL_KINDS[Math.floor(next() * OPS_SIGNAL_KINDS.length)];
    const bare = {
      kind,
      key: `${kind}:${Math.floor(next() * 4)}`,
      summary: `summary ${n}`,
      value: Math.floor(next() * 100) / 4,
    };
    const roll = next();
    const shape = SIGNAL_SHAPES.find(([, below]) => roll < below)?.[0] ?? "bare";
    shapes.set(event.id, shape);
    const payload: Record<string, unknown> =
      shape === "bare"
        ? bare
        : shape === "full"
          ? {
              ...bare,
              threshold: 3,
              project: "lab",
              agent: "eng-1",
              role: "engineer",
              taskId: TASKS[n % TASKS.length],
              wakes: next() < 0.5,
            }
          : shape === "undefined"
            ? { ...bare, project: undefined, taskId: undefined, wakes: undefined }
            : shape === "unknownKind"
              ? { ...bare, kind: "not-a-kind" }
              : shape === "noValue"
                ? { kind: bare.kind, key: bare.key, summary: bare.summary }
                : shape === "emptySummary"
                  ? { ...bare, summary: "" }
                  : shape === "badTask"
                    ? { ...bare, taskId: "not-a-task" }
                    : { ...bare, value: { count: bare.value } };
    return { ...event, payload };
  });
  return { events, shapes };
}

/** The events as a read of the log gives them back: each written as a line, then parsed. */
function readBack(events: readonly BoardEvent[]): BoardEvent[] {
  return events.map((event) => BoardEventSchema.parse(JSON.parse(JSON.stringify(event))));
}

/** The limits an ask can give: none, a few, the turn host's read, NaN, and around the count. */
function limitsFor(count: number): number[] {
  return [0, 1, 2, 100, 501, Number.NaN, -1, count - 1, count, count + 1, 10 * count + 1_000];
}

/** The shapes of turn `withHistory` gives its starts and ends, each counted by name. */
const HISTORY_SHAPES = [
  "paired",
  "startMissing",
  "secondEnd",
  "othersStart",
  "noTurnId",
  "refused",
  "failed",
  "ownHeartbeat",
  "startHeartbeat",
  "laterCause",
  "replacedStart",
  "handedUndefined",
] as const;
type HistoryShape = (typeof HISTORY_SHAPES)[number];

/**
 * The log with turns whose starts and ends pair as a citizen's history pairs them, or fail to:
 * ends of a start of the citizen's own, of none logged, of one an earlier end took, of another
 * citizen's, of no turn id, and of a payload the history refuses; starts naming a cause, one a
 * later board added, or none, and starts of a turn started before; and fields handed over as
 * undefined, as a caller may hand them to `append`. Each turn event's shapes are in `shapes` by
 * its id; every other event stays as the log has it.
 */
function withHistory(
  events: readonly BoardEvent[],
  seed: number,
): { events: BoardEvent[]; shapes: Map<string, HistoryShape[]> } {
  const next = random(seed * 49_157);
  const pickFrom = <T>(values: readonly T[]): T | undefined =>
    values[Math.floor(next() * values.length)];
  const open = new Map<string, string[]>();
  const ended = new Map<string, string[]>();
  const started: { actor: string; turnId: string }[] = [];
  const shapes = new Map<string, HistoryShape[]>();
  const reshaped = events.map((event) => {
    const turnId = event.payload["turnId"];
    if (event.type === "turn.started" && typeof turnId === "string") {
      const waiting = open.get(event.actor) ?? [];
      open.set(event.actor, waiting);
      const kept: HistoryShape[] = [];
      const again = next() < 0.15 ? pickFrom(waiting) : undefined;
      if (again !== undefined) {
        kept.push("replacedStart");
      } else {
        waiting.push(turnId);
        started.push({ actor: event.actor, turnId });
      }
      const cause = next();
      const heartbeat =
        cause < 0.3
          ? { heartbeat: pickFrom(["unread", "held", "waiting"]) }
          : cause < 0.4
            ? { heartbeat: "a cause from a later board" }
            : cause < 0.5
              ? { heartbeat: undefined, thread: undefined }
              : {};
      if (cause < 0.5) {
        kept.push(cause < 0.3 ? "startHeartbeat" : cause < 0.4 ? "laterCause" : "handedUndefined");
      }
      shapes.set(event.id, kept);
      return { ...event, payload: { ...event.payload, turnId: again ?? turnId, ...heartbeat } };
    }
    if (event.type !== "turn.completed" && event.type !== "turn.failed") {
      return event;
    }
    const kept: HistoryShape[] = event.type === "turn.failed" ? ["failed"] : [];
    if (!TurnHistoryPayloadSchema.safeParse(event.payload).success) {
      shapes.set(event.id, [...kept, "refused"]);
      return event;
    }
    if (typeof event.payload["heartbeat"] === "string") {
      kept.push("ownHeartbeat");
    }
    const waiting = open.get(event.actor) ?? [];
    const done = ended.get(event.actor) ?? [];
    ended.set(event.actor, done);
    const others = started.filter((begun) => begun.actor !== event.actor);
    const roll = next();
    let named: { turnId?: string | undefined } = {};
    if (roll < 0.5 && waiting.length > 0) {
      const at = Math.floor(next() * waiting.length);
      const [paired] = waiting.splice(at, 1);
      named = { turnId: paired };
      done.push(paired ?? "");
      kept.push("paired");
    } else if (roll < 0.6 && done.length > 0) {
      named = { turnId: pickFrom(done) };
      kept.push("secondEnd");
    } else if (roll < 0.7 && others.length > 0) {
      named = { turnId: pickFrom(others)?.turnId };
      kept.push("othersStart");
    } else if (roll < 0.8) {
      kept.push("noTurnId");
    } else if (typeof turnId === "string") {
      named = { turnId };
      kept.push("startMissing");
    } else {
      kept.push("noTurnId");
    }
    const handed = next() < 0.2;
    if (handed) {
      kept.push("handedUndefined");
    }
    const { turnId: _own, ...payload } = event.payload;
    shapes.set(event.id, kept);
    return {
      ...event,
      payload: {
        ...payload,
        ...named,
        ...(handed ? { thread: undefined, usage: undefined, toolCalls: undefined } : {}),
      },
    };
  });
  return { events: reshaped, shapes };
}

/** The entries of the ends an index keeps, each read back from its line in `written`. */
function entriesFrom(
  index: MetricsIndex,
  written: readonly BoardEvent[],
  agent: string,
  limit: number,
): Promise<ReturnType<typeof turnHistoryIn> | null> {
  const lines = new Map(written.map((event) => [event.id, event]));
  return entriesOf(agent, index.turnEnds(agent, limit), async (ids) =>
    ids.map((id) => lines.get(id) ?? null),
  );
}

/** The limits a history's ask can give: none, a few, the API's default, the triage's, and around the count. */
function historyLimits(count: number): number[] {
  return [0, 1, 2, 50, 5_000, Number.NaN, -1, count - 1, count, count + 1];
}

/** The user's post naming `name` in a thread, `seconds` after the logs' start. */
function post(seconds: number, name: string): BoardEvent {
  return {
    id: `01M3S0000000000000000000${String(seconds).padStart(2, "0")}`,
    ts: new Date(START + seconds * 1000).toISOString(),
    type: "message.posted",
    actor: "user",
    payload: { channel: "lab/general", thread: TASKS[0], mentions: [name] },
  };
}

/** `agent`'s turn starting in that thread, `seconds` after the logs' start. */
function start(seconds: number, agent: string): BoardEvent {
  return {
    id: `01M3T0000000000000000000${String(seconds).padStart(2, "0")}`,
    ts: new Date(START + seconds * 1000).toISOString(),
    type: "turn.started",
    actor: agent,
    payload: { project: "lab", thread: TASKS[0], trigger: "mention" },
  };
}

/** A turn's end of eng-1's with `payload` over a counted turn's fields. */
function end(payload: object): BoardEvent {
  return {
    id: "01M3S000000000000000000001",
    ts: "2026-10-01T00:00:00.000Z",
    type: "turn.completed",
    actor: "eng-1",
    payload: { project: "lab", trigger: "stage", ...payload },
  };
}

describe("metrics index", () => {
  it("answers as the log's replay does, for every window, roster, and moment, as events arrive", () => {
    let compared = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const log = generate(seed, 240);
      const index = new MetricsIndex((turnId) => log.transcripts.get(turnId));
      const next = random(seed * 7919);
      let added = 0;
      // Asked three times as the log grows, so the matching is made, kept up, and made again.
      for (const [step, upTo] of [80, 160, 240].entries()) {
        for (const event of log.events.slice(added, upTo)) {
          index.add(event);
        }
        added = upTo;
        const events = log.events.slice(0, upTo);
        const last = Date.parse(events.at(-1)?.ts ?? "");
        const citizens = ROSTERS[step % ROSTERS.length] ?? [];
        // Just after the last event, and hours on, so a window's start falls inside an hour.
        for (const later of [60_000, Math.floor(next() * 30 * 3_600_000)]) {
          const now = new Date(last + later);
          for (const window of WINDOWS) {
            const shared = { citizens, activeSignals: new Set(["key-1"]), window, now };
            const expected = computeMetrics({
              ...shared,
              events,
              tasks: ALL_TASKS,
              actions: actionsFor({ events, transcripts: log.transcripts }),
            });
            // The board hands the index only the tasks it names.
            const named = index.tasksRead(window, now);
            const tasks = ALL_TASKS.filter((each) => named.has(each.id));
            expect(
              index.answer({ ...shared, tasks }),
              `seed ${seed} at ${upTo}, ${window}`,
            ).toStrictEqual(expected);
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(120 * 3 * 2 * 3);
  });

  it("counts a log whose every measure is busy, so the comparison is not of empty answers", () => {
    // Its mentions are answered, waiting, and past their week, too.
    const log = generate(14, 240);
    const index = new MetricsIndex((turnId) => log.transcripts.get(turnId));
    for (const event of log.events) {
      index.add(event);
    }
    const now = new Date(Date.parse(log.events.at(-1)?.ts ?? "") + 60_000);
    const all = index.answer({
      citizens: ROSTERS[0] ?? [],
      activeSignals: new Set(["key-1"]),
      window: "all",
      now,
      tasks: ALL_TASKS,
    });
    expect(all.idle.turns).toBeGreaterThan(10);
    expect(all.idle.idle).toBeGreaterThan(0);
    expect(all.idle.unknown).toBeGreaterThan(0);
    expect(all.sentBack.sendBacks).toBeGreaterThan(0);
    expect(all.sentBack.byStage.length).toBeGreaterThan(2);
    expect(all.messages.messages).toBeGreaterThan(0);
    expect(all.latency.mentions).toBeGreaterThan(5);
    expect(all.latency.unanswered).toBeGreaterThan(0);
    expect(all.decisions.byDay.map((day) => day.answers + day.stages + day.proposals)).not.toEqual(
      [],
    );
    expect(all.blocked.some((row) => row.holds)).toBe(true);
    expect(all.blocked.some((row) => row.title === null)).toBe(true);
  });

  it("answers the tokens as tokenUse does, for every window and moment, as events arrive", () => {
    let compared = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const events = withTokens(generate(seed, 240), seed);
      const index = new MetricsIndex();
      const next = random(seed * 6151);
      let added = 0;
      for (const upTo of [80, 160, 240]) {
        for (const event of events.slice(added, upTo)) {
          index.add(event);
        }
        added = upTo;
        const seen = events.slice(0, upTo);
        const last = Date.parse(seen.at(-1)?.ts ?? "");
        const earlier = Date.parse(seen[Math.floor(next() * upTo)]?.ts ?? "");
        // Just after the last event, hours on, and a day and a week after an earlier event, so a
        // window starts inside an hour and on an event.
        const moments = [
          last + 60_000,
          last + Math.floor(next() * 30 * 3_600_000),
          earlier + DAY,
          earlier + 7 * DAY,
        ];
        for (const at of moments) {
          const now = new Date(at);
          for (const window of WINDOWS) {
            expect(
              index.tokenUse(window, now),
              `seed ${seed} at ${upTo}, ${window}, ${now.toISOString()}`,
            ).toStrictEqual(tokenUse(seen, window, now));
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(120 * 3 * 4 * 3);
  });

  it("counts the tokens of logs whose ends take every shape, so the comparison is not of empty answers", () => {
    // Over the logs the equality test compares, every shape of end the history reads or refuses.
    const compared = Array.from({ length: 120 }, (_, at) =>
      withTokens(generate(at + 1, 240), at + 1),
    ).flat();
    const allEnds = compared.filter(
      (event) => event.type === "turn.completed" || event.type === "turn.failed",
    );
    const shapes = {
      failed: allEnds.filter((event) => event.type === "turn.failed").length,
      reflection: allEnds.filter((event) => event.payload["trigger"] === "reflection").length,
      unreadable: allEnds.filter((event) => event.payload["unreadable"] === true).length,
      badTurnId: allEnds.filter((event) => event.payload["turnId"] === "not-a-turn").length,
      badUsage: allEnds.filter((event) => usageOf(event)["inputTokens"] === -1).length,
      noCache: allEnds.filter(
        (event) => "inputTokens" in usageOf(event) && !("cacheReadTokens" in usageOf(event)),
      ).length,
    };
    // The shapes of which the logs hold five or fewer, by name.
    expect(Object.entries(shapes).filter(([, count]) => count <= 5)).toEqual([]);
    const events = withTokens(generate(7, 240), 7);
    const ends = events.filter(
      (event) => event.type === "turn.completed" || event.type === "turn.failed",
    );
    const index = new MetricsIndex();
    for (const event of events) {
      index.add(event);
    }
    const now = new Date(Date.parse(events.at(-1)?.ts ?? "") + 60_000);
    const all = index.tokenUse("all", now);
    expect(all.citizens.length).toBeGreaterThanOrEqual(5);
    expect(all.citizens.some((row) => row.withUsage > 0 && row.withUsage < row.turns)).toBe(true);
    const turns = (answer: typeof all): number =>
      answer.citizens.reduce((sum, row) => sum + row.turns, 0);
    // Ends the history cannot read are left out, and the day's window holds fewer than all.
    expect(turns(all)).toBeLessThan(ends.length);
    expect(turns(index.tokenUse("24h", now))).toBeGreaterThan(0);
    expect(turns(index.tokenUse("24h", now))).toBeLessThan(turns(all));
  });

  it("lists the signals as the log's read does, for every limit, as events arrive", () => {
    let compared = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const { events } = withSignals(generate(seed, 240), seed);
      const index = new MetricsIndex();
      let added = 0;
      for (const upTo of [80, 160, 240]) {
        // Fed as this process appends them; the log's read parses what was written.
        for (const event of events.slice(added, upTo)) {
          index.add(event);
        }
        added = upTo;
        const written = readBack(events.slice(0, upTo));
        const count = signalsIn(written, 0).length;
        for (const limit of limitsFor(count)) {
          expect(index.signals(limit), `seed ${seed} at ${upTo}, limit ${limit}`).toStrictEqual(
            signalsIn(written, limit),
          );
          compared += 1;
        }
      }
    }
    expect(compared).toBe(120 * 3 * limitsFor(0).length);
    // One log long enough that the turn host's read of 501 leaves its oldest signals out.
    const { events } = withSignals(generate(121, 24_000), 121);
    const index = new MetricsIndex();
    for (const event of events) {
      index.add(event);
    }
    const written = readBack(events);
    const count = signalsIn(written, 0).length;
    expect(count).toBeGreaterThan(600);
    for (const limit of limitsFor(count)) {
      expect(index.signals(limit), `the long log, limit ${limit}`).toStrictEqual(
        signalsIn(written, limit),
      );
    }
    expect(index.signals(501)).toHaveLength(501);
  });

  it("lists signals of every shape, so the comparison is not of empty answers", () => {
    // Over the logs the equality test compares, every shape of signal and every kind.
    const logs = [
      ...Array.from({ length: 120 }, (_, at) => withSignals(generate(at + 1, 240), at + 1)),
      withSignals(generate(121, 24_000), 121),
    ];
    const counts = new Map<SignalShape, number>(SIGNAL_SHAPES.map(([shape]) => [shape, 0]));
    const kinds = new Set<unknown>();
    let listed = 0;
    // The fields of each listed signal that was handed over with some undefined.
    const handedFields: string[] = [];
    for (const { events, shapes } of logs) {
      for (const shape of shapes.values()) {
        counts.set(shape, (counts.get(shape) ?? 0) + 1);
      }
      const index = new MetricsIndex();
      for (const event of events) {
        index.add(event);
      }
      for (const record of index.signals(0)) {
        listed += 1;
        kinds.add(record.signal.kind);
        if (shapes.get(record.id) === "undefined") {
          handedFields.push(Object.keys(record.signal).join(", "));
        }
      }
    }
    // The shapes of which the logs hold five or fewer, by name.
    expect([...counts].filter(([, count]) => count <= 5)).toEqual([]);
    expect(kinds).toEqual(new Set(OPS_SIGNAL_KINDS));
    // Only the readable shapes are listed: the bare, the full, and the undefined.
    const readable = ["bare", "full", "undefined"] as const;
    expect(listed).toBe(readable.reduce((sum, shape) => sum + (counts.get(shape) ?? 0), 0));
    // Fields handed over as undefined are left out, as the log's line leaves them out.
    expect(handedFields).toHaveLength(counts.get("undefined") ?? 0);
    expect(new Set(handedFields)).toEqual(new Set(["kind, key, summary, value"]));
  });

  it("keeps the ends each citizen's history lists as the log's read does, for every limit, as events arrive", async () => {
    let compared = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const { events } = withHistory(withTokens(generate(seed, 240), seed), seed);
      const index = new MetricsIndex();
      let added = 0;
      for (const upTo of [80, 160, 240]) {
        // Fed as this process appends them; the log's read parses what was written.
        for (const event of events.slice(added, upTo)) {
          index.add(event);
        }
        added = upTo;
        const written = readBack(events.slice(0, upTo));
        for (const agent of [...ACTORS, "nobody"]) {
          const count = turnHistoryIn(written, agent, 0).length;
          for (const limit of historyLimits(count)) {
            expect(
              await entriesFrom(index, written, agent, limit),
              `seed ${seed} at ${upTo}, ${agent}, limit ${limit}`,
            ).toStrictEqual(turnHistoryIn(written, agent, limit));
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(120 * 3 * (ACTORS.length + 1) * historyLimits(0).length);
    // One log long enough that one citizen's history holds more than the triage's 5,000.
    const long = generate(121, 40_000).events.map((event, n) =>
      event.type.startsWith("turn.") && n % 10 < 7 ? { ...event, actor: "eng-1" } : event,
    );
    const { events } = withHistory(withTokens({ events: long, transcripts: new Map() }, 121), 121);
    const index = new MetricsIndex();
    for (const event of events) {
      index.add(event);
    }
    const written = readBack(events);
    const count = turnHistoryIn(written, "eng-1", 0).length;
    expect(count).toBeGreaterThan(5_000);
    for (const limit of [0, 1, 50, 5_000, count + 1]) {
      expect(
        await entriesFrom(index, written, "eng-1", limit),
        `the long log, limit ${limit}`,
      ).toStrictEqual(turnHistoryIn(written, "eng-1", limit));
    }
    expect(index.turnEnds("eng-1", 5_000)).toHaveLength(5_000);
  });

  it("keeps histories of every shape, so the comparison is not of empty answers", () => {
    // Over the logs the equality test compares, every shape of start and end, and entries that
    // carry a start's time, a heartbeat, or neither.
    const logs = Array.from({ length: 120 }, (_, at) =>
      withHistory(withTokens(generate(at + 1, 240), at + 1), at + 1),
    );
    const counts = new Map<HistoryShape, number>(HISTORY_SHAPES.map((shape) => [shape, 0]));
    const entries = { startedAt: 0, heartbeat: 0, neither: 0 };
    for (const { events, shapes } of logs) {
      for (const kept of shapes.values()) {
        for (const shape of kept) {
          counts.set(shape, (counts.get(shape) ?? 0) + 1);
        }
      }
      const written = readBack(events);
      for (const agent of ACTORS) {
        for (const entry of turnHistoryIn(written, agent, 0)) {
          entries.startedAt += entry.startedAt === undefined ? 0 : 1;
          entries.heartbeat += entry.heartbeat === undefined ? 0 : 1;
          entries.neither += entry.startedAt === undefined && entry.heartbeat === undefined ? 1 : 0;
        }
      }
    }
    // The shapes of which the logs hold five or fewer, by name.
    expect([...counts].filter(([, count]) => count <= 5)).toEqual([]);
    expect(Object.entries(entries).filter(([, count]) => count <= 5)).toEqual([]);
  });

  it("keeps an end's id and its start, not the entry", () => {
    const index = new MetricsIndex();
    const begun: BoardEvent = {
      ...start(1, "eng-1"),
      payload: { turnId: "01M3T000000000000000000001", project: "lab", heartbeat: "held" },
    };
    index.add(begun);
    index.add(
      end({ turnId: "01M3T000000000000000000001", summary: "a long summary ".repeat(100) }),
    );
    expect(index.turnEnds("eng-1", 50)).toStrictEqual([
      { id: "01M3S000000000000000000001", start: { ts: begun.ts, heartbeat: "held" } },
    ]);
  });

  it("reads the transcript only of a counted end logged before ends carried their count", () => {
    expect(MetricsIndex.transcriptToRead(end({ turnId: "t1" }))).toBe("t1");
    expect(MetricsIndex.transcriptToRead(end({ turnId: "t1", boardActions: 0 }))).toBeNull();
    expect(MetricsIndex.transcriptToRead(end({ turnId: "t1", trigger: "reflection" }))).toBeNull();
    expect(MetricsIndex.transcriptToRead(end({}))).toBeNull();
    expect(
      MetricsIndex.transcriptToRead({ ...end({ turnId: "t1" }), type: "turn.failed" }),
    ).toBeNull();
  });
});

describe("Prometheus's wake latency", () => {
  it("counts the answers the Metrics view times over the window all, and those still unanswered", () => {
    // The tab's own latencies, as it counts each answered mention, since its answer gives none's total.
    const timed = vi.spyOn(MetricsTally.prototype, "answered");
    let answered = 0;
    let expired = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const log = generate(seed, 240);
      for (const citizens of ROSTERS) {
        const wakes = new WakeLatency(new Map(citizens.map((citizen) => [citizen.name, citizen])));
        for (const event of log.events) {
          wakes.add(event);
        }
        timed.mockClear();
        const tab = computeMetrics({
          events: log.events,
          tasks: ALL_TASKS,
          citizens,
          actions: actionsFor(log),
          activeSignals: new Set(),
          window: "all",
          now: new Date(Date.parse(log.events.at(-1)?.ts ?? "") + 60_000),
        });
        const expected = new Map<string, { count: number; sumMs: number }>();
        for (const [agent, ms] of timed.mock.calls) {
          const row = expected.get(agent) ?? { count: 0, sumMs: 0 };
          expected.set(agent, { count: row.count + 1, sumMs: row.sumMs + ms });
        }
        const latencies = wakes.latencies();
        expect(
          new Map(latencies.map(({ agent, count, sumMs }) => [agent, { count, sumMs }])),
          `seed ${seed}`,
        ).toEqual(expected);
        for (const { buckets, count } of latencies) {
          // Cumulative, as Prometheus reads a histogram's buckets, up to the count at +Inf.
          expect(buckets.toSorted((a, b) => a - b)).toEqual(buckets);
          expect(buckets.at(-1) ?? 0).toBeLessThanOrEqual(count);
        }
        const counted = latencies.reduce((sum, { count }) => sum + count, 0);
        expect(counted, `seed ${seed}`).toBe(tab.latency.mentions);
        const waits = wakes.unanswered();
        expect(
          waits.reduce((sum, { waiting, unanswered }) => sum + waiting + unanswered, 0),
          `seed ${seed}`,
        ).toBe(tab.latency.unanswered);
        answered += counted;
        expired += waits.reduce((sum, { unanswered }) => sum + unanswered, 0);
      }
    }
    timed.mockRestore();
    // Enough of both that the comparison is not of empty counts.
    expect(answered).toBeGreaterThan(1_000);
    expect(expired).toBeGreaterThan(100);
  });

  it("matches a mention with the citizens of when it was posted, so one added since counts", () => {
    const roster = new Map([["eng-1", { name: "eng-1", memberships: ["lab"] }]]);
    const wakes = new WakeLatency(roster);
    wakes.add(post(0, "ops-9"));
    wakes.add(start(3, "ops-9"));
    roster.set("ops-9", { name: "ops-9", memberships: ["lab"] });
    wakes.add(post(10, "ops-9"));
    wakes.add(post(11, "eng-1"));
    wakes.add(start(16, "ops-9"));
    expect(wakes.latencies().map(({ agent, count, sumMs }) => ({ agent, count, sumMs }))).toEqual([
      { agent: "ops-9", count: 1, sumMs: 6_000 },
    ]);
    expect(wakes.unanswered()).toEqual([
      { agent: "eng-1", waiting: 1, unanswered: 0 },
      { agent: "ops-9", waiting: 0, unanswered: 0 },
    ]);
  });
});
