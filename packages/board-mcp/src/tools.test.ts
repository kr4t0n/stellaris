import { SEED_ROLES } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { BOARD_TOOLS, toolsForRole } from "./index.js";

describe("board tools", () => {
  it("defines one tool per verb with a description", () => {
    expect(BOARD_TOOLS).toHaveLength(15);
    for (const tool of BOARD_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("hides governance tools from engineers and shows them to the owner", () => {
    const engineer = SEED_ROLES.find((role) => role.name === "engineer");
    const owner = SEED_ROLES.find((role) => role.name === "owner");
    if (engineer === undefined || owner === undefined) {
      throw new Error("seed roles missing");
    }
    const engineerTools = toolsForRole(engineer).map((tool) => tool.name);
    expect(engineerTools).not.toContain("approve");
    expect(engineerTools).toContain("claim_task");
    expect(toolsForRole(owner).map((tool) => tool.name)).toContain("approve");
  });
});
