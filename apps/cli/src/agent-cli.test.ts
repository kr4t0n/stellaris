import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Board, type Actor } from "@stellaris/board-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
/** The built command, as `pnpm stellaris` runs it; the build comes before the tests. */
const COMMAND = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const USER: Actor = { name: "user", role: "user" };

describe("stellaris agent cli", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-cli-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("switches a member's CLI from its next turn, with the model and effort given or neither, and says why it will not", async () => {
    const { board } = await Board.init(dir, { name: "cli" });
    await board.addAgent(USER, { name: "desk", role: "concierge", cli: "claude" });
    await board.setAgentModel(USER, "desk", "sonnet");
    await board.addRunner(USER, "pod");
    await board.markRunner("pod", { status: "connected", clis: ["claude", "codex"] });
    const stellaris = (...args: string[]) =>
      run(process.execPath, [COMMAND, "--data", dir, ...args]);

    await expect(stellaris("agent", "cli", "desk", "claude")).rejects.toMatchObject({
      code: 1,
      stderr: "INVALID_STATE: desk runs on claude already\n",
    });
    expect(
      (await stellaris("agent", "cli", "desk", "codex", "--model", "gpt-5.5", "--effort", "xhigh"))
        .stdout,
    ).toBe(
      "desk runs on codex with gpt-5.5 and xhigh effort from its next turn, in a new session in every conversation\n",
    );
    expect(await board.readAgent("desk")).toMatchObject({
      cli: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
    });

    const back = JSON.parse((await stellaris("--json", "agent", "cli", "desk", "claude")).stdout);
    expect(back).toMatchObject({ name: "desk", cli: "claude" });
    expect(back).not.toHaveProperty("model");
    expect(back).not.toHaveProperty("effort");
    await expect(stellaris("agent", "cli", "desk", "gemini")).rejects.toMatchObject({ code: 1 });
    expect((await board.readAgent("desk")).cli).toBe("claude");
  });
});
