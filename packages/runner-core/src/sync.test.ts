import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileVersion } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TreeCopy, type RemoteTree } from "./sync.js";

describe("TreeCopy", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-sync-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("mirrors whether a file is executable, and fetches a file again when only its mode changed", async () => {
    const local = path.join(dir, "local");
    const files: Record<string, { text: string; mode: number }> = {
      "society/skills/uv/SKILL.md": { text: "# uv\n", mode: 0o644 },
      "society/skills/uv/scripts/check.sh": { text: "#!/bin/sh\n", mode: 0o755 },
    };
    const reads: string[][] = [];
    const remote: RemoteTree = {
      manifest: async () =>
        Object.fromEntries(
          Object.entries(files).map(([file, { text, mode }]) => [
            file,
            fileVersion(createHash("sha256").update(text).digest("hex"), (mode & 0o111) !== 0),
          ]),
        ),
      read: async (paths) => {
        reads.push([...paths]);
        return Object.fromEntries(
          paths.map((file) => [file, Buffer.from(files[file]?.text ?? "").toString("base64")]),
        );
      },
    };
    const copy = new TreeCopy(local, path.join(dir, "state.json"));
    const mode = async (file: string): Promise<number> =>
      (await stat(path.join(local, file))).mode & 0o777;

    await copy.pull(remote);
    expect(await mode("society/skills/uv/scripts/check.sh")).toBe(0o755);
    expect(await mode("society/skills/uv/SKILL.md")).toBe(0o644);
    expect(await readFile(path.join(local, "society/skills/uv/scripts/check.sh"), "utf8")).toBe(
      "#!/bin/sh\n",
    );

    // Nothing changed: nothing is read again.
    await copy.pull(remote);
    expect(reads).toHaveLength(1);

    // The server's copy stopped being executable, and a local chmod is put right too.
    files["society/skills/uv/scripts/check.sh"] = { text: "#!/bin/sh\n", mode: 0o644 };
    await chmod(path.join(local, "society/skills/uv/SKILL.md"), 0o755);
    await copy.pull(remote);
    expect(reads.at(-1)?.toSorted()).toEqual([
      "society/skills/uv/SKILL.md",
      "society/skills/uv/scripts/check.sh",
    ]);
    expect(await mode("society/skills/uv/scripts/check.sh")).toBe(0o644);
    expect(await mode("society/skills/uv/SKILL.md")).toBe(0o644);
  });
});
