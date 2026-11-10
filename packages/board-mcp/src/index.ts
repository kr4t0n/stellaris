import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isBoardError, type Actor, type Board } from "@stellaris/board-core";
import {
  VERB_NAMES,
  VerbInputs,
  verbDescriptions,
  type RoleCharter,
  type VerbName,
  type VerbTimings,
} from "@stellaris/shared";
import type { z } from "zod";

/**
 * The most array elements and object members, at any depth, that one tool call's arguments may
 * hold. Without a cap the SDK validates whatever a request carries, and a few megabytes of tiny
 * elements can exhaust the server's memory (GHSA-46jr-4wx8-v453). The largest call measured on a
 * running board held 53, a ten-stage `plan_task`; 1,000 leaves room for a plan of 199 stages. A
 * call over it gets an error result, and its verb never runs.
 */
const MAX_TOOL_INPUT_ELEMENTS = 1_000;

/**
 * The largest request body `/mcp` reads, in bytes, a quarter of the SDK's 4 MiB default
 * (GHSA-46jr-4wx8-v453). The largest call measured on a running board was 60,067 bytes, a
 * knowledge topic; 1 MiB leaves 17 times that. A larger body is answered 413 before it is parsed.
 */
const MAX_REQUEST_BODY_SIZE = 1024 * 1024;

/** One MCP tool per board verb. The schema is the shared verb input; the description is the shared text. */
export interface BoardToolDefinition {
  readonly name: VerbName;
  readonly description: string;
  readonly inputSchema: z.ZodType;
}

/** Every verb's tool, its description at the timings the server runs with (`verbDescriptions`). */
export function boardTools(timings: VerbTimings = {}): readonly BoardToolDefinition[] {
  const descriptions = verbDescriptions(timings);
  return VERB_NAMES.map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: VerbInputs[name],
  }));
}

/** Every verb's tool at the default timings. */
export const BOARD_TOOLS: readonly BoardToolDefinition[] = boardTools();

/** The tools a role may see. The user sees everything; everyone else sees exactly their charter's verbs. */
export function toolsForRole(
  charter: RoleCharter,
  tools: readonly BoardToolDefinition[] = BOARD_TOOLS,
): readonly BoardToolDefinition[] {
  if (charter.name === "user") {
    return tools;
  }
  const granted = new Set<VerbName>(charter.verbs);
  return tools.filter((tool) => granted.has(tool.name));
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
  timings: VerbTimings = {},
): Promise<McpServer> {
  const server = new McpServer(
    { name: "stellaris-board", version },
    { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
  );
  const charter = await board.readRole(actor.role);
  for (const tool of toolsForRole(charter, boardTools(timings))) {
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
 * `timings` are the scheduler's, which some tools' descriptions name.
 */
export async function handleMcpRequest(
  board: Board,
  actor: Actor,
  request: Request,
  version: string,
  timings: VerbTimings = {},
): Promise<Response> {
  const server = await createBoardMcpServer(board, actor, version, timings);
  // No sessionIdGenerator means stateless mode: every request stands alone.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, {
      authInfo: { token: "", clientId: actor.name, scopes: [actor.role], extra: { actor } },
    });
  } finally {
    await server.close().catch(() => undefined);
  }
}
