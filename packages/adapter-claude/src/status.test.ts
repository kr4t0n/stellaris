import { describe, expect, it } from "vitest";
import { subprocessEnv } from "./index.js";

describe("subprocessEnv", () => {
  it("drops nested-session markers and adds husky's off switch and the board token", () => {
    const env = subprocessEnv(
      { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", HOME: "/home/u", HUSKY: "1" },
      { NO_COLOR: "1" },
      "stl_token",
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/u",
      NO_COLOR: "1",
      HUSKY: "0",
      STELLARIS_AGENT_TOKEN: "stl_token",
    });
  });
});
