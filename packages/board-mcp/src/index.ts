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

// The Streamable HTTP handler that mounts these tools in the board server arrives in Phase 1.
