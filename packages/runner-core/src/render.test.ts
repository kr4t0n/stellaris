import { describe, expect, it } from "vitest";
import { renderClaudeMcpConfig, renderCodexMcpConfig, renderInstructions } from "./index.js";

describe("config-home rendering", () => {
  it("renders instructions from role and memory, with the onboarding preamble only when asked", () => {
    const base = renderInstructions({
      agentName: "eng-1",
      roleCharter: "# engineer\n\nBuilds things.",
      memoryCore: "",
    });
    expect(base).toContain("## Role");
    expect(base).toContain("(empty)");
    expect(base).not.toContain("## First turn");

    const first = renderInstructions({
      agentName: "eng-1",
      roleCharter: "# engineer",
      memoryCore: "- The owner prefers small pull requests.",
      onboarding: {
        agentName: "eng-1",
        roleSummary: "Builds things.",
        project: "demo",
        worktree: "/tmp/wt",
      },
    });
    expect(first).toContain("## First turn");
    expect(first).toContain("small pull requests");
  });

  it("references the token by environment variable in both CLI configs", () => {
    const claude = renderClaudeMcpConfig("http://127.0.0.1:4700/mcp");
    expect(claude.mcpServers.board.headers.Authorization).toBe("Bearer ${STELLARIS_AGENT_TOKEN}");
    const codex = renderCodexMcpConfig("http://127.0.0.1:4700/mcp");
    expect(codex).toContain('bearer_token_env_var = "STELLARIS_AGENT_TOKEN"');
    expect(codex).not.toContain("stl_");
  });
});
