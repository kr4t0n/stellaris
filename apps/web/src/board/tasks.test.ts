import type { Task } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { assigneeOf, groupTasks, phaseOf, progressOf, stepLabel } from "./tasks.js";

const ts = "2026-09-29T10:00:00.000Z";

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    project: "lab",
    channel: "general",
    title: id,
    status: "open",
    createdBy: "user",
    createdAt: ts,
    updatedAt: ts,
    blockedBy: [],
    requiredCapabilities: [],
    stages: [
      {
        id: "s1",
        name: "draft",
        role: "writer",
        gate: false,
        holders: ["ann"],
        completedBy: "ann",
      },
      { id: "s2", name: "review", role: "editor", gate: true, holders: [] },
    ],
    stage: "s2",
    stageSince: ts,
    stageSeq: 2,
    onDone: "merge",
    completing: false,
    body: "",
    ...extra,
  };
}

function stepText(step: Parameters<typeof stepLabel>[0], known = true): string {
  return stepLabel(step, known ? task("a") : undefined).text;
}

describe("task phases", () => {
  it("names where a task stands, from its status and its completion effect", () => {
    expect(phaseOf(task("a"))).toBe("waiting");
    expect(phaseOf(task("b", { status: "claimed", claimedBy: "ed" }))).toBe("working");
    expect(phaseOf(task("c", { completing: true }))).toBe("landing");
    expect(phaseOf(task("d", { status: "done" }))).toBe("done");
    expect(phaseOf(task("e", { status: "abandoned" }))).toBe("abandoned");
    const back = { from: "s2", by: "ed", at: ts };
    expect(phaseOf(task("f", { stage: "s1", returned: back }))).toBe("returned");
    expect(phaseOf(task("g", { status: "claimed", claimedBy: "ann", returned: back }))).toBe(
      "returned",
    );
    expect(phaseOf(task("h", { completing: true, returned: back }))).toBe("landing");
  });

  it("groups tasks in view order, newest first, leaving out empty groups", () => {
    const groups = groupTasks([
      task("old", { status: "done", updatedAt: "2026-09-29T09:00:00.000Z" }),
      task("new", { status: "done", updatedAt: "2026-09-29T11:00:00.000Z" }),
      task("waits"),
    ]);
    expect(groups.map((group) => [group.phase, group.tasks.map((each) => each.id)])).toEqual([
      ["waiting", ["waits"]],
      ["done", ["new", "old"]],
    ]);
  });

  it("says who may hold a stage and how far a task has come", () => {
    const [draft, review] = task("a").stages;
    expect(draft === undefined ? "" : assigneeOf({ ...draft, agent: "ann" })).toBe("ann");
    expect(review === undefined ? "" : assigneeOf(review)).toBe("any editor");
    expect(assigneeOf({ id: "s3", name: "x", gate: false, holders: [] })).toBe(
      "anyone in the project",
    );
    expect(progressOf(task("a"))).toBe("Stage 2 of 2");
    expect(progressOf(task("b", { status: "done" }))).toBe("All 2 stages done");
  });

  it("names a step's stages when the task is at hand, and their ids otherwise", () => {
    expect(stepText({ action: "advanced", stage: "s1", to: "s2" })).toBe("finished draft → review");
    expect(stepText({ action: "advanced", stage: "s2", to: null })).toBe("finished review");
    expect(stepText({ action: "returned", stage: "s2", to: "s1" })).toBe(
      "sent back from review to draft",
    );
    expect(stepText({ action: "returned", stage: "s2", to: "s1" }, false)).toBe(
      "sent back from s2 to s1",
    );
    expect(stepText({ action: "landed", stage: "s2", to: null })).toBe("landed");
    expect(stepText({ action: "reopened", stage: "s2", to: "s2" })).toBe(
      "landing failed · back at review",
    );
  });
});
