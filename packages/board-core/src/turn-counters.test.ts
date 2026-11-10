import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BoardEventSchema,
  MEMBER_VERBS,
  type BoardEvent,
  type Metrics,
  type TokenUse,
  type TranscriptEntry,
  type TurnRecord,
} from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Board } from "./board.js";
import { EventLog } from "./events.js";
import { TurnCounters, type TurnCounts } from "./turn-counters.js";
import { tokenUse } from "./turn-history.js";

const USER = { name: "user", role: "user" } as const;
const NOW = new Date("2026-10-13T12:00:00.000Z");

let sequence = 0;
function event(type: BoardEvent["type"], actor: string, payload: object): BoardEvent {
  sequence += 1;
  return {
    id: `01M4T${String(sequence).padStart(21, "0")}`,
    ts: "2026-10-13T09:00:00.000Z",
    type,
    actor,
    payload: { ...payload },
  };
}

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

/** Each citizen's turns and token sums as the counters hold them, in `tokenUse`'s shape. */
function perCitizen(counts: TurnCounts): Map<string, { turns: number; usage: number[] }> {
  const rows = new Map<string, { turns: number; usage: number[] }>();
  const row = (agent: string) => {
    const found = rows.get(agent) ?? { turns: 0, usage: [0, 0, 0, 0] };
    rows.set(agent, found);
    return found;
  };
  for (const series of counts.turns) {
    row(series.agent).turns += series.turns;
  }
  const at = { input: 0, output: 1, cache_read: 2, cache_write: 3 } as const;
  for (const series of counts.tokens) {
    const sums = row(series.agent).usage;
    sums[at[series.kind]] = (sums[at[series.kind]] ?? 0) + series.tokens;
  }
  return rows;
}

/** One citizen's token series on a CLI and model, in the order the counters read them. */
function seriesOf(agent: string, cli: string, model: string, values: number[]) {
  return (["cache_read", "cache_write", "input", "output"] as const).map((kind, at) => ({
    agent,
    cli,
    model,
    kind,
    tokens: values[at],
  }));
}

/** A tool's result as a turn's transcript keeps it. */
function result(name: string, ok = true): TranscriptEntry {
  return { ts: "2026-10-13T09:00:30.000Z", event: { type: "tool_result", name, ok } };
}

/** A turn's end as `finishTurn` logs it, in `lab`, woken by `trigger`. */
function completedEnd(actor: string, trigger: string, more: object): BoardEvent {
  return event("turn.completed", actor, { project: "lab", trigger, ...more });
}

/** A failed turn's end as `finishTurn` logs it. */
function failedEnd(actor: string, more: object): BoardEvent {
  return event("turn.failed", actor, {
    project: "lab",
    trigger: "stage",
    exitReason: "error",
    ...more,
  });
}

/** A send-back of a task from stage `from`, as `update_task` logs it. */
function movedBack(actor: string, project: string, taskId: string, from: string): BoardEvent {
  return event("task.moved", actor, { taskId, project, from, to: "s1" });
}

/** Sends a two-stage task in `project` back from its second stage, as `by`. */
async function sendBack(board: Board, project: string, by: "user" | "eng-1"): Promise<void> {
  const task = await board.createTask(USER, {
    project,
    title: "report",
    stages: [{ name: "draft" }, { name: "check" }],
  });
  await board.advanceTask(USER, { task_id: task.id });
  const actor = by === "user" ? USER : { name: "eng-1", role: "engineer" };
  if (by !== "user") {
    await board.claimTask(actor, { task_id: task.id });
  }
  await board.updateTask(actor, { task_id: task.id, stage: "s1", note: "again" });
}

/**
 * The board as one from before ends carried their board actions would have left it: every end
 * logged so far without them, opened afresh, since a board indexes its log as it reads it.
 */
async function withOlderEnds(board: Board, now: () => Date): Promise<Board> {
  const file = board.paths.eventLog();
  const lines = (await readFile(file, "utf8")).split("\n").map((line) => {
    if (line === "") {
      return line;
    }
    const logged = BoardEventSchema.parse(JSON.parse(line));
    const { boardActions: _counted, ...payload } = logged.payload;
    return JSON.stringify({ ...logged, payload });
  });
  await writeFile(file, lines.join("\n"));
  return Board.open(board.paths.dataDir, { now });
}

