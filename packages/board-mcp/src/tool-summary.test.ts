import type { Actor, Board } from "@stellaris/board-core";
import { SEED_ROLES, VERB_NAMES, VerbInputs, type RoleCharter } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "./index.js";

/**
 * Antigravity's `agy` adds a required `toolSummary` string to every tool's schema the model sees,
 * the model's one-line summary of the call, and 1.5.15 drops it before calling the tool. These say
 * what the board does with one that arrives anyway: the MCP SDK parses the arguments with the
 * verb's schema, which strips a key it doesn't name, so the verb never sees it, and the call runs.
 */
describe("a tool call carrying agy's toolSummary", () => {
  it("reaches the verb without it, and the call succeeds", async () => {
    const user = SEED_ROLES.find((role) => role.name === "user");
    if (user === undefined) {
      throw new Error("seed roles missing");
    }
    const invoked: unknown[] = [];
    const board = {
      readRole: (): Promise<RoleCharter> => Promise.resolve(user),
      invoke: (_actor: Actor, verb: string, input: unknown): Promise<unknown> => {
        invoked.push([verb, input]);
        return Promise.resolve({ ok: true });
      },
    };
    const response = await handleMcpRequest(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      board as unknown as Board,
      { name: "user", role: "user" },
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "post_message",
            arguments: { channel: "general", body: "hello", toolSummary: "Post a hello" },
          },
        }),
      }),
      "0.0.0",
    );
    const answer: unknown = await response.json();
    expect(answer).toMatchObject({ id: 1, result: { content: [{ type: "text" }] } });
    expect(answer).not.toHaveProperty("result.isError");
    expect(invoked).toEqual([["post_message", { channel: "general", body: "hello" }]]);
  });

  it("is stripped by every verb's schema, which names no such field", () => {
    for (const verb of VERB_NAMES) {
      const shape = VerbInputs[verb].shape;
      expect(Object.keys(shape)).not.toContain("toolSummary");
    }
    expect(VerbInputs.post_message.parse({ body: "hello", toolSummary: "x" })).toEqual({
      body: "hello",
    });
  });
});
