import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SKILL_FILES_LIMIT } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSkillFolder, SKILL_TEXT_LIMIT_CHARS } from "./skill-folder.js";

describe("readSkillFolder", () => {
  let dir: string;
  let skill: string;

  const write = async (file: string, content: string | Buffer, mode = 0o644): Promise<void> => {
    await mkdir(path.dirname(path.join(skill, file)), { recursive: true });
    await writeFile(path.join(skill, file), content);
    await chmod(path.join(skill, file), mode);
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-skill-folder-"));
    skill = path.join(dir, "skills", "uv-setup");
    await write("SKILL.md", "---\nname: uv-setup\n---\n# uv setup\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads every regular file by its path in the folder, with its mode and text", async () => {
    await write("scripts/check.sh", "#!/bin/sh\nuv sync --locked\n", 0o755);
    await write("references/flags.md", "# Flags\n\n--locked\n");
    await write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    expect(await readSkillFolder(skill)).toEqual([
      {
        path: "SKILL.md",
        size: 34,
        executable: false,
        text: "---\nname: uv-setup\n---\n# uv setup\n",
        truncated: false,
      },
      { path: "logo.png", size: 6, executable: false, text: null, truncated: false },
      {
        path: "references/flags.md",
        size: 18,
        executable: false,
        text: "# Flags\n\n--locked\n",
        truncated: false,
      },
      {
        path: "scripts/check.sh",
        size: 27,
        executable: true,
        text: "#!/bin/sh\nuv sync --locked\n",
        truncated: false,
      },
    ]);
  });

  it("cuts a text past the limit and says so, with the size of the whole file", async () => {
    await write("exact.md", "a".repeat(SKILL_TEXT_LIMIT_CHARS));
    await write("wide.md", "é".repeat(SKILL_TEXT_LIMIT_CHARS + 1));
    await write("huge.md", "b".repeat(SKILL_TEXT_LIMIT_CHARS * 8));
    const files = new Map((await readSkillFolder(skill))?.map((file) => [file.path, file]));

    expect(files.get("exact.md")).toMatchObject({ truncated: false });
    expect(files.get("exact.md")?.text).toHaveLength(SKILL_TEXT_LIMIT_CHARS);
    // Two bytes a character: every character within the limit is shown whole.
    expect(files.get("wide.md")).toMatchObject({ truncated: true });
    expect(files.get("wide.md")?.text).toBe("é".repeat(SKILL_TEXT_LIMIT_CHARS));
    expect(files.get("huge.md")).toMatchObject({
      size: SKILL_TEXT_LIMIT_CHARS * 8,
      truncated: true,
      text: "b".repeat(SKILL_TEXT_LIMIT_CHARS),
    });
  });

  it("follows no link, to a file or a folder, out of the folder or within it", async () => {
    const outside = path.join(dir, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "the secret\n");
    await symlink(path.join(outside, "secret.txt"), path.join(skill, "leak.md"));
    await symlink("../../outside/secret.txt", path.join(skill, "relative.md"));
    await symlink(outside, path.join(skill, "references"));
    await symlink(path.join(skill, "SKILL.md"), path.join(skill, "again.md"));
    await write("docs/notes.md", "# Notes\n");
    await symlink(path.join(skill, "docs"), path.join(skill, "alias"));

    const files = await readSkillFolder(skill);
    expect(files?.map((file) => file.path)).toEqual(["SKILL.md", "docs/notes.md"]);
    expect(JSON.stringify(files)).not.toContain("the secret");
  });

  it("is null for a folder that is a link, holds no SKILL.md of its own, or is not there", async () => {
    const linked = path.join(dir, "skills", "linked");
    await symlink(skill, linked);
    expect(await readSkillFolder(linked)).toBeNull();

    const bare = path.join(dir, "skills", "bare");
    await mkdir(bare);
    await writeFile(path.join(bare, "notes.md"), "# Notes\n");
    expect(await readSkillFolder(bare)).toBeNull();

    // A SKILL.md that is a link is not the folder's own.
    await symlink(path.join(skill, "SKILL.md"), path.join(bare, "SKILL.md"));
    expect(await readSkillFolder(bare)).toBeNull();

    expect(await readSkillFolder(path.join(dir, "skills", "missing"))).toBeNull();
    expect(await readSkillFolder(path.join(skill, "SKILL.md"))).toBeNull();
  });

  it(`lists at most ${SKILL_FILES_LIMIT} files, and no atomic write's temporary file`, async () => {
    await write("notes.md.4242.1700000000000.tmp", "half written");
    for (let index = 0; index < SKILL_FILES_LIMIT + 5; index += 1) {
      await write(`steps/step-${String(index).padStart(3, "0")}.md`, `step ${index}\n`);
    }
    const files = (await readSkillFolder(skill)) ?? [];
    expect(files).toHaveLength(SKILL_FILES_LIMIT);
    expect(files[0]?.path).toBe("SKILL.md");
    expect(files.at(-1)?.path).toBe(
      `steps/step-${String(SKILL_FILES_LIMIT - 2).padStart(3, "0")}.md`,
    );
    expect(files.map((file) => file.path)).not.toContain("notes.md.4242.1700000000000.tmp");
  });
});
