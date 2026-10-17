import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SkillFileList } from "./SkillFileList.js";

const FILES = [
  {
    path: "references/flags.md",
    size: 18,
    executable: false,
    text: "# Flags\n\n--locked\n",
    truncated: false,
  },
  {
    path: "scripts/check.sh",
    size: 2_150,
    executable: true,
    text: "#!/bin/sh\nuv sync --locked\n",
    truncated: false,
  },
  { path: "logo.png", size: 6, executable: false, text: null, truncated: false },
];

describe("SkillFileList", () => {
  it("lists each file closed, by its path, size, and mode, with none of its text", () => {
    const html = renderToStaticMarkup(<SkillFileList files={FILES} />);
    const rows = [...html.matchAll(/<button[^>]*aria-expanded="(\w+)"[^>]*title="([^"]+)"/g)];
    expect(rows.map((row) => [row[2], row[1]])).toEqual([
      ["references/flags.md", "false"],
      ["scripts/check.sh", "false"],
      ["logo.png", "false"],
    ]);
    expect(html).toContain("18 B");
    expect(html).toContain("2.1 KB · executable");
    expect(html.match(/executable/g)).toHaveLength(1);
    expect(html).not.toContain("--locked");
    expect(html).not.toContain("<pre");
  });
});