/** Each series' count by the labels `key` picks, summed over the rest. */
function summed<T>(series: readonly T[], key: (each: T) => string, count: (each: T) => number) {
  const sums = new Map<string, number>();
  for (const each of series) {
    sums.set(key(each), (sums.get(key(each)) ?? 0) + count(each));
  }
  return sums;
}

/**
 * The idle turns and send-backs the metrics count over the window `all`, keyed as `fromCounters`:
 * every send-back, by stage and by sender, which the headline's count of the finished tasks' own
 * leaves out for a task still open.
 */
function fromMetrics(metrics: Metrics) {
  const idleByTrigger = new Map<string, number>();
  for (const row of metrics.idle.byTrigger) {
    idleByTrigger.set(row.trigger, (idleByTrigger.get(row.trigger) ?? 0) + row.idle);
  }
  const sendBacksByProject = new Map<string, number>();
  for (const row of metrics.sentBack.byStage) {
    sendBacksByProject.set(row.project, (sendBacksByProject.get(row.project) ?? 0) + row.count);
  }
  return {
    idle: metrics.idle.idle,
    idleByAgent: new Map(
      metrics.idle.byAgent.filter((row) => row.idle > 0).map((row) => [row.agent, row.idle]),
    ),
    idleByTrigger: new Map([...idleByTrigger].filter(([, idle]) => idle > 0)),
    sendBacksByProject,
    sendBacksBy: new Map(metrics.sentBack.bySender.map((row) => [row.agent, row.count])),
  };
}

/** The same measures from the counters. */
function fromCounters(counts: TurnCounts) {
  const idleByAgent = summed(
    counts.idle,
    (each) => each.agent,
    (each) => each.turns,
  );
  const sendBacksBy = summed(
    counts.sendBacks,
    (each) => each.by,
    (each) => each.sendBacks,
  );
  return {
    idle: [...idleByAgent.values()].reduce((sum, each) => sum + each, 0),
    idleByAgent,
    idleByTrigger: summed(
      counts.idle,
      (each) => each.trigger,
      (each) => each.turns,
    ),
    sendBacksByProject: summed(
      counts.sendBacks,
      (each) => each.project,
      (each) => each.sendBacks,
    ),
    sendBacksBy,
  };
}

/** A citizen's input tokens as the counters hold them. */
function inputOf(counts: TurnCounts, agent: string) {
  return counts.tokens.find((series) => series.agent === agent && series.kind === "input");
}

/** `tokenUse`'s citizens in the same shape, a turn without a count adding nothing. */
function fromTokenUse(use: TokenUse): Map<string, { turns: number; usage: number[] }> {
  return new Map(
    use.citizens.map((citizen) => [
      citizen.agent,
      {
        turns: citizen.turns,
        usage:
          citizen.usage === null
            ? [0, 0, 0, 0]
            : [
                citizen.usage.inputTokens,
                citizen.usage.outputTokens,
                citizen.usage.cacheReadTokens,
                citizen.usage.cacheWriteTokens,
              ],
      },
    ]),
  );
}

