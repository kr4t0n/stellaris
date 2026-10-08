import type { CliKind, ModelOption } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { ModelCatalog } from "./models.js";

const OPUS: ModelOption = {
  id: "opus",
  name: "Opus",
  description: "",
  isDefault: true,
  efforts: [],
};

describe("ModelCatalog", () => {
  it("asks each CLI once per hour, shares a request in flight, and retries after a failure", async () => {
    let clock = 0;
    const asked: CliKind[] = [];
    const listings = [
      () => Promise.reject(new Error("CLI not logged in")),
      () => Promise.resolve([OPUS]),
    ];
    const catalog = new ModelCatalog(
      (cli) => {
        asked.push(cli);
        if (cli === "codex") {
          return Promise.resolve([]);
        }
        const next = listings[asked.filter((each) => each === "claude").length - 1] ?? listings[1];
        return next === undefined ? Promise.resolve([]) : next();
      },
      1_000,
      () => clock,
    );

    await expect(catalog.list("claude")).rejects.toThrow("CLI not logged in");
    const [first, second] = await Promise.all([catalog.list("claude"), catalog.list("claude")]);
    expect(first).toEqual([OPUS]);
    expect(second).toBe(first);
    expect(asked).toEqual(["claude", "claude"]);

    clock = 999;
    await catalog.list("claude");
    expect(asked).toHaveLength(2);
    clock = 1_000;
    await catalog.list("claude");
    expect(asked).toHaveLength(3);
    expect(await catalog.list("codex")).toEqual([]);
  });
});
