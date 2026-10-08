import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeEffort, ClaudeAgentBackend, modelOptions, type QueryFn } from "./index.js";

const LISTED: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5",
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus 5.5",
    description: "",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet 5",
    description: "",
    supportsEffort: false,
    supportedEffortLevels: ["low"],
  },
  { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "pinned" },
];

describe("Claude models", () => {
  it("drops the CLI's default entry and marks the first model it resolves to", () => {
    expect(modelOptions(LISTED)).toEqual([
      expect.objectContaining({ id: "opus", name: "Opus 5.5", description: "", isDefault: true }),
      expect.objectContaining({ id: "sonnet", name: "Sonnet 5", isDefault: false }),
      expect.objectContaining({ id: "claude-opus-5-5", description: "pinned", isDefault: false }),
    ]);
  });

  it("lists each model's effort levels, with high as the one it runs unset", () => {
    const [opus, sonnet, pinned] = modelOptions(LISTED);
    expect(opus?.efforts.map((effort) => effort.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(opus?.efforts[0]).toEqual({
      id: "low",
      description: "Minimal thinking, fastest responses",
    });
    expect(opus?.defaultEffort).toBe("high");
    // A model that says it takes no effort has none to choose, whatever else it lists.
    expect(sonnet?.efforts).toEqual([]);
    expect(sonnet).not.toHaveProperty("defaultEffort");
    expect(pinned?.efforts).toEqual([]);
  });

  it("takes only the effort levels Claude Code knows", () => {
    expect(claudeEffort("xhigh")).toBe("xhigh");
    expect(claudeEffort("minimal")).toBeUndefined();
    expect(claudeEffort(undefined)).toBeUndefined();
  });

  it("asks a query that takes no turn, and closes it", async () => {
    let closed = false;
    let sent = false;
    const queryFn: QueryFn = ({ prompt }) => {
      if (typeof prompt !== "string") {
        void (async () => {
          await prompt[Symbol.asyncIterator]().next();
          sent = true;
        })();
      }
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true as const, value: undefined }),
        }),
        supportedModels: () => Promise.resolve(LISTED),
        close: () => {
          closed = true;
        },
      };
    };
    const models = await new ClaudeAgentBackend({ queryFn }).listModels();
    expect(models.map((model) => model.id)).toEqual(["opus", "sonnet", "claude-opus-5-5"]);
    expect(closed).toBe(true);
    expect(sent).toBe(false);
  });
});
