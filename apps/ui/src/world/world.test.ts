import type { BoardEvent, Member, Project, Proposal, Task } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { layoutWorld, plotSize } from "./layout.js";
import type { WorldSnapshot } from "./types.js";
import { describeWorld, worldFrom } from "./world.js";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const DAY_START = Date.parse("2026-09-29T00:00:00.000Z");

function project(slug: string, members: string[]): Project {
  return {
    slug,
    name: slug === "demo" ? "Demo" : slug,
    repo: null,
    defaultBranch: "main",
    channels: ["general", "dev"],
    members,
    approvers: ["owner"],
    requiredCapabilities: [],
    createdAt: "2026-09-28T10:00:00.000Z",
  };
}

function member(
  name: string,
  role: string,
  cli: "claude" | "codex" | null,
  extra: Partial<Member> = {},
): Member {
  return {
    name,
    role,
    cli,
    homeRunner: "local",
    status: "active",
    resident: false,
    skills: [],
    memberships: ["demo"],
    subscriptions: [],
    claimsHeld: 0,
    tasksDone: 0,
    createdAt: "2026-09-28T10:00:00.000Z",
    profile: "# Profile\n\nShips small services.\n",
    ...extra,
  };
}

function task(id: string, title: string, status: Task["status"], extra: Partial<Task> = {}): Task {
  return {
    id,
    project: "demo",
    title,
    status,
    thread: "none",
    createdBy: "owner",
    createdAt: `2026-09-28T10:0${id.slice(-1)}:00.000Z`,
    updatedAt: "2026-09-28T10:00:00.000Z",
    blockedBy: [],
    requiredCapabilities: [],
    body: "",
    ...extra,
  };
}

function event(
  type: BoardEvent["type"],
  actor: string,
  payload: Record<string, unknown>,
  ts = "2026-09-29T11:00:00.000Z",
): BoardEvent {
  return { id: `01M${type.length}${actor}`, ts, type, actor, payload };
}

const baseSnapshot: WorldSnapshot = {
  projects: [project("demo", ["eng-1", "rev-1"])],
  members: [
    member("owner", "owner", null, { memberships: [] }),
    member("eng-1", "engineer", "codex", { claimsHeld: 1, lastModel: "gpt-5-codex" }),
    member("rev-1", "reviewer", "claude"),
    member("desk", "concierge", "claude", { memberships: [] }),
    member("old-1", "engineer", "claude", {
      status: "retired",
      retiredAt: "2026-09-28T20:00:00.000Z",
    }),
  ],
  tasks: {
    demo: [
      task("T1", "Add hello.txt", "claimed", {
        claimedBy: "eng-1",
        leaseExpiresAt: "2026-09-29T13:00:00.000Z",
      }),
      task("T2", "Add a health endpoint", "in_review", { claimedBy: "eng-1" }),
      task("T3", "Write docs", "open"),
      task("T4", "Old idea", "abandoned"),
    ],
  },
  scheduler: { paused: false, running: [], pending: [], resident: [], signals: [] },
  proposals: [],
  unread: 0,
  events: [],
  activity: {},
  library: { skills: 1, knowledge: 2 },
  now: NOW,
  dayStart: DAY_START,
};

describe("layoutWorld", () => {
  it("is deterministic, sizes plots by membership, and never overlaps plots or houses", () => {
    const input = {
      projects: [
        { slug: "a", members: 1 },
        { slug: "b", members: 4 },
        { slug: "c", members: 7 },
        { slug: "d", members: 2 },
      ],
      citizens: ["eng-1", "rev-1", "desk"],
      memorials: ["old-1"],
    };
    const first = layoutWorld(input);
    const second = layoutWorld(input);
    expect(second).toEqual(first);
    expect(plotSize(1)).toEqual({ w: 10, h: 8 });
    expect(plotSize(4)).toEqual({ w: 12, h: 9 });
    expect(plotSize(7)).toEqual({ w: 14, h: 10 });
    const rects = [...first.plots.values()].map((plot) => plot.rect);
    for (const a of rects) {
      for (const b of rects) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    }
    // The fourth plot starts a second row; the world grows to hold it.
    expect(first.plots.get("d")?.rect.y).toBeGreaterThan(first.plots.get("a")?.rect.y ?? 0);
    expect(first.size.h).toBeGreaterThan((first.plots.get("d")?.rect.y ?? 0) + 8);
    expect([...first.houses.values()].map((house) => house.rect.x)).toEqual([2, 7, 12]);
    expect(first.memorials.get("old-1")?.x).toBeGreaterThan(12 + 4);
    // Every crop cell and desk lies inside its plot.
    for (const plot of first.plots.values()) {
      for (const cell of [...plot.cells, ...plot.desks]) {
        expect(cell.x).toBeGreaterThanOrEqual(plot.rect.x);
        expect(cell.x).toBeLessThan(plot.rect.x + plot.rect.w);
        expect(cell.y).toBeGreaterThanOrEqual(plot.rect.y);
        expect(cell.y).toBeLessThan(plot.rect.y + plot.rect.h);
      }
    }
  });
});

