import { describe, expect, it } from "vitest";
import { renderInstructions } from "./render.js";

const places = { homeDir: "/data/agents/eng-1", boardDir: "/data/board" };

describe("config-home rendering", () => {
  it("renders instructions from role and memory, with the onboarding preamble only when asked", () => {
    const base = renderInstructions({
      agentName: "eng-1",
      roleCharter: "# engineer\n\nBuilds things.",
      memoryCore: "",
      ...places,
    });
    expect(base).toContain("## Role");
    expect(base).toContain("(empty)");
    expect(base).toContain("/data/agents/eng-1");
    expect(base).toContain("/data/board");
    expect(base).toContain("## Governance");
    expect(base).toContain('retirement: {"agent", "reason"}');
    expect(base).not.toContain("## First turn");

    const first = renderInstructions({
      agentName: "eng-1",
      roleCharter: "# engineer",
      memoryCore: "- The user prefers small pull requests.",
      ...places,
      onboarding: {
        agentName: "eng-1",
        roleSummary: "Builds things.",
        project: "demo",
        worktree: "/tmp/wt",
      },
    });
    expect(first).toContain("## First turn");
    expect(first).toContain("small pull requests");
    expect(first).not.toContain("You follow its general channel");

    // A newcomer is told of the project's channels it does not follow yet.
    const joined = renderInstructions({
      agentName: "eng-1",
      roleCharter: "# engineer",
      memoryCore: "",
      ...places,
      onboarding: {
        agentName: "eng-1",
        roleSummary: "Builds things.",
        project: "demo",
        worktree: "/tmp/wt",
        otherChannels: ["demo/release-1"],
      },
    });
    expect(joined).toContain(
      "You follow its general channel. It also has #demo/release-1, each a workstream such as a release",
    );
  });

  it("loads the norms in full and the skills as an index of summaries and paths", () => {
    const bare = renderInstructions({
      agentName: "eng-1",
      roleCharter: "# engineer",
      memoryCore: "",
      ...places,
      norms: "",
      skills: [],
    });
    expect(bare).not.toContain("## Society norms");
    expect(bare).toContain("## Skills\n\nNone yet.");

    const full = renderInstructions({
      agentName: "eng-1",
      roleCharter: "# engineer",
      memoryCore: "",
      ...places,
      norms: "- Summaries close threads.",
      skills: [
        {
          name: "uv-setup",
          summary: "Set up a uv project.",
          scope: "own",
          path: "/data/agents/eng-1/skills/uv-setup/SKILL.md",
        },
        {
          name: "release",
          summary: "",
          scope: "society",
          path: "/data/board/society/skills/release/SKILL.md",
        },
      ],
    });
    const norms = full.indexOf("## Society norms");
    expect(norms).toBeGreaterThan(full.indexOf("## Role"));
    expect(norms).toBeLessThan(full.indexOf("## Core memory"));
    expect(full).toContain("- Summaries close threads.");
    expect(full).toContain(
      "- uv-setup (yours): Set up a uv project. File: /data/agents/eng-1/skills/uv-setup/SKILL.md",
    );
    expect(full).toContain(
      "- release (society): no summary. File: /data/board/society/skills/release/SKILL.md",
    );
    expect(full).toContain('skill: {"name", "summary", "body"}');
    // Turns of one citizen may share its home at once, so memory is edited, never rewritten.
    expect(full).toContain("never rewrite one whole from an earlier read");
    expect(full).toContain("write_knowledge");
  });
});
