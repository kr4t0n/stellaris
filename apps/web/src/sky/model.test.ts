import { TaskFrontmatterSchema, type Member, type Project, type Task } from "@stellaris/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchedulerView } from "../lib/api.js";
import { tableText } from "./ios-tables.js";
import { markLabel, skyModel, starOf, type SkySnapshot } from "./model.js";

const ts = "2026-09-29T10:00:00.000Z";

function member(name: string, extra: Partial<Member> = {}): Member {
  return {
    name,
    role: "engineer",
    cli: "claude",
    homeRunner: "server",
    status: "active",
    resident: false,
    skills: [],
    memberships: [],
    subscriptions: [],
    claimsHeld: 0,
    tasksDone: 0,
    createdAt: ts,
    profile: "",
    ...extra,
  };
}

function project(slug: string, createdAt: string): Project {
  return {
    slug,
    name: slug,
    repo: null,
    defaultBranch: "main",
    channels: ["general"],
    archivedChannels: [],
    members: [],
    approvers: ["user"],
    requiredCapabilities: [],
    createdAt,
    onDone: "none",
  };
}

function task(id: string, extra: Record<string, unknown> = {}): Task {
  return {
    ...TaskFrontmatterSchema.parse({
      id,
      project: "lab",
      title: `task ${id.slice(-1)}`,
      status: "open",
      createdBy: "desk",
      createdAt: ts,
      updatedAt: ts,
      blockedBy: [],
      requiredCapabilities: [],
      stages: [
        { id: "s1", name: "Work", role: "researcher" },
        { id: "s2", name: "Review", role: "referee", gate: true },
      ],
      stage: "s1",
      stageSince: ts,
      stageSeq: 2,
      ...extra,
    }),
    body: "",
  };
}

const idle: SchedulerView = {
  paused: false,
  running: [],
  pending: [],
  resident: [],
  signals: [],
  turns: [],
};

function snapshot(extra: Partial<SkySnapshot>): SkySnapshot {
  return { members: [], projects: [], scheduler: idle, ...extra };
}

/** `count` projects created a minute apart, each with a few members of its own, and two citizens at the core. */
function crowd(count: number): SkySnapshot {
  const sizes = [1, 4, 2, 6, 1, 3, 2, 5, 1, 2, 3, 1, 0, 7];
  const projects = Array.from({ length: count }, (_, index) =>
    project(`p${index}`, new Date(Date.parse(ts) + index * 60_000).toISOString()),
  );
  const members = [member("desk", { cli: "codex" }), member("stew")];
  projects.forEach((each, index) => {
    for (let k = 0; k < (sizes[index % sizes.length] ?? 1); k += 1) {
      members.push(member(`${each.slug}-${k}`, { memberships: [each.slug] }));
    }
  });
  return snapshot({ members, projects });
}

const seated = {
  members: [
    member("ada", { memberships: ["lab"] }),
    member("bo", { memberships: ["lab"] }),
    member("stew"),
  ],
  projects: [project("lab", ts), project("web", "2026-09-29T11:00:00.000Z")],
};

/** A task id ending in `tail`, as long as a ULID. */
function ulid(tail: string): string {
  return `01M3Q2${tail.padStart(20, "B")}`;
}

/**
 * Names a numeric order or a locale would sort apart from their code units: Danish puts `aarhus`
 * after `zed`, Czech puts `chris` after `hana`.
 */
const SORTED_APART = [
  "p10",
  "p9",
  "p1-2",
  "p1",
  "aarhus",
  "zed",
  "hana",
  "chris",
  "eng-10",
  "eng-9",
  "a-b",
  "ab",
];

/**
 * Every board the tests below draw, by name. The last test writes each, with what the sky makes
 * of it, to the table BoardKit's port runs.
 */
