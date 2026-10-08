import { describe, expect, it } from "vitest";
import {
  bytesOf,
  linkTarget,
  normalizePath,
  parseDelimited,
  sizeLabel,
  textOf,
  viewOf,
} from "./files.js";

const TASK = "01M4D03FTQRBZ6JCCS1QNWDZ4Q";

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("linkTarget", () => {
  it("reads a path through any runner's task worktree as that task's file", () => {
    for (const href of [
      `/home/tiger/runner-data/worktrees/sage/.tasks/${TASK}/report.md`,
      `/home/stellaris/stellaris-runner/worktrees/ada/.tasks/${TASK}/report.md`,
      `worktrees/sage/.tasks/${TASK}/./report.md`,
      `/data/worktrees/sage/.tasks/${TASK}/report.md?raw=1#top`,
    ]) {
      expect(linkTarget(href)).toEqual({ kind: "task-file", taskId: TASK, path: "report.md" });
    }
    expect(
      linkTarget(`/r/worktrees/sage/.tasks/${TASK}/evidence/analysis/policy%20diagnostics.png`),
    ).toEqual({
      kind: "task-file",
      taskId: TASK,
      path: "evidence/analysis/policy diagnostics.png",
    });
    expect(linkTarget(`/r/worktrees/sage/.tasks/${TASK}`)).toEqual({
      kind: "task-file",
      taskId: TASK,
      path: "",
    });
  });

  it("resolves a relative link against the file it is written in", () => {
    const base = { taskId: TASK, dir: "docs" };
    expect(linkTarget("evidence/plot.png", base)).toEqual({
      kind: "task-file",
      taskId: TASK,
      path: "docs/evidence/plot.png",
    });
    expect(linkTarget("../metrics-plan.md", base)).toEqual({
      kind: "task-file",
      taskId: TASK,
      path: "metrics-plan.md",
    });
    expect(linkTarget("../../etc/passwd", base)).toEqual({ kind: "local" });
  });

  it("reads every other path on a machine as one the board cannot open", () => {
    expect(linkTarget("/home/tiger/runner-data/worktrees/sage/demo/report.md")).toEqual({
      kind: "local",
    });
    expect(linkTarget("/tmp/out.txt")).toEqual({ kind: "local" });
    expect(linkTarget("report.md")).toEqual({ kind: "local" });
    expect(linkTarget("/abs/report.md", { taskId: TASK, dir: "" })).toEqual({ kind: "local" });
    expect(linkTarget(`/r/worktrees/sage/.tasks/${TASK}/../../x`)).toEqual({ kind: "local" });
    expect(linkTarget("")).toEqual({ kind: "local" });
  });

  it("leaves addresses on the web and fragments to the browser", () => {
    for (const href of ["https://arxiv.org/abs/2402.03300", "mailto:a@b.c", "//cdn.x/y", "#top"]) {
      expect(linkTarget(href)).toBeNull();
    }
  });
});

describe("files", () => {
  it("normalizes paths and refuses to climb out of the root", () => {
    expect(normalizePath("a/./b//c/../d")).toBe("a/b/d");
    expect(normalizePath("")).toBe("");
    expect(normalizePath("a/../..")).toBeNull();
  });

  it("parses quoted fields, separators, and line endings in CSV and TSV", () => {
    expect(
      parseDelimited('name,note\r\nada,"says ""hi"", twice"\nref,"two\nlines"\n', ","),
    ).toEqual([
      ["name", "note"],
      ["ada", 'says "hi", twice'],
      ["ref", "two\nlines"],
    ]);
    expect(parseDelimited("a\tb\n1\t", "\t")).toEqual([
      ["a", "b"],
      ["1", ""],
    ]);
  });

  it("shows a file by its name, then by whether its bytes read as text", () => {
    expect(viewOf("report.md", text("# Hi"))).toEqual({ kind: "markdown", text: "# Hi" });
    expect(viewOf("plot.PNG", new Uint8Array([0x89, 0x50]))).toEqual({
      kind: "image",
      type: "image/png",
    });
    expect(viewOf("data.csv", text("a,b\n1,2"))).toEqual({
      kind: "table",
      rows: [
        ["a", "b"],
        ["1", "2"],
      ],
    });
    expect(viewOf("run.log", text("ok\n"))).toEqual({ kind: "text", text: "ok\n" });
    expect(viewOf("model.bin", new Uint8Array([0, 1, 2]))).toEqual({ kind: "binary" });
    expect(textOf(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(bytesOf(btoa("\x00\xff"))).toEqual(new Uint8Array([0, 255]));
    expect(sizeLabel(812)).toBe("812 B");
    expect(sizeLabel(4300)).toBe("4.2 KB");
    expect(sizeLabel(8 * 1024 * 1024)).toBe("8.0 MB");
  });
});
