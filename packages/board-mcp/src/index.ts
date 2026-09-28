import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isBoardError, type Actor, type Board } from "@stellaris/board-core";
import {
  VERB_DESCRIPTIONS,
  VERB_NAMES,
  VerbInputs,
  type RoleCharter,
  type VerbName,
} from "@stellaris/shared";
import type { z } from "zod";

/** One MCP tool per board verb. The schema is the shared verb input; the description is the shared text. */
export interface BoardToolDefinition {
  readonly name: VerbName;
  readonly description: string;
  readonly inputSchema: z.ZodType;
}

export const BOARD_TOOLS: readonly BoardToolDefinition[] = VERB_NAMES.map((name) => ({
  name,
  description: VERB_DESCRIPTIONS[name],
  inputSchema: VerbInputs[name],
}));

/** The tools a role may see. The owner sees everything; everyone else sees exactly their charter's verbs. */
export function toolsForRole(charter: RoleCharter): readonly BoardToolDefinition[] {
  if (charter.name === "owner") {
    return BOARD_TOOLS;
  }
  const granted = new Set<VerbName>(charter.verbs);
  return BOARD_TOOLS.filter((tool) => granted.has(tool.name));
}

function describeError(error: unknown): string {
  if (isBoardError(error)) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** An MCP server bound to one actor. Every tool call goes through the board's verb dispatch. */
export async function createBoardMcpServer(
  board: Board,
  actor: Actor,
  version: string,
): Promise<McpServer> {
  const server = new McpServer({ name: "stellaris-board", version });
  const charter = await board.readRole(actor.role);
  for (const tool of toolsForRole(charter)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: unknown) => {
        try {
          const result = await board.invoke(actor, tool.name, args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result ?? null, null, 2) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: describeError(error) }],
          };
        }
      },
    );
  }
  return server;
}

/**
 * Handles one Streamable HTTP request for an already-authenticated actor. Stateless by design:
 * a server and transport are created per request, so the tool list is always the actor's role.
 */
export async function handleMcpRequest(
  board: Board,
  actor: Actor,
  request: Request,
  version: string,
): Promise<Response> {
  const server = await createBoardMcpServer(board, actor, version);
  // No sessionIdGenerator means stateless mode: every request stands alone.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, {
      authInfo: { token: "", clientId: actor.name, scopes: [actor.role], extra: { actor } },
    });
  } finally {
    await server.close().catch(() => undefined);
  }
}
