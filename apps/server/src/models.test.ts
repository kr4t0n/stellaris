import type { CliKind, ModelOption } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { ModelCatalog, type ModelRunners } from "./models.js";

const OPUS: ModelOption = {
  id: "opus",
  name: "Opus",
  description: "",
  isDefault: true,
  efforts: [],
};

/** Runners a and b, each listing what `lists` says, and asked in the order a test records. */
function fakeRunners(lists: (runner: string, cli: CliKind) => Promise<ModelOption[]>) {
  const asked: string[] = [];
  const connected = new Set(["a", "b"]);
  const listeners: Array<(runner: string) => void> = [];
  const runners: ModelRunners = {
    modelRunner: (_cli, prefer = []) =>
      prefer.find((name) => connected.has(name)) ?? [...connected].toSorted()[0] ?? null,
    models: (cli, runner) => {
      asked.push(`${runner}/${cli}`);
      return lists(runner, cli);
    },
    onRunnerChange: (listener) => listeners.push(listener),
  };
  const change = (runner: string, up: boolean): void => {
    if (up) {
      connected.add(runner);
    } else {
      connected.delete(runner);
    }
    for (const listener of listeners) {
      listener(runner);
    }
  };
  return { runners, asked, change };
}

describe("ModelCatalog", () => {
  it("asks each runner once per hour, shares a request in flight, and retries after a failure", async () => {
    let clock = 0;
    let failing = true;
    const { runners, asked } = fakeRunners((_runner, cli) =>
      cli === "codex"
        ? Promise.resolve([])
        : failing
          ? Promise.reject(new Error("CLI not logged in"))
          : Promise.resolve([OPUS]),
    );
    const catalog = new ModelCatalog(runners, 1_000, () => clock);

    await expect(catalog.list("claude")).rejects.toThrow("CLI not logged in");
    failing = false;
    const [first, second] = await Promise.all([catalog.list("claude"), catalog.list("claude")]);
    expect(first).toEqual({ runner: "a", cli: "claude", models: [OPUS] });
    expect(second.models).toBe(first.models);
    expect(asked).toEqual(["a/claude", "a/claude"]);

    clock = 999;
    await catalog.list("claude");
    expect(asked).toHaveLength(2);
    clock = 1_000;
    await catalog.list("claude");
    expect(asked).toHaveLength(3);
    expect((await catalog.list("codex")).models).toEqual([]);
  });

  it("lists from the runner a citizen prefers, and forgets a runner's lists when it comes or goes", async () => {
    const version: Record<string, number> = { a: 1, b: 1 };
    const { runners, asked, change } = fakeRunners((runner) =>
      Promise.resolve([{ ...OPUS, description: `${runner} v${version[runner]}` }]),
    );
    const catalog = new ModelCatalog(runners);

    expect((await catalog.list("claude", ["b"])).models[0]?.description).toBe("b v1");
    expect((await catalog.list("claude")).models[0]?.description).toBe("a v1");
    await catalog.list("claude", ["b"]);
    expect(asked).toEqual(["b/claude", "a/claude"]);

    // An upgrade reconnects the runner, and its next list is asked afresh; a's is kept.
    version["b"] = 2;
    change("b", true);
    expect((await catalog.list("claude", ["b"])).models[0]?.description).toBe("b v2");
    await catalog.list("claude");
    expect(asked).toEqual(["b/claude", "a/claude", "b/claude"]);

    // A preferred runner away falls back to any other; none at all is the runner's absence.
    change("b", false);
    expect((await catalog.list("claude", ["b"])).runner).toBe("a");
    change("a", false);
    await expect(catalog.list("claude")).rejects.toThrow("no connected runner has claude");
  });
});