describe("TurnCounters", () => {
  it("counts every turn tokenUse counts over all time, and the tokens of those that counted them", () => {
    const events = [
      event("turn.completed", "ada", { project: "lab", trigger: "mention" }),
      event("turn.completed", "ada", {
        project: "lab",
        trigger: "mention",
        usage: usage(10, 1, 100, 5),
        model: "claude-opus-5-5",
      }),
      event("turn.failed", "ada", { project: "lab", trigger: "stage", usage: usage(30, 3) }),
      event("turn.completed", "bo", {
        project: "lab",
        trigger: "heartbeat",
        usage: usage(1_000, 50),
        model: "gpt-6",
        cli: "codex",
      }),
      // An older usage without the cache counts, which read as none.
      event("turn.completed", "cy", { project: "lab", usage: { inputTokens: 7, outputTokens: 1 } }),
      event("turn.failed", "cy", { project: "lab", trigger: "cron" }),
      // Neither a turn's start, a malformed end, nor another event is a finished turn.
      event("turn.started", "ada", { project: "lab", trigger: "mention", turnId: "x" }),
      event("turn.completed", "ada", { trigger: "mention", usage: usage(5, 5) }),
      event("message.posted", "ada", { project: "lab" }),
    ];
    const counters = new TurnCounters((agent) => (agent === "bo" ? "codex" : "claude"));
    for (const each of events) {
      counters.add(each);
    }
    const counted = perCitizen(counters.read());
    const expected = fromTokenUse(tokenUse(events, "all", NOW));
    expect(counted).toEqual(expected);
    // The comparison covers every citizen with a turn, and the sums are what the turns reported.
    expect([...counted.keys()].toSorted()).toEqual(["ada", "bo", "cy"]);
    expect(counted.get("ada")).toEqual({ turns: 3, usage: [40, 4, 100, 5] });
  });

  it("labels a turn's tokens with the CLI its end names, else its citizen's, else unknown", () => {
    const counters = new TurnCounters((agent) =>
      agent === "ada" ? "claude" : agent === "bo" ? "codex" : null,
    );
    // Logged before ends named their CLI: the citizen's record names it.
    counters.add(
      event("turn.completed", "ada", {
        project: "lab",
        trigger: "mention",
        usage: usage(1, 2, 3, 4),
        model: "claude-opus-5-5",
      }),
    );
    // Named on the end, which the record does not override.
    counters.add(
      event("turn.completed", "ada", {
        project: "lab",
        trigger: "mention",
        usage: usage(10, 20, 30, 40),
        model: "claude-opus-5-5",
        cli: "claude",
      }),
    );
    // No model recorded, and a citizen no record names.
    counters.add(
      event("turn.failed", "ghost", {
        project: "lab",
        trigger: "stage",
        usage: usage(5, 0),
        model: null,
      }),
    );
    // A turn with no count is a turn, and adds no tokens.
    counters.add(
      event("turn.failed", "bo", { project: "lab", trigger: "heartbeat", cli: "codex" }),
    );
    expect(counters.read()).toEqual({
      tokens: [
        ...seriesOf("ada", "claude", "claude-opus-5-5", [33, 44, 11, 22]),
        ...seriesOf("ghost", "unknown", "unknown", [0, 0, 5, 0]),
      ],
      turns: [
        { agent: "ada", outcome: "completed", trigger: "mention", turns: 2 },
        { agent: "bo", outcome: "failed", trigger: "heartbeat", turns: 1 },
        { agent: "ghost", outcome: "failed", trigger: "stage", turns: 1 },
      ],
      idle: [],
      failed: [
        { agent: "bo", cli: "codex", reason: "other", turns: 1 },
        { agent: "ghost", cli: "unknown", reason: "other", turns: 1 },
      ],
      sendBacks: [],
      wakeLatency: [],
      mentions: [],
    });
  });

  it("counts a completed turn idle when it took no board action, by its end's count or else its transcript's", () => {
    const transcripts = new Map<string, number | null>([
      ["01M4T000000000000000000AA0", 0],
      ["01M4T000000000000000000AA1", 2],
      ["01M4T000000000000000000AB0", null],
    ]);
    const counters = new TurnCounters(
      () => "claude",
      (turnId) => transcripts.get(turnId),
    );
    for (const each of [
      // Counted on its end: nothing, twice, and something.
      completedEnd("ada", "mention", { turnId: "01M4T000000000000000000BA0", boardActions: 0 }),
      completedEnd("ada", "heartbeat", { turnId: "01M4T000000000000000000BA1", boardActions: 0 }),
      completedEnd("ada", "mention", { turnId: "01M4T000000000000000000BA2", boardActions: 3 }),
      // Logged before ends carried it: the transcript's count, which the end's would override.
      completedEnd("bo", "stage", { turnId: "01M4T000000000000000000AA0" }),
      completedEnd("bo", "stage", { turnId: "01M4T000000000000000000AA1" }),
      completedEnd("bo", "stage", { turnId: "01M4T000000000000000000AA1", boardActions: 0 }),
      // No transcript, no id, or one the seed never read: unknown, so never idle.
      completedEnd("bo", "stage", { turnId: "01M4T000000000000000000AB0" }),
      completedEnd("bo", "stage", {}),
      completedEnd("bo", "stage", { turnId: "01M4T000000000000000000AC0" }),
      // A reflection writes memory, not the board, and a failed turn is no idle one.
      completedEnd("cy", "reflection", { turnId: "01M4T000000000000000000BA3", boardActions: 0 }),
      event("turn.failed", "cy", { project: "lab", trigger: "mention", boardActions: 0 }),
    ]) {
      counters.add(each);
    }
    expect(counters.read().idle).toEqual([
      { agent: "ada", trigger: "heartbeat", turns: 1 },
      { agent: "ada", trigger: "mention", turns: 1 },
      { agent: "bo", trigger: "stage", turns: 2 },
    ]);
  });

  it("counts each failed turn under its CLI and the reason its end gives", () => {
    const counters = new TurnCounters((agent) => (agent === "bo" ? "codex" : "claude"));
    for (const each of [
      failedEnd("ada", { error: "Prompt is too long" }),
      failedEnd("ada", { error: "Prompt is too long", cli: "claude" }),
      failedEnd("ada", { exitReason: "timeout", error: "Prompt is too long" }),
      failedEnd("ada", {
        error: "usage limit reached: You've hit your weekly limit · resets Nov 12",
      }),
      failedEnd("bo", { error: "Selected model is at capacity. Please try a different model." }),
      failedEnd("bo", { error: null, resumeFailed: "lost", cli: "codex" }),
      // A mark a later board adds reads as none.
      failedEnd("bo", { error: "something new", transient: "maybe", resumeFailed: "later" }),
      // A completed turn has no reason.
      event("turn.completed", "ada", {
        project: "lab",
        trigger: "stage",
        error: "Prompt is too long",
      }),
    ]) {
      counters.add(each);
    }
    expect(counters.read().failed).toEqual([
      { agent: "ada", cli: "claude", reason: "context", turns: 2 },
      { agent: "ada", cli: "claude", reason: "limit", turns: 1 },
      { agent: "ada", cli: "claude", reason: "timeout", turns: 1 },
      { agent: "bo", cli: "codex", reason: "other", turns: 1 },
      { agent: "bo", cli: "codex", reason: "resume_failed", turns: 1 },
      { agent: "bo", cli: "codex", reason: "service", turns: 1 },
    ]);
  });

  it("counts each send-back by its project and whoever sent it back, never by task or stage", () => {
    const counters = new TurnCounters(() => "claude");
    for (const each of [
      movedBack("user", "lab", "01M4T000000000000000000TA0", "s3"),
      movedBack("user", "lab", "01M4T000000000000000000TA1", "s2"),
      movedBack("rev", "lab", "01M4T000000000000000000TA0", "s2"),
      movedBack("rev", "site", "01M4T000000000000000000TA2", "s2"),
      // One the metrics would not read is not counted either, nor another step of a task.
      event("task.moved", "rev", { project: "lab" }),
      event("task.advanced", "rev", { taskId: "01M4T000000000000000000TA2", project: "site" }),
    ]) {
      counters.add(each);
    }
    expect(counters.read().sendBacks).toEqual([
      { project: "lab", by: "rev", sendBacks: 1 },
      { project: "lab", by: "user", sendBacks: 2 },
      { project: "site", by: "rev", sendBacks: 1 },
    ]);
  });
});

