import { AGENT_TOKEN_ENV } from "@stellaris/shared";

export interface ClaudeMcpConfig {
  readonly mcpServers: {
    readonly board: {
      readonly type: "http";
      readonly url: string;
      readonly headers: { readonly Authorization: string };
    };
  };
}

/** Claude Code's on-disk MCP config. The token is referenced by environment variable, never written into the file. */
export function renderClaudeMcpConfig(endpointUrl: string): ClaudeMcpConfig {
  return {
    mcpServers: {
      board: {
        type: "http",
        url: endpointUrl,
        headers: { Authorization: `Bearer \${${AGENT_TOKEN_ENV}}` },
      },
    },
  };
}

/** The Codex config.toml fragment registering the board as a streamable HTTP MCP server. */
export function renderCodexMcpConfig(endpointUrl: string): string {
  return [
    "[mcp_servers.board]",
    `url = ${JSON.stringify(endpointUrl)}`,
    `bearer_token_env_var = "${AGENT_TOKEN_ENV}"`,
    "",
  ].join("\n");
}
