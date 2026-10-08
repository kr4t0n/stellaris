import { describe, expect, it } from "vitest";
import { placeName, previousView, visited } from "./trail.js";

const TASK = "01M4D03FTQRBZ6JCCS1QNWDZ4Q";

describe("the trail", () => {
  it("keeps the address of each step, and drops the steps a new visit replaces", () => {
    let trail = visited({}, 0, "/");
    trail = visited(trail, 1, `/task/${TASK}`);
    trail = visited(trail, 2, `/task/${TASK}/files/report.md`);
    trail = visited(trail, 3, `/task/${TASK}/files/evidence/plot.png`);
    expect(previousView(trail, 3)).toBe(`/task/${TASK}/files/report.md`);
    // Back two steps and somewhere new: what was ahead is gone.
    trail = visited(trail, 1, `/task/${TASK}`);
    trail = visited(trail, 2, "/c/general");
    expect(trail).toEqual({ 0: "/", 1: `/task/${TASK}`, 2: "/c/general" });
  });

  it("returns to no view from the first one, nor to the sky", () => {
    const trail = visited(visited({}, 0, "/"), 1, `/task/${TASK}`);
    expect(previousView(trail, 1)).toBeNull();
    expect(previousView(trail, 0)).toBeNull();
    expect(previousView({ 4: `/task/${TASK}` }, 4)).toBeNull();
  });

  it("names the view it returns to as the board knows it", () => {
    const names = {
      entity: (id: string) => (id === TASK ? "Compare shortest-path algorithms" : undefined),
      project: (slug: string) => (slug === "lab" ? "Lab" : undefined),
    };
    expect(placeName(`/task/${TASK}/files/docs/report.md?line=7`, names)).toBe("report.md");
    expect(placeName(`/task/${TASK}/files`, names)).toBe("the task's files");
    expect(placeName(`/task/${TASK}`, names)).toBe("Compare shortest-path algorithms");
    expect(placeName("/thread/01M4D03FTQRBZ6JCCS1QNWDZ4R", names)).toBe("the thread");
    expect(placeName("/c/lab/general", names)).toBe("#general");
    expect(placeName("/p/lab/tasks", names)).toBe("the tasks of Lab");
    expect(placeName("/p/lab", names)).toBe("Lab");
    expect(placeName("/knowledge/lab/seeds", names)).toBe("seeds");
    expect(placeName("/citizen/ada?tab=turns", names)).toBe("ada");
    expect(placeName("/needs-you", names)).toBe("what needs you");
  });
});
