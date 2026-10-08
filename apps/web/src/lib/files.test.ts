import { describe, expect, it } from "vitest";
import {
  bytesOf,
  changeLabel,
  citedLine,
  linkTarget,
  normalizePath,
  parseDelimited,
  rehypeLineTarget,
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

  it("splits off the line a link cites, as both CLIs and GitHub write one", () => {
    const at = `/home/tiger/runner-data/worktrees/sage/.tasks/${TASK}`;
    for (const [href, path, line] of [
      [`${at}/report.md:67`, "report.md", 67],
      [`${at}/src/run.py:12:5`, "src/run.py", 12],
      [`${at}/report.md%3A67`, "report.md", 67],
      [`${at}/report.md#L40-L52`, "report.md", 40],
    ] as const) {
      expect(linkTarget(href)).toEqual({ kind: "task-file", taskId: TASK, path, line });
    }
    expect(linkTarget("plot.png:3", { taskId: TASK, dir: "docs" })).toEqual({
      kind: "task-file",
      taskId: TASK,
      path: "docs/plot.png",
      line: 3,
    });
    expect(linkTarget("report.md:67")).toEqual({ kind: "local" });
    expect(linkTarget("javascript:1")).toBeNull();
    expect(citedLine("report.md:0")).toEqual({ path: "report.md:0" });
    expect(citedLine("notes/v2:draft.md")).toEqual({ path: "notes/v2:draft.md" });
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

/** A hast node as the line plugin sees one. */
interface Node {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start: { line: number }; end: { line: number } };
  children?: Node[];
}

function block(tagName: string, start: number, end: number, children: Node[] = []): Node {
  return {
    type: "element",
    tagName,
    properties: {},
    position: { start: { line: start }, end: { line: end } },
    children,
  };
}

/** The blocks the plugin marks for a line, as `tag@start`. */
function marked(line: number): string[] {
  const root: Node = {
    type: "root",
    children: [
      block("h1", 1, 1),
      block("p", 3, 4, [{ type: "element", tagName: "strong", properties: {}, children: [] }]),
      block("ul", 6, 8, [block("li", 6, 6), block("li", 7, 8)]),
    ],
  };
  rehypeLineTarget({ line })(root);
  const found: string[] = [];
  const walk = (node: Node): void => {
    const classes = node.properties?.["className"];
    if (Array.isArray(classes) && classes.includes("line-target")) {
      found.push(`${node.tagName}@${node.position?.start.line}`);
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(root);
  return found;
}

describe("rehypeLineTarget", () => {
  it("marks the innermost block holding a source line, or the next one after a blank line", () => {
    expect(marked(4)).toEqual(["p@3"]);
    expect(marked(8)).toEqual(["li@7"]);
    // Lists are not blocks of their own: the next block after a blank line is the first item.
    expect(marked(5)).toEqual(["li@6"]);
    expect(marked(99)).toEqual([]);
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
    expect(changeLabel({ status: "added", added: 40, removed: 0 })).toBe("new · +40");
    expect(changeLabel({ status: "added", added: null, removed: null })).toBe("new · binary");
    expect(changeLabel({ status: "modified", added: 3, removed: 1 })).toBe("+3 −1");
    expect(changeLabel({ status: "deleted", added: 0, removed: 9 })).toBe("deleted");
    expect(sizeLabel(812)).toBe("812 B");
    expect(sizeLabel(4300)).toBe("4.2 KB");
    expect(sizeLabel(8 * 1024 * 1024)).toBe("8.0 MB");
  });
});
