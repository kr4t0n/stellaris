import { describe, expect, it } from "vitest";
import { renderClaudeMcpConfig, renderCodexMcpConfig } from "./config-home.js";

describe("config-home rendering", () => {
  it("references the token by environment variable in both CLI configs", () => {
    const claude = renderClaudeMcpConfig("http://127.0.0.1:4700/mcp");
    expect(claude.mcpServers.board.headers.Authorization).toBe("Bearer ${STELLARIS_AGENT_TOKEN}");
    const codex = renderCodexMcpConfig("http://127.0.0.1:4700/mcp");
    expect(codex).toContain('bearer_token_env_var = "STELLARIS_AGENT_TOKEN"');
    expect(codex).not.toContain("stl_");
  });
});