describe("worldFrom", () => {
  it("projects idle citizens to their houses, tasks to crops, and retired members to the garden", () => {
    const world = worldFrom(baseSnapshot);
    expect(world.citizens.map((c) => [c.name, c.state, c.where])).toEqual([
      ["eng-1", "idle", "home"],
      ["rev-1", "idle", "home"],
      ["desk", "idle", "home"],
    ]);
    const eng = world.citizens[0];
    const house = world.houses.find((h) => h.agent === "eng-1");
    expect(eng?.at).toEqual(house?.door);
    expect(eng?.model).toBe("gpt-5-codex");
    expect(eng?.profile).toBe("Ships small services.");
    const demo = world.plots[0];
    expect(demo?.crops.map((crop) => [crop.title, crop.stage, crop.claimedBy])).toEqual([
      ["Add hello.txt", "growing", "eng-1"],
      ["Add a health endpoint", "ripe", "eng-1"],
      ["Write docs", "seed", null],
      ["Old idea", "withered", null],
    ]);
    expect(demo?.crops.every((crop) => !crop.wilted && !crop.marked)).toBe(true);
    expect(world.memorials.map((m) => [m.agent, m.reason])).toEqual([
      ["old-1", "retired 2026-09-28"],
    ]);
    expect(world.mailbox).toEqual({
      flag: false,
      waiting: 0,
      proposals: 0,
      unread: 0,
      failedMerges: 0,
    });
    expect(world.night).toBe(false);
    expect(world.coins).toBe(0);
    expect(world.library).toEqual({ skills: 1, knowledge: 2 });
  });

  it("stands a working claimer beside its crop, a reviewer beside the ripe one, and the desk at the front desk", () => {
    const world = worldFrom({
      ...baseSnapshot,
      scheduler: {
        paused: false,
        running: ["eng-1/demo", "rev-1/demo", "desk/society"],
        pending: [],
        resident: ["desk/society"],
        signals: [],
      },
      activity: {
        "eng-1": {
          kind: "talking",
          text: "Committed hello.txt on my branch.\nMore detail.",
          at: NOW - 5_000,
        },
        "rev-1": { kind: "working", text: null, at: NOW - 60_000 },
      },
    });
    const [eng, rev, desk] = world.citizens;
    const demo = world.plots[0];
    const growing = demo?.crops.find((crop) => crop.taskId === "T1");
    const ripe = demo?.crops.find((crop) => crop.taskId === "T2");
    expect(eng?.state).toBe("talking");
    expect(eng?.bubble).toBe("Committed hello.txt on my branch.");
    expect(eng?.at).toEqual({ x: (growing?.at.x ?? 0) + 1, y: growing?.at.y });
    expect(rev?.state).toBe("working");
    expect(rev?.at).toEqual({ x: (ripe?.at.x ?? 0) + 1, y: ripe?.at.y });
    expect(desk?.state).toBe("working");
    expect(desk?.where).toBe("society");
    expect(desk?.at).toEqual({ x: world.square.frontDesk.x + 1, y: world.square.frontDesk.y + 2 });
    expect(world.houses.find((h) => h.agent === "desk")?.lamp).toBe(true);
    expect(world.houses.find((h) => h.agent === "eng-1")?.lamp).toBe(false);
  });

  it("walks a queued citizen to the gate, keeps a warm resident at its desk, and puts an idle member to sleep", () => {
    const world = worldFrom({
      ...baseSnapshot,
      scheduler: {
        paused: true,
        running: [],
        pending: ["eng-1/demo"],
        resident: ["desk/society"],
        signals: ["idle_member:rev-1"],
      },
    });
    const [eng, rev, desk] = world.citizens;
    expect(eng?.state).toBe("walking");
    expect(eng?.at).toEqual(world.plots[0]?.gate);
    expect(rev?.state).toBe("sleeping");
    expect(desk?.state).toBe("idle");
    expect(desk?.lamp).toBe(true);
    expect(desk?.where).toBe("society");
    expect(world.night).toBe(true);
  });

  it("turns active signals into weather on the right plot or crop, and never invents one", () => {
    const world = worldFrom({
      ...baseSnapshot,
      scheduler: {
        paused: false,
        running: [],
        pending: [],
        resident: [],
        signals: [
          "backlog:demo:engineer",
          "role_gap:demo:reviewer",
          "stale_thread:T2",
          "churn:T3",
          "blocked_capability:T1",
          "backlog:nowhere:engineer",
          "turn_cost",
        ],
      },
    });
    const demo = world.plots[0];
    expect(demo?.weather.map((w) => [w.kind, w.label])).toEqual([
      ["cloud", "backlog for engineer"],
      ["hiring", "role gap for reviewer"],
      ["cobweb", "stale thread"],
      ["dust", "churn"],
      ["lock", "blocked capability"],
    ]);
    const cobweb = demo?.weather.find((w) => w.kind === "cobweb");
    expect(cobweb?.at).toEqual(demo?.crops.find((crop) => crop.taskId === "T2")?.at);
    const cloud = demo?.weather.find((w) => w.kind === "cloud");
    expect(cloud?.at.y).toBe((demo?.rect.y ?? 0) - 1);
  });

  it("raises the mailbox flag for proposals, unread items, and failed merges, and counts the day's coins", () => {
    const proposal: Proposal = {
      id: "01PROPOSAL",
      kind: "skill",
      proposedBy: "eng-1",
      status: "proposed",
      createdAt: "2026-09-29T11:00:00.000Z",
      charter: {},
      body: "",
    };
    const world = worldFrom({
      ...baseSnapshot,
      proposals: [proposal, { ...proposal, id: "01DECIDED", status: "provisioned" }],
      unread: 2,
      events: [
        event("turn.completed", "eng-1", { costUsd: 0.4 }, "2026-09-29T01:00:00.000Z"),
        event("turn.completed", "rev-1", { costUsd: 0.25 }, "2026-09-29T02:00:00.000Z"),
        event("turn.completed", "rev-1", { costUsd: 9 }, "2026-09-28T23:00:00.000Z"),
        event(
          "merge.failed",
          "board",
          { project: "demo", taskId: "T1" },
          "2026-09-29T03:00:00.000Z",
        ),
        event(
          "merge.completed",
          "board",
          { project: "demo", taskId: "T2" },
          "2026-09-29T04:00:00.000Z",
        ),
      ],
    });
    expect(world.mailbox).toEqual({
      flag: true,
      waiting: 4,
      proposals: 1,
      unread: 2,
      failedMerges: 1,
    });
    expect(world.notices).toBe(1);
    expect(world.coins).toBeCloseTo(0.65);
    const demo = world.plots[0];
    expect(demo?.harvests).toBe(1);
    expect(demo?.crops.find((crop) => crop.taskId === "T1")?.marked).toBe(true);
    expect(demo?.crops.find((crop) => crop.taskId === "T2")?.marked).toBe(false);
  });

  it("wilts a claim past its lease and overflows a full field onto the sign", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      task(`T${index}`, `Task ${index}`, "open", {
        createdAt: `2026-09-28T10:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const world = worldFrom({
      ...baseSnapshot,
      tasks: {
        demo: [
          task("T1", "Stale claim", "claimed", {
            claimedBy: "eng-1",
            leaseExpiresAt: "2026-09-29T11:00:00.000Z",
            createdAt: "2026-09-28T09:00:00.000Z",
          }),
          ...many,
        ],
      },
    });
    const demo = world.plots[0];
    expect(demo?.crops[0]?.wilted).toBe(true);
    expect((demo?.crops.length ?? 0) + (demo?.overflow ?? 0)).toBe(21);
    expect(demo?.overflow).toBeGreaterThan(0);
  });

  it("describes the world one line per entity", () => {
    const described = describeWorld(
      worldFrom({
        ...baseSnapshot,
        scheduler: {
          paused: true,
          running: ["eng-1/demo"],
          pending: [],
          resident: [],
          signals: ["backlog:demo:engineer"],
        },
      }),
    );
    expect(described.citizens).toEqual([
      "eng-1, engineer on codex: working in demo",
      "rev-1, reviewer on claude: at home",
      "desk, concierge on claude: at home",
    ]);
    expect(described.plots).toEqual([
      "Demo: 2 member(s); Add hello.txt growing, Add a health endpoint ripe, Write docs seed, Old idea withered; 0 harvest(s); weather backlog for engineer",
    ]);
    expect(described.square).toEqual([
      "Mailbox: 0 waiting",
      "Town hall: 0 proposal(s) to decide",
      "Library: 1 skill(s), 2 topic(s)",
      "Clock: stopped, the society is paused",
    ]);
  });
});
