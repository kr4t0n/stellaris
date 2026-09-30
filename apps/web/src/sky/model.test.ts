import { TaskFrontmatterSchema, type Member, type Project, type Task } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import type { SchedulerView } from "../lib/api.js";
import { skyModel, starOf, type SkySnapshot } from "./model.js";

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
    members: [],
    approvers: ["user"],
    requiredCapabilities: [],
    createdAt,
    defaultPlan: [],
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

const idle: SchedulerView = { paused: false, running: [], pending: [], resident: [], signals: [] };

function snapshot(extra: Partial<SkySnapshot>): SkySnapshot {
  return { members: [], projects: [], scheduler: idle, ...extra };
}

describe("skyModel", () => {
  it("draws only active citizens with a CLI, so not the user and not the retired", () => {
    const model = skyModel(
      snapshot({
        members: [
          member("user", { cli: null, role: "user" }),
          member("ada"),
          member("old", { status: "retired" }),
        ],
      }),
    );
    expect(model.stars.map((star) => star.name)).toEqual(["ada"]);
  });

  it("puts the society at the center and projects on a ring in creation order", () => {
    const model = skyModel(
      snapshot({
        projects: [
          project("later", "2026-09-29T12:00:00.000Z"),
          project("first", "2026-09-29T09:00:00.000Z"),
        ],
      }),
    );
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
    const model = skyModel(
      snapshot({
        members: [
          member("ada", { memberships: ["lab", "web"] }),
          member("bo", { memberships: ["lab"] }),
          member("cy", { memberships: ["lab", "web"] }),
          member("desk", { cli: "codex" }),
        ],
        projects: [project("lab", ts), project("web", "2026-09-29T11:00:00.000Z")],
        scheduler: {
          ...idle,
          running: ["ada/web", "ada/lab", "desk/society"],
          pending: ["bo/lab"],
          resident: ["desk/society"],
        },
      }),
    );
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

  it("sizes spheres for who may gather there, so a turn starting moves only its star", () => {
    const members = [
      member("ada", { memberships: ["lab"] }),
      member("bo", { memberships: ["lab"] }),
      member("stew"),
    ];
    const projects = [project("lab", ts), project("web", "2026-09-29T11:00:00.000Z")];
    const resting = skyModel(snapshot({ members, projects }));
    const busy = skyModel(
      snapshot({ members, projects, scheduler: { ...idle, running: ["ada/lab", "stew/web"] } }),
    );
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
    const crowd = [1, 4, 2, 6, 1, 3, 2, 5, 1, 2, 3, 1, 0, 7];
    for (const count of [1, 2, 3, 7, 9, 12, 25]) {
      const projects = Array.from({ length: count }, (_, index) =>
        project(`p${index}`, new Date(Date.parse(ts) + index * 60_000).toISOString()),
      );
      const members = [member("desk", { cli: "codex" }), member("stew")];
      projects.forEach((each, index) => {
        for (let k = 0; k < (crowd[index % crowd.length] ?? 1); k += 1) {
          members.push(member(`${each.slug}-${k}`, { memberships: [each.slug] }));
        }
      });
      const model = skyModel(snapshot({ members, projects }));
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
    const model = skyModel(
      snapshot({
        members: ["a", "b", "c", "d", "e"].map((name) => member(name, { memberships: ["big"] })),
        projects: [project("big", ts), project("empty", "2026-09-29T11:00:00.000Z")],
      }),
    );
    const [, big, empty] = model.anchors;
    expect(big?.radius).toBeGreaterThan(2 * (empty?.radius ?? 0));
  });

  it("spaces the citizens of one anchor apart and draws the same board the same way", () => {
    const members = ["a", "b", "c", "d", "e", "f"].map((name) =>
      member(name, { memberships: ["lab"] }),
    );
    const board = snapshot({ members, projects: [project("lab", ts)] });
    const model = skyModel(board);
    const gaps = model.stars.flatMap((star, index) =>
      model.stars.slice(index + 1).map((other) => Math.hypot(star.x - other.x, star.y - other.y)),
    );
    expect(Math.min(...gaps)).toBeGreaterThan(30);
    expect(skyModel(board)).toEqual(model);
  });

  it("orbits a project's tasks in play outside its sphere, oldest at the top, in their phase", () => {
    const model = skyModel(
      snapshot({
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
    );
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

  it("finds the star a live event belongs to", () => {
    const model = skyModel(
      snapshot({
        members: [member("ada", { memberships: ["lab"] }), member("desk")],
        projects: [project("lab", ts)],
        scheduler: { ...idle, running: ["ada/lab"] },
      }),
    );
    expect(starOf(model, "ada", "lab")).toBe("ada/lab");
    expect(starOf(model, "ada", "pi-study")).toBe("ada/lab");
    expect(starOf(model, "desk", "society")).toBe("desk");
    expect(starOf(model, "nobody", "lab")).toBeNull();
  });
});
