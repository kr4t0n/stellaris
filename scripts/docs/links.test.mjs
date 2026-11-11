// The link check against what GitHub renders. github-anchors.json holds GitHub's own anchors, from
// `gh api markdown -f mode=markdown` on 2026-11-11: those of the repository's headings whose anchor
// is more than the heading lowercased with hyphens for spaces, and those of a document of edge cases.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkLinks, headingText, readMarkdown, slug } from "./links.mjs";

const github = JSON.parse(readFileSync(new URL("github-anchors.json", import.meta.url), "utf8"));
const script = fileURLToPath(new URL("check-links.mjs", import.meta.url));

const folders = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A git repository holding these files, none of them committed, as a branch's new files are. */
function repository(files) {
  const root = mkdtempSync(path.join(tmpdir(), "check-links-"));
  folders.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function check(files) {
  const root = repository(files);
  const markdown = Object.keys(files).filter((file) => file.endsWith(".md"));
  return checkLinks(root, Object.keys(files), markdown).problems.map(
    ({ file, line, target, problem }) => `${file}:${line}: ${target} ${problem}`,
  );
}

const guide = ["# Set up", "", "## A heading with `code` and a [link](../README.md)", ""].join(
  "\n",
);
const readme = [
  "# Top",
  "",
  "[The guide](docs/guide.md), [setting up](docs/guide.md#set-up), and",
  "[its code](./docs/guide.md#a-heading-with-code-and-a-link). [The docs](docs/), [the top](#top).",
  '<img src="logo.svg" alt=""> <a id="here"></a> [Here](#here) and [away](https://example.com/x).',
  "",
].join("\n");

describe("anchors", () => {
  it("are GitHub's for the repository's headings", () => {
    const made = github.headings.map(([heading]) => [heading, slug(headingText(heading))]);
    expect(made).toEqual(github.headings);
  });

  it("are GitHub's for a document of edge cases, repeated headings told apart", () => {
    // GitHub anchors a heading whose text leaves nothing for one as `""`, `-1`, and so on, or not
    // at all, by the file's other headings, so the check offers none of those.
    const sure = github.document.anchors.filter((anchor) => !/^(-\d+)?$/u.test(anchor));
    expect(readMarkdown(github.document.markdown).anchors).toEqual(new Set(sure));
  });
});

describe("check-links.mjs", () => {
  it("passes a repository whose links all resolve", () => {
    const run = spawnSync(process.execPath, [script], {
      cwd: repository({ "README.md": readme, "docs/guide.md": guide, "logo.svg": "<svg/>" }),
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toMatch(
      /^No broken links: 8 relative links, 4 of them to anchors, in 2 markdown files/u,
    );
    expect(run.status).toBe(0);
  });

  it("fails on a link to a missing file and on one to a missing anchor", () => {
    const planted = `${readme}\n[Gone](docs/gone.md) and [tearing down](docs/guide.md#tear-down).\n`;
    const run = spawnSync(process.execPath, [script], {
      cwd: repository({ "README.md": planted, "docs/guide.md": guide, "logo.svg": "<svg/>" }),
      encoding: "utf8",
    });
    expect(run.stderr.split("\n")).toEqual([
      "README.md:7: docs/gone.md names docs/gone.md, which does not exist",
      "README.md:7: docs/guide.md#tear-down names no heading or anchor in docs/guide.md",
      "",
    ]);
    expect(run.stdout).toMatch(/^2 broken: 10 relative links, 5 of them to anchors/u);
    expect(run.status).toBe(1);
  });
});

describe("checkLinks", () => {
  it("fails a missing anchor on the same page, a path out of the repository, and an image's file", () => {
    const text = "# Here\n\n[Nowhere](#nowhere), [out](../outside.md), ![a picture](picture.png)\n";
    expect(check({ "a.md": text })).toEqual([
      "a.md:3: #nowhere names no heading or anchor in a.md",
      "a.md:3: ../outside.md leaves the repository",
      "a.md:3: picture.png names picture.png, which does not exist",
    ]);
  });

  it("reads reference definitions, angle brackets, parentheses, escapes, and percent-encoding", () => {
    const text = [
      "# Café au lait",
      "",
      "[One][one], [two](<docs/a file.md>), [three](docs/a(b).md), [four](docs/a\\_c.md),",
      "[five](docs/a%20file.md#caf%C3%A9-au-lait), [six](docs/a%20file.md#café-au-lait).",
      "",
      "[one]: docs/missing.md",
    ].join("\n");
    expect(
      check({
        "a.md": text,
        "docs/a file.md": "# Café au lait\n",
        "docs/a(b).md": "",
        "docs/a_c.md": "",
      }),
    ).toEqual(["a.md:6: docs/missing.md names docs/missing.md, which does not exist"]);
  });

  it("leaves links in code, fences, comments, and other schemes alone", () => {
    const text = [
      "`[a](missing.md)` and ``[b](missing.md#x)`` and \\[c](missing.md) and c](missing.md) <!-- [d](missing.md) -->",
      "",
      "1. A step:",
      "",
      "   ```sh",
      "   echo '[e](missing.md)'",
      "   ```",
      "",
      "~~~~",
      "[f](missing.md)",
      "~~~~",
      "",
      "[g](https://example.com/missing.md), [h](mailto:someone@example.com), [i](//example.com/x).",
    ].join("\n");
    expect(check({ "a.md": text })).toEqual([]);
  });

  it("reads reference definitions in list items and quotes", () => {
    const text = ["- [d]: gone.md", "", "> [q]: q.md", "", "[D][d] and [Q][q]"].join("\n");
    expect(check({ "a.md": text, "q.md": "" })).toEqual([
      "a.md:1: gone.md names gone.md, which does not exist",
    ]);
  });

  it("offers no anchor it can't be sure of, so a link to one fails", () => {
    const text = [
      "## Build &rarr; deploy",
      "",
      "## 🚀",
      "",
      "## 🚀",
      "",
      '<a id="caf&eacute;"></a>',
      "",
      "[1](#build--deploy) [2](#-1) [3](#café)",
    ].join("\n");
    expect(check({ "a.md": text })).toEqual([
      "a.md:9: #build--deploy names no heading or anchor in a.md",
      "a.md:9: #-1 names no heading or anchor in a.md",
      "a.md:9: #café names no heading or anchor in a.md",
    ]);
  });

  it("reads anchors from headings in lists, quotes, and HTML, and from ids and names", () => {
    const text = [
      "- # In a list",
      "> ## In a quote",
      '<h2 align="center">In <em>HTML</em></h2>',
      '<a name="named"></a> <span id="spanned"></span>',
      "",
      "[1](#in-a-list) [2](#in-a-quote) [3](#in-html) [4](#named) [5](#spanned)",
    ].join("\n");
    expect(check({ "a.md": text })).toEqual([]);
  });
});
