// Fails when two files or folders git knows would be one on a disk that ignores case, as macOS's
// default does, or two modules in one folder would be read for each other there (case.mjs). Reads
// every file git knows, tracked or new and not ignored, so it checks locally what CI will check.
// Usage: node scripts/paths/check-case.mjs, from anywhere in the repository; `pnpm lint` runs it.
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import { caseClashes } from "./case.mjs";

const started = performance.now();
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const listed = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
);
// A file deleted but not yet staged is still listed.
const files = [...new Set(listed.split("\0"))].filter(
  (file) =>
    file !== "" && lstatSync(path.join(root, file), { throwIfNoEntry: false }) !== undefined,
);
const clashes = caseClashes(files);
for (const { kind, names } of clashes) {
  console.error(
    `${names.join(", ")}: ${kind === "path" ? "one path" : "one module"} on a disk that ignores case`,
  );
}
const took = Math.round(performance.now() - started);
console.log(
  `${clashes.length === 0 ? "No case clashes" : `${clashes.length} case ${clashes.length === 1 ? "clash" : "clashes"}`} among ${files.length} files (${took} ms).`,
);
process.exitCode = clashes.length === 0 ? 0 : 1;
