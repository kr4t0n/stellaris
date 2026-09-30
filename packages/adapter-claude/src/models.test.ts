import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ClaudeAgentBackend, modelOptions, type QueryFn } from "./index.js";

const LISTED: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5",
  },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", description: "" },
  { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "pinned" },
];

describe("Claude models", () => {
  it("drops the CLI's default entry and marks the first model it resolves to", () => {
    expect(modelOptions(LISTED)).toEqual([
      { id: "opus", name: "Opus 5.5", description: "", isDefault: true },
      { id: "sonnet", name: "Sonnet 5", description: "", isDefault: false },
      { id: "claude-opus-5-5", name: "Opus 5.5", description: "pinned", isDefault: false },
    ]);
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
