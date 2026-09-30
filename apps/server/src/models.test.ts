import type { AgentBackend } from "@stellaris/runner-core";
import type { ModelOption } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { ModelCatalog } from "./models.js";

function backend(listings: Array<() => Promise<ModelOption[]>>): AgentBackend & { asked: number } {
  const counted = {
    kind: "claude" as const,
    asked: 0,
    newSession: () => Promise.resolve("s"),
    runTurn: () => Promise.reject(new Error("no turns here")),
    listModels: () => {
      const next = listings[counted.asked] ?? listings.at(-1);
      counted.asked += 1;
      return next === undefined ? Promise.resolve([]) : next();
    },
  };
  return counted;
}

const OPUS: ModelOption = { id: "opus", name: "Opus", description: "", isDefault: true };

describe("ModelCatalog", () => {
  it("asks each CLI once per hour, shares a request in flight, and retries after a failure", async () => {
    let clock = 0;
    const claude = backend([
      () => Promise.reject(new Error("CLI not logged in")),
      () => Promise.resolve([OPUS]),
    ]);
    const catalog = new ModelCatalog({ claude }, 1_000, () => clock);

    await expect(catalog.list("claude")).rejects.toThrow("CLI not logged in");
    const [first, second] = await Promise.all([catalog.list("claude"), catalog.list("claude")]);
    expect(first).toEqual([OPUS]);
    expect(second).toBe(first);
    expect(claude.asked).toBe(2);

    clock = 999;
    await catalog.list("claude");
    expect(claude.asked).toBe(2);
    clock = 1_000;
    await catalog.list("claude");
    expect(claude.asked).toBe(3);
    expect(await catalog.list("codex")).toEqual([]);
  });
});
