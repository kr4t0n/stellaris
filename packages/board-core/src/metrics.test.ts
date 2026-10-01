import { TaskFrontmatterSchema, type BoardEvent, type Task } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { computeMetrics, type MetricsInput } from "./metrics.js";

const A = "01M3S0000000000000000000AA";
const B = "01M3S0000000000000000000BB";
const C = "01M3S0000000000000000000CC";
const NOW = new Date("2026-10-01T12:00:00.000Z");

let sequence = 0;
function event(ts: string, type: BoardEvent["type"], actor: string, payload: object): BoardEvent {
  sequence += 1;
  return {
    id: `01M3S${String(sequence).padStart(21, "0")}`,
    ts: `2026-${ts}.000Z`,
    type,
    actor,
    payload: { ...payload },
  };
}

function turn(ts: string, agent: string, trigger: string, turnId: string): BoardEvent {
  return event(ts, "turn.completed", agent, { turnId, project: "lab", thread: A, trigger });
}

function mention(ts: string, name: string, channel: string, thread?: string): BoardEvent {
  return event(ts, "message.posted", "user", {
    channel,
    ...(thread === undefined ? {} : { thread }),
    mentions: [name],
  });
}

function start(
  ts: string,
  agent: string,
  project: string,
  thread?: string,
  trigger = "mention",
): BoardEvent {
  return event(ts, "turn.started", agent, {
    project,
    trigger,
    ...(thread === undefined ? {} : { thread }),
  });
}

function task(id: string, title: string): Task {
  return {
    ...TaskFrontmatterSchema.parse({
      id,
      project: "lab",
      title,
      status: "done",
      createdBy: "desk",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      blockedBy: [],
      requiredCapabilities: [],
      stages: [
        { id: "s1", name: "build", role: "engineer" },
        { id: "s2", name: "review", role: "reviewer", gate: true },
      ],
      stage: "s2",
      stageSince: NOW.toISOString(),
      stageSeq: 2,
    }),
    body: "",
  };
}

function input(events: BoardEvent[], extra: Partial<MetricsInput> = {}): MetricsInput {
  return {
    events,
    tasks: [task(A, "Add hello.txt"), task(B, "Fix the seed"), task(C, "Run on the GPU")],
    citizens: [
      { name: "desk", role: "concierge", memberships: [], societyScope: true },
      { name: "eng-1", role: "engineer", memberships: ["lab"], societyScope: false },
      { name: "rev-1", role: "reviewer", memberships: ["lab"], societyScope: false },
    ],
    actions: new Map(),
    activeSignals: new Set(),
    window: "24h",
    now: NOW,
    ...extra,
  };
}

