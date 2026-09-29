import type { Member, Project } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import type { SchedulerView } from "../lib/api.js";
import { skyModel, type SkySnapshot } from "./model.js";

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

  it("places a citizen at its running turn, else its queued turn, else its first project", () => {
    const model = skyModel(
      snapshot({
        members: [
          member("ada", { memberships: ["lab"] }),
          member("bo", { memberships: ["lab"] }),
          member("cy", { memberships: ["lab", "web"] }),
          member("desk", { cli: "codex" }),
        ],
        projects: [project("lab", ts), project("web", "2026-09-29T11:00:00.000Z")],
        scheduler: {
          ...idle,
          running: ["ada/web"],
          pending: ["bo/society"],
          resident: ["desk/society"],
        },
      }),
    );
    expect(model.stars.map((star) => [star.name, star.anchor, star.state, star.resident])).toEqual([
      ["ada", "web", "working", false],
      ["bo", "society", "queued", false],
      ["cy", "lab", "idle", false],
      ["desk", "society", "idle", true],
    ]);
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
});