const BOARDS = {
  onlyActive: snapshot({
    members: [
      member("user", { cli: null, role: "user" }),
      member("ada"),
      member("old", { status: "retired" }),
    ],
  }),
  creationOrder: snapshot({
    projects: [
      project("later", "2026-09-29T12:00:00.000Z"),
      project("first", "2026-09-29T09:00:00.000Z"),
    ],
  }),
  turns: snapshot({
    members: [
      member("ada", { memberships: ["lab", "web"] }),
      member("bo", { memberships: ["lab"] }),
      member("cy", { memberships: ["lab", "web"] }),
      member("desk", { cli: "codex" }),
    ],
    projects: [project("lab", ts), project("web", "2026-09-29T11:00:00.000Z")],
    scheduler: {
      ...idle,
      // ada works two conversations in lab, its home and a task's thread: one star there.
      running: ["ada/web", "ada/lab", "ada/lab/01M3S1EF764MW5N61H5J41VGR2", "desk/society"],
      pending: ["bo/lab/01M3S1EF764MW5N61H5J41VGR2"],
      resident: ["desk/society"],
    },
  }),
  resting: snapshot(seated),
  busy: snapshot({ ...seated, scheduler: { ...idle, running: ["ada/lab", "stew/web"] } }),
  oneRing: crowd(1),
  twoRings: crowd(9),
  threeRings: crowd(25),
  growing: snapshot({
    members: ["a", "b", "c", "d", "e"].map((name) => member(name, { memberships: ["big"] })),
    projects: [project("big", ts), project("empty", "2026-09-29T11:00:00.000Z")],
  }),
  spaced: snapshot({
    members: ["a", "b", "c", "d", "e", "f"].map((name) => member(name, { memberships: ["lab"] })),
    projects: [project("lab", ts)],
  }),
  orbit: snapshot({
    members: [member("ada", { memberships: ["lab"] }), member("ref", { memberships: ["lab"] })],
    projects: [project("lab", ts)],
    scheduler: { ...idle, running: ["ada/lab"] },
    tasks: [
      task("01M3Q2AAAAAAAAAAAAAAAAAAA3", { status: "claimed", claimedBy: "ref" }),
      task("01M3Q2AAAAAAAAAAAAAAAAAAA1", { status: "claimed", claimedBy: "ada" }),
      task("01M3Q2AAAAAAAAAAAAAAAAAAA2"),
      task("01M3Q2AAAAAAAAAAAAAAAAAAA4", { status: "done" }),
      task("01M3Q2AAAAAAAAAAAAAAAAAAA5", {
        stage: "s1",
        returned: { from: "s2", by: "ref", at: ts },
      }),
    ],
  }),
  liveEvent: snapshot({
    members: [member("ada", { memberships: ["lab"] }), member("desk")],
    projects: [project("lab", ts)],
    scheduler: { ...idle, running: ["ada/lab"] },
  }),
  sortedApart: snapshot({
    members: SORTED_APART.map((name) => member(name, { memberships: ["p10"] })),
    projects: [
      project("p9", ts),
      project("p10", ts),
      project("b", ts),
      project("aa", ts),
      project("z0", "2026-09-29T09:59:59.999Z"),
    ],
    scheduler: { ...idle, running: ["p9/p10", "p10/p10"] },
    tasks: [
      task(ulid("A9Z"), { project: "p10" }),
      task(ulid("A10"), { project: "p10" }),
      task(ulid("AB0"), { project: "p10" }),
    ],
  }),
  sessionKeys: snapshot({
    members: ["ada", "bo", "cy", "di", "eve", "fay", "gus"].map((name) =>
      member(name, { memberships: ["lab", "web"] }),
    ),
    projects: [project("lab", ts), project("web", "2026-09-29T11:00:00.000Z")],
    scheduler: {
      ...idle,
      running: ["ada/lab/#release", "bo/society/~lab", "cy/lab/x/y", "di", "eve/gone"],
      pending: ["fay/web", "fay/lab/01M3S1EF764MW5N61H5J41VGR2"],
      resident: ["gus/society/#digest"],
    },
  }),
  assignees: snapshot({
    members: [member("ada", { memberships: ["lab"] }), member("ref", { memberships: ["lab"] })],
    projects: [
      project("lab", ts),
      { ...project("old", ts), archived: { at: ts, by: "user", reason: "done" } },
    ],
    scheduler: { ...idle, running: ["ada/lab", "ref/society"] },
    tasks: [
      task(ulid("01"), {
        status: "claimed",
        claimedBy: "ada",
        completing: true,
      }),
      task(ulid("02"), { stage: "s9" }),
      task(ulid("03"), {
        stages: [{ id: "s1", name: "Check", agent: "ref" }],
      }),
      task(ulid("04"), { stages: [{ id: "s1", name: "Tidy" }] }),
      task(ulid("05"), { status: "claimed", claimedBy: "ref" }),
      task(ulid("06"), { status: "abandoned" }),
      task(ulid("07"), { project: "old" }),
      task(ulid("08"), { project: "gone" }),
      ...Array.from({ length: 11 }, (_, index) => task(ulid(`C${index}`))),
    ],
  }),
} satisfies Record<string, SkySnapshot>;