describe("metrics", () => {
  it("counts turns that changed nothing, leaving reflections out and turns without transcripts apart", () => {
    const metrics = computeMetrics(
      input(
        [
          turn("09-29T10:00:00", "rev-1", "heartbeat", "T0"),
          turn("10-01T08:00:00", "eng-1", "stage", "T1"),
          turn("10-01T09:00:00", "rev-1", "heartbeat", "T2"),
          turn("10-01T09:30:00", "rev-1", "heartbeat", "T3"),
          turn("10-01T10:00:00", "desk", "user_post", "T4"),
          turn("10-01T11:00:00", "eng-1", "reflection", "T5"),
        ],
        {
          actions: new Map([
            ["T0", 0],
            ["T1", 2],
            ["T2", 0],
            ["T3", 1],
            ["T4", null],
            ["T5", 0],
          ]),
        },
      ),
    );
    expect(metrics.idle).toEqual({
      turns: 3,
      idle: 1,
      unknown: 1,
      byTrigger: [
        { trigger: "heartbeat", turns: 2, idle: 1 },
        { trigger: "stage", turns: 1, idle: 0 },
      ],
      byAgent: [
        { agent: "rev-1", role: "reviewer", turns: 2, idle: 1 },
        { agent: "eng-1", role: "engineer", turns: 1, idle: 0 },
      ],
    });
  });

  it("counts the send-backs and thread posts of the tasks finished in the window, from the whole log", () => {
    const post = (ts: string, actor: string, thread: string): BoardEvent =>
      event(ts, "message.posted", actor, { channel: "lab/general", thread, mentions: [] });
    const moved = (ts: string, actor: string, id: string): BoardEvent =>
      event(ts, "task.moved", actor, { taskId: id, project: "lab", from: "s2", to: "s1" });
    const metrics = computeMetrics(
      input([
        moved("09-28T10:00:00", "rev-1", A),
        post("09-28T10:00:00", "eng-1", A),
        moved("10-01T09:00:00", "rev-1", A),
        post("10-01T09:10:00", "eng-1", A),
        post("10-01T09:20:00", "board", A),
        post("10-01T09:30:00", "rev-1", B),
        moved("10-01T10:00:00", "user", C),
        event("10-01T10:00:00", "task.completed", "rev-1", { taskId: A, project: "lab" }),
        event("10-01T11:00:00", "task.completed", "rev-1", { taskId: B, project: "lab" }),
      ]),
    );
    expect(metrics.sentBack).toEqual({
      finished: 2,
      sendBacks: 2,
      tasksSentBack: 1,
      byStage: [{ project: "lab", stage: "review", count: 2 }],
      bySender: [
        { agent: "rev-1", count: 1 },
        { agent: "user", count: 1 },
      ],
    });
    expect(metrics.messages).toEqual({
      finished: 2,
      messages: 3,
      byProject: [{ project: "lab", finished: 2, messages: 3 }],
      busiest: [
        { taskId: A, title: "Add hello.txt", project: "lab", messages: 2 },
        { taskId: B, title: "Fix the seed", project: "lab", messages: 1 },
      ],
    });
  });

  it("times a mention to the turn it woke, in the same conversation and scope", () => {
    const metrics = computeMetrics(
      input([
        mention("10-01T10:00:00", "eng-1", "lab/general"),
        // A home turn elsewhere, and a turn in a thread, do not answer a channel mention in lab.
        start("10-01T10:00:10", "eng-1", "other"),
        start("10-01T10:00:20", "eng-1", "lab", A),
        start("10-01T10:00:30", "eng-1", "lab"),
        mention("10-01T11:00:00", "rev-1", "lab/general", A),
        mention("10-01T11:01:00", "rev-1", "lab/general", A),
        start("10-01T11:02:00", "rev-1", "lab", A),
        mention("10-01T11:30:00", "desk", "general"),
        // Before threads had conversations, a mention in one woke the scope's home: a home turn
        // woken by a mention answers it, and one woken by a heartbeat does not.
        mention("10-01T11:40:00", "eng-1", "lab/general", B),
        start("10-01T11:40:05", "eng-1", "lab", undefined, "heartbeat"),
        start("10-01T11:40:45", "eng-1", "lab", undefined, "mention"),
      ]),
    );
    expect(metrics.latency).toEqual({
      mentions: 4,
      unanswered: 1,
      medianMs: 52_500,
      slowestMs: 120_000,
      byAgent: [
        { agent: "rev-1", mentions: 2, medianMs: 90_000, slowestMs: 120_000 },
        { agent: "eng-1", mentions: 2, medianMs: 37_500, slowestMs: 45_000 },
      ],
    });
  });

  it("answers a mention in a project its citizen has since left, as an archive leaves it", () => {
    const metrics = computeMetrics(
      input([
        mention("10-01T10:00:00", "rev-1", "old/general", A),
        start("10-01T10:00:20", "rev-1", "old"),
      ]),
    );
    expect(metrics.latency).toMatchObject({ mentions: 1, unanswered: 0, medianMs: 20_000 });
  });

  it("counts the user's decisions by day: proposals, answers to questions, and stages", () => {
    const metrics = computeMetrics(
      input(
        [
          event("09-30T09:00:00", "proposal.decided", "user", { proposalId: A }),
          event("10-01T08:00:00", "proposal.decided", "stew", { proposalId: B }),
          event("10-01T09:00:00", "message.posted", "rev-1", {
            channel: "lab/general",
            thread: B,
            mentions: ["user"],
          }),
          event("10-01T09:30:00", "message.posted", "user", {
            channel: "lab/general",
            thread: B,
            mentions: [],
          }),
          // A second post in the same place answers nothing more.
          event("10-01T09:40:00", "message.posted", "user", {
            channel: "lab/general",
            thread: B,
            mentions: [],
          }),
          event("10-01T10:00:00", "task.advanced", "user", { taskId: A, project: "lab" }),
        ],
        { window: "7d" },
      ),
    );
    expect(metrics.decisions).toEqual({
      total: 3,
      byDay: [
        { day: "2026-10-01", proposals: 0, answers: 1, stages: 1 },
        { day: "2026-09-30", proposals: 1, answers: 0, stages: 0 },
      ],
    });
  });

  it("lists tasks blocked on a capability with whether the condition holds now", () => {
    const signal = (ts: string): BoardEvent =>
      event(ts, "ops.signal", "board", {
        kind: "blocked_capability",
        key: `blocked_capability:${C}`,
        summary: "needs gpu and no connected runner offers it",
        taskId: C,
        project: "lab",
        value: 1,
      });
    const metrics = computeMetrics(
      input([signal("10-01T09:00:00"), signal("10-01T11:00:00")], {
        activeSignals: new Set([`blocked_capability:${C}`]),
      }),
    );
    expect(metrics.blocked).toEqual([
      {
        taskId: C,
        title: "Run on the GPU",
        project: "lab",
        summary: "needs gpu and no connected runner offers it",
        firstAt: "2026-10-01T09:00:00.000Z",
        lastAt: "2026-10-01T11:00:00.000Z",
        holds: true,
      },
    ]);
  });
});
