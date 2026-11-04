import { MEMBER_VERBS, RoleCharterSchema, SEED_ROLES } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BOARD_TOOLS, toolsForRole } from "./index.js";

describe("board tools", () => {
  it("defines one tool per verb with a description", () => {
    expect(BOARD_TOOLS).toHaveLength(33);
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

  it("shows read_image to every member, taking an image's id or its image: address", () => {
    const engineer = RoleCharterSchema.parse({
      name: "engineer",
      purpose: "Builds.",
      verbs: MEMBER_VERBS,
    });
    for (const role of [...SEED_ROLES, engineer]) {
      expect(toolsForRole(role).map((tool) => tool.name)).toContain("read_image");
    }
    const tool = BOARD_TOOLS.find((each) => each.name === "read_image");
    expect(tool?.description).toContain("Open the path with your file tools to see the image.");
    // The schema the tool list shows a CLI says both forms, since it holds no transform.
    expect(z.toJSONSchema(tool?.inputSchema ?? z.never())).toMatchObject({
      properties: {
        image_id: { type: "string", pattern: "^(?:image:)?[0-9A-HJKMNP-TV-Z]{26}$" },
      },
      required: ["image_id"],
    });
  });

  it("shows remove_skill to the steward and the user alone", () => {
    const holders = SEED_ROLES.filter((role) =>
      toolsForRole(role).some((tool) => tool.name === "remove_skill"),
    ).map((role) => role.name);
    expect(holders).toEqual(["user", "steward"]);
  });
});
