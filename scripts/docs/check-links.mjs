// Fails when a markdown file in the repository links to a file or folder that isn't there, or to an
// anchor its target lacks, read as GitHub renders it (links.mjs). Reads every markdown file git
// knows, tracked or new and not ignored, so it checks locally what CI will check once committed.
// Usage: node scripts/docs/check-links.mjs, from anywhere in the repository; `pnpm lint` runs it.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { checkLinks } from "./links.mjs";

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
// A file deleted but not yet staged is still listed, and a submodule is a folder.
const files = [...new Set(listed.split("\0"))].filter(
  (file) => file !== "" && statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile(),
);
const markdown = files.filter((file) => /\.md$/iu.test(file));
const { problems, links, anchors } = checkLinks(root, files, markdown);
for (const { file, line, target, problem } of problems) {
  console.error(`${file}:${line}: ${target} ${problem}`);
}
const took = Math.round(performance.now() - started);
console.log(
  `${problems.length === 0 ? "No broken links" : `${problems.length} broken`}: ${links} relative links, ${anchors} of them to anchors, in ${markdown.length} markdown files (${took} ms).`,
);
process.exitCode = problems.length === 0 ? 0 : 1;
