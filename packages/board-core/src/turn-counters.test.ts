import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MEMBER_VERBS, type BoardEvent, type TokenUse, type TurnRecord } from "@stellaris/shared";
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
    });
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
});
