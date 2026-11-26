import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { caseClashes } from "./case.mjs";

const script = fileURLToPath(new URL("check-case.mjs", import.meta.url));

const folders = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A git repository holding these files, none of them committed, as a branch's new files are. */
function repository(files) {
  const root = mkdtempSync(path.join(tmpdir(), "check-case-"));
  folders.push(root);
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "");
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

describe("caseClashes", () => {
  it("passes a folder's modules and their views, tests, and declarations", () => {
    expect(
      caseClashes([
        "src/board/quota.ts",
        "src/board/quota.test.ts",
        "src/board/QuotaReadouts.tsx",
        "src/board/citizen.ts",
        "src/board/CitizenView.tsx",
        "lib/links.js",
        "lib/links.d.ts",
        "lib/links.mjs",
        "styles/Quota.css",
        "styles/quota.ts",
      ]),
    ).toEqual([]);
  });

  it("finds modules in one folder whose names differ only in case", () => {
    expect(
      caseClashes([
        "src/board/Quota.tsx",
        "src/board/quota.ts",
        "src/board/quota.test.ts",
        "src/other/Quota.tsx",
        "scripts/Links.mjs",
        "scripts/links.js",
        "types/Board.d.ts",
        "types/board.js",
      ]),
    ).toEqual([
      { kind: "module", names: ["src/board/Quota.tsx", "src/board/quota.ts"] },
      { kind: "module", names: ["scripts/Links.mjs", "scripts/links.js"] },
      { kind: "module", names: ["types/Board.d.ts", "types/board.js"] },
    ]);
  });

  it("finds files and folders whose paths differ only in case or normalization", () => {
    const composed = "docs/caf\u00e9.md";
    const decomposed = "docs/cafe\u0301.md";
    expect(
      caseClashes(["README.md", "readme.md", "Docs/a.md", "docs/b.md", composed, decomposed]),
    ).toEqual([
      { kind: "path", names: ["README.md", "readme.md"] },
      { kind: "path", names: ["Docs", "docs"] },
      { kind: "path", names: [decomposed, composed] },
    ]);
  });

  it("reports modules whose whole paths clash once, as a path", () => {
    expect(caseClashes(["src/Foo.ts", "src/foo.ts"])).toEqual([
      { kind: "path", names: ["src/Foo.ts", "src/foo.ts"] },
    ]);
  });
});

describe("check-case.mjs", () => {
  it("passes a repository with no clash", () => {
    const run = spawnSync(process.execPath, [script], {
      cwd: repository(["src/quota.ts", "src/QuotaReadouts.tsx", "README.md"]),
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toMatch(/^No case clashes among 3 files \(\d+ ms\)\.\n$/u);
    expect(run.status).toBe(0);
  });

  // Two paths that differ only in case can't both be written on a Mac, where the test may run too.
  it("fails on a clash among the files git knows", () => {
    const run = spawnSync(process.execPath, [script], {
      cwd: repository(["src/quota.ts", "src/quota.test.ts", "src/Quota.tsx", "README.md"]),
      encoding: "utf8",
    });
    expect(run.stderr).toBe(
      "src/Quota.tsx, src/quota.ts: one module on a disk that ignores case\n",
    );
    expect(run.stdout).toMatch(/^1 case clash among 4 files/u);
    expect(run.status).toBe(1);
  });
});