describe("skyModel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws only active citizens with a CLI, so not the user and not the retired", () => {
    const model = skyModel(BOARDS.onlyActive);
    expect(model.stars.map((star) => star.name)).toEqual(["ada"]);
  });

  it("puts the society at the center and projects on a ring in creation order", () => {
    const model = skyModel(BOARDS.creationOrder);
    expect(model.anchors.map((anchor) => [anchor.id, anchor.kind])).toEqual([
      ["society", "society"],
      ["first", "project"],
      ["later", "project"],
    ]);
    const [society, first, later] = model.anchors;
    expect([society?.x, society?.y]).toEqual([0, 0]);
    // The first project sits straight above the center, the second opposite it.
    expect(first?.x).toBe(0);
    expect(first?.y).toBeLessThan(0);
    expect(later?.y).toBeGreaterThan(0);
    expect(model.radius).toBeGreaterThan(Math.hypot(later?.x ?? 0, later?.y ?? 0));
  });

  it("puts a star in each project a citizen is in a turn at, and rests everyone else at the core", () => {
    const model = skyModel(BOARDS.turns);
    expect(
      model.stars.map((star) => [star.id, star.anchor, star.state, star.queuedFor, star.resident]),
    ).toEqual([
      ["ada/lab", "lab", "working", null, false],
      ["ada/web", "web", "working", null, false],
      ["bo", "society", "queued", "lab", false],
      ["cy", "society", "idle", null, false],
      ["desk", "society", "working", null, true],
    ]);
  });

  it("reads every kind of session key, and leaves a key it can't read out", () => {
    const model = skyModel(BOARDS.sessionKeys);
    expect(
      model.stars.map((star) => [star.id, star.anchor, star.state, star.queuedFor, star.resident]),
    ).toEqual([
      // A channel's conversation in lab is a turn at lab.
      ["ada/lab", "lab", "working", null, false],
      // A project's conversation asked from the society scope runs at the core.
      ["bo", "society", "working", null, false],
      ["cy", "society", "idle", null, false],
      ["di", "society", "idle", null, false],
      // A scope the sky has no sphere for is the core.
      ["eve", "society", "working", null, false],
      // Of two queued turns, the star waits for the first in the keys' order.
      ["fay", "society", "queued", "lab", false],
      ["gus", "society", "idle", null, true],
    ]);
  });

  it("sizes spheres for who may gather there, so a turn starting moves only its star", () => {
    const resting = skyModel(BOARDS.resting);
    const busy = skyModel(BOARDS.busy);
    // stew is not a member of web: the sphere makes room for a visitor rather than overflow.
    const [, lab, web] = busy.anchors;
    expect(resting.anchors.slice(0, 2)).toEqual(busy.anchors.slice(0, 2));
    expect(lab?.radius).toBe(resting.anchors[1]?.radius);
    expect(web?.radius).toBeGreaterThan(0);
    expect(busy.stars.find((star) => star.id === "ada/lab")?.anchor).toBe("lab");
    expect(busy.stars.find((star) => star.id === "stew/web")?.anchor).toBe("web");
    // Those who stayed at the core keep their seats.
    const seat = (model: typeof busy, id: string): unknown =>
      model.stars.filter((star) => star.id === id).map((star) => [star.x, star.y]);
    expect(seat(busy, "bo")).toEqual(seat(resting, "bo"));
  });

  it("keeps spheres apart and citizens inside them, whatever the number and size of projects", () => {
    for (const count of [1, 2, 3, 7, 9, 12, 25]) {
      const model = skyModel(crowd(count));
      const gaps = model.anchors.flatMap((anchor, index) =>
        model.anchors
          .slice(index + 1)
          .map(
            (other) =>
              Math.hypot(anchor.x - other.x, anchor.y - other.y) - anchor.radius - other.radius,
          ),
      );
      // Spheres are separated by at least the room for a name under each and a gap.
      expect(Math.min(...gaps, Infinity)).toBeGreaterThan(60);
      for (const star of model.stars) {
        const anchor = model.anchors.find((candidate) => candidate.id === star.anchor);
        expect(Math.hypot(star.x - (anchor?.x ?? 0), star.y - (anchor?.y ?? 0)) + 15).toBeLessThan(
          anchor?.radius ?? 0,
        );
      }
      for (const anchor of model.anchors) {
        expect(Math.hypot(anchor.x, anchor.y) + anchor.radius).toBeLessThan(model.radius);
      }
    }
  });

  it("grows a sphere with its citizens", () => {
    const model = skyModel(BOARDS.growing);
    const [, big, empty] = model.anchors;
    expect(big?.radius).toBeGreaterThan(2 * (empty?.radius ?? 0));
  });

  it("spaces the citizens of one anchor apart and draws the same board the same way", () => {
    const model = skyModel(BOARDS.spaced);
    const gaps = model.stars.flatMap((star, index) =>
      model.stars.slice(index + 1).map((other) => Math.hypot(star.x - other.x, star.y - other.y)),
    );
    expect(Math.min(...gaps)).toBeGreaterThan(30);
    expect(skyModel(BOARDS.spaced)).toEqual(model);
  });

  it("orbits a project's tasks in play outside its sphere, oldest at the top, in their phase", () => {
    const model = skyModel(BOARDS.orbit);
    const lab = model.anchors.find((anchor) => anchor.id === "lab");
    if (lab === undefined) throw new Error("no lab");
    expect(
      model.tasks.map((mark) => [mark.id.slice(-1), mark.phase, mark.holder, mark.linked]),
    ).toEqual([
      ["1", "working", "ada", "ada/lab"],
      ["2", "waiting", null, null],
      ["3", "working", "ref", null],
      ["5", "returned", null, null],
    ]);
    // The keyboard's copy of the sky says the same in words, link included.
    expect(model.tasks.map((mark) => markLabel(mark, "Lab"))).toEqual([
      "Task task 1 at Lab, stage Work, being worked, held by ada, in a turn there",
      "Task task 2 at Lab, stage Work, waiting for a holder, for any researcher",
      "Task task 3 at Lab, stage Work, being worked, held by ref",
      "Task task 5 at Lab, stage Work, sent back, for any researcher",
    ]);
    const [first, second, third] = model.tasks;
    // Outside the sphere, and inside the room the layout keeps around it.
    for (const mark of model.tasks) {
      const distance = Math.hypot(mark.x - lab.x, mark.y - lab.y);
      expect(distance).toBeGreaterThan(lab.radius);
      expect(distance).toBeLessThan(lab.radius + 26);
    }
    expect(first?.y).toBeLessThan(lab.y);
    expect(first?.x).toBe(lab.x);
    // The next ones alternate either side of the first.
    expect(Math.sign((second?.x ?? 0) - lab.x)).toBe(-Math.sign((third?.x ?? 0) - lab.x));
  });

  it("names who each stage waits for, and tightens the orbit for a crowd of tasks", () => {
    const model = skyModel(BOARDS.assignees);
    // Neither an archived project's task nor one of a project the board doesn't list has a place.
    expect(model.tasks).toHaveLength(16);
    expect(
      model.tasks
        .slice(0, 5)
        .map((mark) => [mark.id.slice(-1), mark.phase, mark.stage, mark.holder, mark.waitingFor]),
    ).toEqual([
      // A landing task has no holder and waits for nobody.
      ["1", "landing", "Work", null, null],
      // A stage the plan no longer has goes by its id.
      ["2", "waiting", "s9", null, null],
      ["3", "waiting", "Check", null, "ref"],
      ["4", "waiting", "Tidy", null, "anyone in the project"],
      // ref is in a turn, but not at lab, so nothing links the two.
      ["5", "working", "Work", "ref", null],
    ]);
    expect(model.tasks[4]?.linked).toBeNull();
    const lab = model.anchors.find((anchor) => anchor.id === "lab");
    if (lab === undefined) throw new Error("no lab");
    // Sixteen marks at the usual step would pass the arc's end, three quarters of a half turn from
    // the top on either side, into the name below: the step tightens so they end there.
    const fromTop = model.tasks.map((mark) => Math.abs(Math.atan2(mark.x - lab.x, lab.y - mark.y)));
    expect(Math.max(...fromTop)).toBeCloseTo(0.75 * Math.PI, 1);
    expect(Math.max(...fromTop)).toBeLessThan(0.75 * Math.PI + 0.01);
  });

  it("finds the star a live event belongs to", () => {
    const model = skyModel(BOARDS.liveEvent);
    expect(starOf(model, "ada", "lab")).toBe("ada/lab");
    expect(starOf(model, "ada", "pi-study")).toBe("ada/lab");
    expect(starOf(model, "desk", "society")).toBe("desk");
    expect(starOf(model, "nobody", "lab")).toBeNull();
  });

  it("orders citizens, projects and tasks by their code units, whatever the browser's locale", () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare");
    const model = skyModel(BOARDS.sortedApart);
    // A locale's order would draw one board differently in two browsers, and apart from the app's.
    expect(localeCompare).not.toHaveBeenCalled();
    expect(model.stars.map((star) => star.name)).toEqual(SORTED_APART.toSorted());
    expect(model.stars.map((star) => star.name).slice(0, 5)).toEqual([
      "a-b",
      "aarhus",
      "ab",
      "chris",
      "eng-10",
    ]);
    // The oldest project first, then those created together by slug.
    expect(model.anchors.map((anchor) => anchor.id)).toEqual([
      "society",
      "z0",
      "aa",
      "b",
      "p10",
      "p9",
    ]);
    expect(model.tasks.map((mark) => mark.id.slice(-2))).toEqual(["10", "9Z", "B0"]);
  });
});

