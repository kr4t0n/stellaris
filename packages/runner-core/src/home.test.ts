import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HomeSync } from "./home.js";
import { RunnerLayout } from "./layout.js";

const TURN_A = "01M3S000000000000000000AAA";
const TURN_B = "01M3S000000000000000000BBB";
const LINES = ["# Core memory", "", "- one", "- two", "- three", "- four", "- five", ""];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa(
    "git",
    ["-c", "user.name=board", "-c", "user.email=board@stellaris.local", ...args],
    { cwd },
  );
  return result.stdout;
}

function core(home: string): string {
  return path.join(home, "memory", "core.md");
}

async function edit(home: string, from: string, to: string): Promise<void> {
  const text = await readFile(core(home), "utf8");
  await writeFile(core(home), text.replace(from, to), "utf8");
}

describe("HomeSync", () => {
  let dir: string;
  let server: string;
  let a: HomeSync;
  let b: HomeSync;
  let layoutA: RunnerLayout;
  let layoutB: RunnerLayout;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-home-"));
    // The board's copy of desk's home: a working tree that takes pushes, as the board sets it up.
    server = path.join(dir, "server", "desk");
    await mkdir(path.join(server, "memory"), { recursive: true });
    await git(server, "init", "--quiet", "--initial-branch=main");
    await writeFile(path.join(server, ".gitignore"), "/agent.json\n/turns/\n", "utf8");
    await writeFile(path.join(server, "memory", "core.md"), LINES.join("\n"), "utf8");
    await git(server, "add", "--all");
    await git(server, "commit", "--quiet", "-m", "home: created by the board");
    await git(server, "config", "receive.denyCurrentBranch", "updateInstead");
    const remote = { url: () => server, authorization: null };
    layoutA = new RunnerLayout(path.join(dir, "a"));
    layoutB = new RunnerLayout(path.join(dir, "b"));
    a = new HomeSync(layoutA, remote);
    b = new HomeSync(layoutB, remote);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("clones a home on its first turn and pushes what the turn left into the board's copy", async () => {
    await a.prepare("desk");
    const home = layoutA.agent("desk");
    expect(await readFile(core(home), "utf8")).toBe(LINES.join("\n"));
    await edit(home, "- one", "- one, learned");
    await mkdir(path.join(home, "skills", "triage"), { recursive: true });
    await writeFile(path.join(home, "skills", "triage", "SKILL.md"), "# Triage\n", "utf8");
    // What a runner renders or the board keeps never travels.
    await writeFile(path.join(home, "agent.json"), "{}", "utf8");

    expect(await a.publish("desk", TURN_A)).toEqual([]);
    expect(await readFile(core(server), "utf8")).toContain("- one, learned");
    expect(await readFile(path.join(server, "skills", "triage", "SKILL.md"), "utf8")).toBe(
      "# Triage\n",
    );
    expect(await git(server, "log", "-1", "--format=%an %s")).toBe(`desk turn ${TURN_A}`);
    expect(await git(server, "ls-files")).not.toContain("agent.json");
    // A turn that changed nothing commits nothing.
    expect(await a.publish("desk", TURN_B)).toEqual([]);
    expect(await git(server, "rev-list", "--count", "HEAD")).toBe("2");
  });

  it("merges two runners' edits to different lines, and keeps both versions of the same line", async () => {
    await a.prepare("desk");
    await b.prepare("desk");
    const homeA = layoutA.agent("desk");
    const homeB = layoutB.agent("desk");

    await edit(homeA, "- one", "- one from a");
    await edit(homeB, "- five", "- five from b");
    expect(await a.publish("desk", TURN_A)).toEqual([]);
    expect(await b.publish("desk", TURN_B)).toEqual([]);
    const merged = await readFile(core(server), "utf8");
    expect(merged).toContain("- one from a");
    expect(merged).toContain("- five from b");

    await a.prepare("desk");
    await b.prepare("desk");
    await edit(homeA, "- three", "- three as a sees it");
    await edit(homeB, "- three", "- three as b sees it");
    expect(await a.publish("desk", TURN_A)).toEqual([]);
    expect(await b.publish("desk", TURN_B)).toEqual(["memory/core.md"]);
    // The board's copy keeps what it had; the later turn's version waits beside it.
    expect(await readFile(core(server), "utf8")).toContain("- three as a sees it");
    const kept = path.join(server, "memory", `core.md.conflict-${TURN_B.slice(-8)}`);
    expect(await readFile(kept, "utf8")).toContain("- three as b sees it");
    // Both runners end where the board is.
    await a.prepare("desk");
    expect(await readFile(core(homeA), "utf8")).toBe(await readFile(core(server), "utf8"));
  });

  it("leaves a copy alone while another turn of the agent is still writing in it", async () => {
    await a.prepare("desk");
    await b.prepare("desk");
    const homeA = layoutA.agent("desk");
    await edit(layoutB.agent("desk"), "- two", "- two from b");
    await b.publish("desk", TURN_B);

    await edit(homeA, "- four", "- four, half written");
    await a.prepare("desk");
    const text = await readFile(core(homeA), "utf8");
    expect(text).toContain("- four, half written");
    expect(text).not.toContain("- two from b");
    // The turn's own push takes both.
    await a.publish("desk", TURN_A);
    const board = await readFile(core(server), "utf8");
    expect(board).toContain("- two from b");
    expect(board).toContain("- four, half written");
  });
});
