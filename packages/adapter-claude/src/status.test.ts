import { describe, expect, it } from "vitest";
import { parseTurnStatus, subprocessEnv } from "./index.js";

describe("parseTurnStatus", () => {
  it("prefers structured output and falls back to a fenced JSON block", () => {
    const structured = parseTurnStatus({ summary: "did the thing", claimsHeld: [] }, "");
    expect(structured?.summary).toBe("did the thing");
    expect(structured?.needsOwnerDecision).toBe(false);

    const fenced = parseTurnStatus(
      null,
      'Done.\n```json\n{"summary":"from text","needsOwnerDecision":true}\n```\n',
    );
    expect(fenced?.summary).toBe("from text");
    expect(fenced?.needsOwnerDecision).toBe(true);

    expect(parseTurnStatus(null, "no json here")).toBeNull();
  });
});

describe("subprocessEnv", () => {
  it("drops nested-session markers and adds the board token", () => {
    const env = subprocessEnv(
      { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", HOME: "/home/u" },
      { GIT_AUTHOR_NAME: "eng-1" },
      "stl_token",
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/u",
      GIT_AUTHOR_NAME: "eng-1",
      STELLARIS_AGENT_TOKEN: "stl_token",
    });
  });
});