describe("Board.countTurns", () => {
  let dir: string;
  let clock: Date;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-counters-"));
    clock = new Date("2026-10-13T09:00:00.000Z");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function society(): Promise<Board> {
    const { board } = await Board.init(dir, { name: "counted" }, { now: () => clock });
    await board.addProject(USER, { slug: "demo", channels: ["general"] });
    await board.setRoleCharter(USER, {
      name: "engineer",
      purpose: "The engineer of the test society.",
      verbs: [...MEMBER_VERBS],
      wakeTriggers: ["heartbeat"],
    });
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    await board.addAgent(USER, {
      name: "eng-2",
      role: "engineer",
      cli: "codex",
      memberships: ["demo"],
    });
    return board;
  }

  /** Records one turn of `agent` from its start to its end. */
  async function turn(
    board: Board,
    agent: "eng-1" | "eng-2",
    end: Partial<TurnRecord> = {},
  ): Promise<void> {
    clock = new Date(clock.getTime() + 60_000);
    const started = await board.beginTurn({
      agent,
      project: "demo",
      runner: "server",
      cli: agent === "eng-1" ? "claude" : "codex",
      session: null,
      trigger: { kind: "mention", fromUser: false, reason: "" },
      startedAt: clock.toISOString(),
      endedAt: null,
      exitReason: null,
      status: null,
      error: null,
      usage: null,
      costUsd: 0,
      toolCalls: 0,
      model: agent === "eng-1" ? "claude-opus-5-5" : "gpt-6",
    });
    await board.finishTurn({
      ...started,
      endedAt: clock.toISOString(),
      exitReason: "completed",
      ...end,
    });
  }

  it("seeds from the event log as tokenUse counts it, then moves with each turn's end", async () => {
    const board = await society();
    await turn(board, "eng-1", { usage: usage(12, 340, 56_000, 780) });
    await turn(board, "eng-1");
    await turn(board, "eng-2", { usage: usage(900, 80, 7_000, 0), exitReason: "error" });
    await turn(board, "eng-2", { usage: usage(1, 1, 1, 1), exitReason: "timeout" });

    const counters = await board.countTurns();
    expect(perCitizen(counters.read())).toEqual(fromTokenUse(await board.tokenUse("all")));
    expect(perCitizen(counters.read()).get("eng-2")).toEqual({
      turns: 2,
      usage: [901, 81, 7_001, 1],
    });

    const before = counters.read();
    await turn(board, "eng-2", { usage: usage(5, 6, 7, 8) });
    const after = counters.read();
    expect(perCitizen(after)).toEqual(fromTokenUse(await board.tokenUse("all")));
    expect(after.turns.find((s) => s.agent === "eng-2" && s.outcome === "completed")).toEqual({
      agent: "eng-2",
      outcome: "completed",
      trigger: "mention",
      turns: 1,
    });
    expect(inputOf(before, "eng-2")).toEqual({
      agent: "eng-2",
      cli: "codex",
      model: "gpt-6",
      kind: "input",
      tokens: 901,
    });
    expect(inputOf(after, "eng-2")?.tokens).toBe(906);
  });

  it("logs the turn's CLI on its end", async () => {
    const board = await society();
    await turn(board, "eng-2", { usage: usage(1, 1) });
    const logged: BoardEvent[] = [];
    board.onEventAppended((appended) => logged.push(appended));
    await turn(board, "eng-1", { usage: usage(1, 1), exitReason: "error" });
    const ends = logged.filter((appended) => appended.type === "turn.failed");
    expect(ends.map((end) => [end.actor, end.payload["cli"]])).toEqual([["eng-1", "claude"]]);
  });

  it("reads the event log to seed and never again to answer", async () => {
    const board = await society();
    await turn(board, "eng-1", { usage: usage(1, 2) });
    const reads = vi.spyOn(EventLog.prototype, "readSince");
    const lastIds = vi.spyOn(EventLog.prototype, "lastId");
    const counters = await board.countTurns();
    // The spy sees the seed's read, so a read it misses is none.
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockClear();
    lastIds.mockClear();
    const first = counters.read();
    await turn(board, "eng-1", { usage: usage(3, 4) });
    const answered = reads.mock.calls.length + lastIds.mock.calls.length;
    for (let scrape = 0; scrape < 3; scrape += 1) {
      counters.read();
    }
    expect(reads.mock.calls.length + lastIds.mock.calls.length).toBe(answered);
    expect(perCitizen(counters.read()).get("eng-1")).toEqual({ turns: 2, usage: [4, 6, 0, 0] });
    expect(perCitizen(first).get("eng-1")).toEqual({ turns: 1, usage: [1, 2, 0, 0] });
  });

  it("counts a turn's end once when it is logged while the seed reads the log", async () => {
    const board = await society();
    await turn(board, "eng-1", { usage: usage(1, 0) });
    // Each mock runs once, so its own call to readSince reads the log as it is.
    // Ended before the seed's read, after the counters listen: both see it.
    vi.spyOn(EventLog.prototype, "readSince").mockImplementationOnce(async function (
      this: EventLog,
      since,
      limit,
    ) {
      await turn(board, "eng-1", { usage: usage(10, 0) });
      return this.readSince(since, limit);
    });
    const during = await board.countTurns();
    expect(perCitizen(during.read()).get("eng-1")).toEqual({ turns: 2, usage: [11, 0, 0, 0] });

    // Ended once the seed's read had finished, before it returned: only the listener sees it.
    vi.spyOn(EventLog.prototype, "readSince").mockImplementationOnce(async function (
      this: EventLog,
      since,
      limit,
    ) {
      const stale = await this.readSince(since, limit);
      await turn(board, "eng-1", { usage: usage(100, 0) });
      return stale;
    });
    const after = await board.countTurns();
    expect(perCitizen(after.read()).get("eng-1")).toEqual({ turns: 3, usage: [111, 0, 0, 0] });
    expect(perCitizen(after.read())).toEqual(fromTokenUse(await board.tokenUse("all")));
  });

  /** Records one turn of `agent`, woken by `trigger`, ending with `transcript`. */
  async function ended(
    board: Board,
    agent: "eng-1" | "eng-2",
    trigger: "mention" | "stage" | "heartbeat" | "cron" | "reflection",
    transcript: readonly TranscriptEntry[],
    end: Partial<TurnRecord> = {},
  ): Promise<void> {
    clock = new Date(clock.getTime() + 60_000);
    const started = await board.beginTurn({
      agent,
      project: "demo",
      runner: "server",
      cli: agent === "eng-1" ? "claude" : "codex",
      session: null,
      trigger: {
        kind: trigger,
        fromUser: false,
        reason: "",
        ...(trigger === "heartbeat" ? { heartbeat: "held" as const } : {}),
      },
      startedAt: clock.toISOString(),
      endedAt: null,
      exitReason: null,
      status: null,
      error: null,
      usage: null,
      costUsd: 0,
      toolCalls: 0,
      model: null,
    });
    await board.finishTurn(
      { ...started, endedAt: clock.toISOString(), exitReason: "completed", ...end },
      transcript,
    );
  }

  it("logs the board actions a turn's transcript holds on its end, and none for a turn that kept none", async () => {
    const board = await society();
    const logged: BoardEvent[] = [];
    board.onEventAppended((appended) => logged.push(appended));
    await ended(board, "eng-1", "mention", [
      result("mcp__board__post_message"),
      result("mcp__board__get_task"),
      result("mcp__board__claim_task", false),
      result("Bash"),
      result("mcp__board__advance_task"),
    ]);
    await ended(board, "eng-1", "mention", [result("mcp__board__read_inbox")], {
      exitReason: "error",
    });
    await ended(board, "eng-2", "stage", []);
    const ends = logged.filter(
      (each) => each.type.startsWith("turn.") && each.type !== "turn.started",
    );
    expect(ends.map((each) => [each.type, each.payload["boardActions"]])).toEqual([
      ["turn.completed", 2],
      ["turn.failed", 0],
      ["turn.completed", undefined],
    ]);
    expect((await board.listTurns("eng-1")).map((each) => each.boardActions)).toEqual([2, 0]);
  });

  it("reads each transcript an older end needs once to seed the idle count, and none a newer end counted", async () => {
    const older = await society();
    await ended(older, "eng-1", "stage", [result("Bash")]);
    await ended(older, "eng-1", "stage", [result("mcp__board__post_message")]);
    await ended(older, "eng-1", "reflection", [result("Write")]);
    await ended(older, "eng-2", "mention", [result("Read")], { exitReason: "error" });
    const board = await withOlderEnds(older, () => clock);
    await ended(board, "eng-2", "mention", [result("mcp__board__search")]);
    await ended(board, "eng-2", "mention", [result("mcp__board__post_message")]);
    const reads = vi.spyOn(Board.prototype, "readTranscript");
    const counters = await board.countTurns();
    // The two older completed turns that are not a reflection, each once.
    expect(reads).toHaveBeenCalledTimes(2);
    expect(counters.read().idle).toEqual([
      { agent: "eng-1", trigger: "stage", turns: 1 },
      { agent: "eng-2", trigger: "mention", turns: 1 },
    ]);
    reads.mockClear();
    // A turn ended once the counters listen counts from its end alone.
    await ended(board, "eng-1", "cron", [result("mcp__board__get_task")]);
    await ended(board, "eng-1", "cron", []);
    expect(reads).not.toHaveBeenCalled();
    expect(counters.read().idle).toContainEqual({ agent: "eng-1", trigger: "cron", turns: 1 });
  });

  it("counts failed turns by reason and send-backs as they are logged, and seeds them from the log", async () => {
    const board = await society();
    await ended(board, "eng-1", "stage", [], {
      exitReason: "error",
      error: "Prompt is too long",
    });
    await sendBack(board, "demo", "user");
    const counters = await board.countTurns();
    await ended(board, "eng-2", "stage", [], {
      exitReason: "error",
      error: "Selected model is at capacity. Please try a different model.",
      transient: true,
    });
    await ended(board, "eng-1", "stage", [], { exitReason: "timeout", error: null });
    await sendBack(board, "demo", "eng-1");
    await sendBack(board, "demo", "user");
    const counts = counters.read();
    expect(counts.failed).toEqual([
      { agent: "eng-1", cli: "claude", reason: "context", turns: 1 },
      { agent: "eng-1", cli: "claude", reason: "timeout", turns: 1 },
      { agent: "eng-2", cli: "codex", reason: "service", turns: 1 },
    ]);
    expect(counts.sendBacks).toEqual([
      { project: "demo", by: "eng-1", sendBacks: 1 },
      { project: "demo", by: "user", sendBacks: 2 },
    ]);
    // A seed from the same log comes to the same counts.
    const seeded = (await board.countTurns()).read();
    expect(seeded.failed).toEqual(counts.failed);
    expect(seeded.sendBacks).toEqual(counts.sendBacks);
  });

  it("counts idle turns and send-backs as the metrics do over the window all", async () => {
    const older = await society();
    await older.addProject(USER, { slug: "site", channels: ["general"] });
    await ended(older, "eng-1", "stage", [result("Bash"), result("mcp__board__get_task")]);
    await ended(older, "eng-2", "mention", [result("mcp__board__post_message")]);
    await ended(older, "eng-2", "mention", []);
    await sendBack(older, "demo", "user");
    const board = await withOlderEnds(older, () => clock);
    await ended(board, "eng-1", "heartbeat", [result("mcp__board__read_inbox")]);
    await ended(board, "eng-1", "mention", [result("mcp__board__advance_task")]);
    await ended(board, "eng-1", "stage", [result("mcp__board__claim_task", false)]);
    await ended(board, "eng-2", "reflection", [result("Edit")]);
    await ended(board, "eng-2", "cron", [result("Read")]);
    await ended(board, "eng-2", "cron", []);
    await ended(board, "eng-1", "mention", [], {
      exitReason: "error",
      error: "Prompt is too long",
    });
    await sendBack(board, "demo", "eng-1");
    await sendBack(board, "site", "user");
    const counters = await board.countTurns();
    // Some of each are ended once the counters listen.
    await ended(board, "eng-2", "heartbeat", [result("mcp__board__search")]);
    await ended(board, "eng-1", "cron", [result("mcp__board__post_message")]);
    await sendBack(board, "site", "user");

    const tab = fromMetrics(await board.metrics("all"));
    expect(fromCounters(counters.read())).toEqual(tab);
    // The comparison covers idle turns of each citizen and each kind of end, and both projects.
    expect(tab).toEqual({
      idle: 5,
      idleByAgent: new Map([
        ["eng-1", 3],
        ["eng-2", 2],
      ]),
      idleByTrigger: new Map([
        ["cron", 1],
        ["heartbeat", 2],
        ["stage", 2],
      ]),
      sendBacksByProject: new Map([
        ["demo", 2],
        ["site", 2],
      ]),
      sendBacksBy: new Map([
        ["eng-1", 1],
        ["user", 3],
      ]),
    });
  });
});
