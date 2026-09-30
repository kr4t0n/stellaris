import { SEED_ROLES } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { BOARD_TOOLS, toolsForRole } from "./index.js";

describe("board tools", () => {
  it("defines one tool per verb with a description", () => {
    expect(BOARD_TOOLS).toHaveLength(23);
    for (const tool of BOARD_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("hides governance tools from the concierge and shows them to the user", () => {
    const concierge = SEED_ROLES.find((role) => role.name === "concierge");
    const user = SEED_ROLES.find((role) => role.name === "user");
    if (concierge === undefined || user === undefined) {
      throw new Error("seed roles missing");
    }
    const conciergeTools = toolsForRole(concierge).map((tool) => tool.name);
    expect(conciergeTools).not.toContain("approve");
    // Archiving is the user's alone for now; the concierge proposes it instead.
    expect(conciergeTools).not.toContain("archive_project");
    expect(conciergeTools).toEqual(expect.arrayContaining(["plan_task", "configure_project"]));
    expect(toolsForRole(user).map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["approve", "archive_project"]),
    );
  });
});