describe("the model's table for BoardKit's port", () => {
  it("writes what the sky makes of every board above to apps/ios/fixtures/sky", async () => {
    const cases = Object.entries(BOARDS).map(([name, board]) => {
      const model = skyModel(board);
      const place = (id: string): string =>
        model.anchors.find((anchor) => anchor.id === id)?.label ?? id;
      const asked = [
        ...model.stars.flatMap((star) => [
          { agent: star.name, scope: star.anchor },
          { agent: star.name, scope: "gone" },
        ]),
        { agent: "nobody", scope: "society" },
      ];
      return {
        name,
        board: {
          // The fields of a member the sky reads, which are all BoardKit's model holds.
          members: board.members.map(({ name: who, cli, status, memberships }) => ({
            name: who,
            cli,
            status,
            memberships,
          })),
          projects: board.projects,
          scheduler: {
            running: board.scheduler.running,
            pending: board.scheduler.pending,
            resident: board.scheduler.resident,
          },
          tasks: board.tasks ?? [],
        },
        model,
        labels: model.tasks.map((mark) => markLabel(mark, place(mark.project))),
        // Where a live event lands, for boards with a citizen in a turn.
        starOf:
          board.scheduler.running.length === 0
            ? []
            : asked.map((each) => ({ ...each, star: starOf(model, each.agent, each.scope) })),
      };
    });
    await expect(tableText(cases)).toMatchFileSnapshot("../../../ios/fixtures/sky/model.json");
  });
});
