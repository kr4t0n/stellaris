import { RoleCharterSchema, type Member, type Proposal } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import {
  consequenceOf,
  decidersOf,
  groupProposals,
  proposalTitle,
  roleDiff,
  skillText,
  waitingOnYou,
} from "./governance.js";

function proposal(overrides: Partial<Proposal> & Pick<Proposal, "id" | "kind">): Proposal {
  return {
    proposedBy: "stew",
    status: "proposed",
    createdAt: "2026-09-29T10:00:00.000Z",
    charter: {},
    body: "",
    ...overrides,
  };
}

const skill = proposal({
  id: "01M3PY56V68VFS0EG5ER4B9AMD",
  kind: "skill",
  charter: { name: "refereed-research", summary: "Plan research.", body: "# Refereed" },
});

const researcher = RoleCharterSchema.parse({
  name: "researcher",
  purpose: "Runs experiments.",
  verbs: ["post_message", "claim_task", "write_knowledge"],
});

describe("governance", () => {
  it("puts what the user may decide first, then what others decide, then the decided", () => {
    const own = proposal({ id: "01M3PY56V68VFS0EG5ER4B9AME", kind: "channel", proposedBy: "user" });
    const older = proposal({
      id: "01M3PY56V68VFS0EG5ER4B9AMF",
      kind: "member",
      createdAt: "2026-09-29T09:00:00.000Z",
    });
    const decided = proposal({
      id: "01M3PY56V68VFS0EG5ER4B9AMG",
      kind: "role",
      status: "provisioned",
      decidedAt: "2026-09-29T11:00:00.000Z",
    });
    expect(proposalTitle(skill)).toBe("Skill refereed-research: Plan research");
    expect(waitingOnYou(skill)).toBe(true);
    expect(waitingOnYou(own)).toBe(false);
    expect(waitingOnYou(decided)).toBe(false);
    expect(
      groupProposals([decided, skill, own, older]).map((group) => [
        group.group,
        group.proposals.map((each) => each.id),
      ]),
    ).toEqual([
      ["yours", [older.id, skill.id]],
      ["others", [own.id]],
      ["decided", [decided.id]],
    ]);
  });

  it("names who may decide, leaving out the proposer", () => {
    expect(decidersOf(skill, "steward")).toBe("you or another steward");
    expect(decidersOf(skill, "concierge")).toBe("you or the steward");
    expect(decidersOf(proposal({ id: skill.id, kind: "member" }), "concierge")).toBe("you");
    expect(decidersOf(proposal({ id: skill.id, kind: "role", proposedBy: "user" }), "user")).toBe(
      "nobody",
    );
  });

  it("shows what a role proposal adds and removes, defaults included", () => {
    const next = RoleCharterSchema.parse({
      ...researcher,
      verbs: ["post_message", "claim_task", "plan_task"],
      maxReplicas: 2,
    });
    expect(roleDiff(researcher, next)).toEqual({
      verbsAdded: ["plan_task"],
      verbsRemoved: ["write_knowledge"],
      purposeChanged: false,
      changes: [{ field: "replicas per project", from: "1", to: "2" }],
    });
  });

  it("says what approval does against the board as it is", () => {
    const board = { members: [] as Member[], roles: [researcher], skills: [] };
    expect(consequenceOf(skill, board)).toBe(
      "Publishes refereed-research to the society's skills, which every citizen's instructions list.",
    );
    expect(
      consequenceOf(skill, {
        ...board,
        skills: [{ name: "refereed-research", summary: "", scope: "society", path: "/x" }],
      }),
    ).toBe("Replaces the society's refereed-research skill with this text.");
    const hire = proposal({
      id: skill.id,
      kind: "member",
      charter: { name: "eng-2", role: "engineer", cli: "codex", memberships: ["api"] },
    });
    expect(consequenceOf(hire, board)).toBe(
      "Creates the citizen eng-2 (engineer, codex) in api and starts its first turn.",
    );
    const rewrite = proposal({ id: skill.id, kind: "role", charter: { ...researcher } });
    expect(consequenceOf(rewrite, board)).toBe(
      "Rewrites the researcher charter; no active member holds the role.",
    );
    expect(consequenceOf(proposal({ id: skill.id, kind: "member", charter: {} }), board)).toMatch(
      /does not parse/,
    );
  });

  it("drops a skill's frontmatter before rendering it", () => {
    expect(skillText("---\nname: a\ndescription: b\n---\n\n# Refereed\n\nUse it.")).toBe(
      "# Refereed\n\nUse it.",
    );
    expect(skillText("# No frontmatter")).toBe("# No frontmatter");
  });
});
