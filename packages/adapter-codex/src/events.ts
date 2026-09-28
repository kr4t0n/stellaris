import type { AgentEvent, Usage } from "@stellaris/shared";

/**
 * The `codex exec --json` stream: one JSON object per line. Thread and turn events frame the
 * run; items carry what the agent did. Field names are snake_case; unknown items are ignored.
 */
export interface ParsedExecLine {
  readonly events: readonly AgentEvent[];
  readonly threadId?: string | undefined;
  readonly usage?: Usage | undefined;
  readonly agentMessage?: string | undefined;
  readonly error?: string | undefined;
  readonly turnCompleted?: boolean | undefined;
  readonly turnFailed?: boolean | undefined;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageOf(raw: unknown): Usage {
  const u = isDict(raw) ? raw : {};
  return {
    inputTokens: num(u["input_tokens"]),
    outputTokens: num(u["output_tokens"]),
    cacheReadTokens: num(u["cached_input_tokens"]),
    cacheWriteTokens: num(u["cache_write_input_tokens"]),
  };
}

/** Tool name for an item, in the same vocabulary the Claude adapter uses so the UI can treat them alike. */
function toolNameOf(item: Dict): string | null {
  switch (item["type"]) {
    case "command_execution":
      return "Bash";
    case "file_change":
      return "Edit";
    case "web_search":
      return "WebSearch";
    case "mcp_tool_call": {
      const server = str(item["server"]) ?? "mcp";
      const tool = str(item["tool"]) ?? "tool";
      return `mcp__${server}__${tool}`;
    }
    default:
      return null;
  }
}

function toolInputOf(item: Dict): unknown {
  switch (item["type"]) {
    case "command_execution":
      return { command: item["command"] };
    case "file_change":
      return { changes: item["changes"] };
    case "web_search":
      return { query: item["query"] };
    case "mcp_tool_call":
      return item["arguments"];
    default:
      return undefined;
  }
}

function toolOk(item: Dict): boolean {
  if (item["status"] === "failed") {
    return false;
  }
  if (item["type"] === "command_execution") {
    const code = item["exit_code"];
    return typeof code !== "number" || code === 0;
  }
  if (item["type"] === "mcp_tool_call") {
    return item["error"] === undefined || item["error"] === null;
  }
  return true;
}

/**
 * Turns one line of the stream into board events. `started` tracks which item ids already
 * produced a tool_call so a completed item after a started one does not emit twice.
 */
export function parseExecLine(line: string, started: Set<string>): ParsedExecLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { events: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { events: [] };
  }
  if (!isDict(parsed)) {
    return { events: [] };
  }
  const type = str(parsed["type"]);
  switch (type) {
    case "thread.started":
      return { events: [], threadId: str(parsed["thread_id"]) };
    case "turn.started":
      return { events: [] };
    case "turn.completed":
      return { events: [], usage: usageOf(parsed["usage"]), turnCompleted: true };
    case "turn.failed": {
      const error = isDict(parsed["error"])
        ? str(parsed["error"]["message"])
        : str(parsed["error"]);
      return {
        events: [{ type: "error", message: error ?? "turn failed" }],
        error: error ?? "turn failed",
        turnFailed: true,
      };
    }
    case "error": {
      const message = str(parsed["message"]) ?? "error";
      return { events: [{ type: "error", message }], error: message };
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = parsed["item"];
      if (!isDict(item)) {
        return { events: [] };
      }
      const id = str(item["id"]) ?? "";
      const itemType = str(item["type"]);
      if (itemType === "agent_message") {
        const text = str(item["text"]) ?? "";
        return type === "item.completed" && text.length > 0
          ? { events: [{ type: "text", delta: text }], agentMessage: text }
          : { events: [] };
      }
      if (itemType === "error") {
        const message = str(item["message"]) ?? "error";
        return { events: [{ type: "error", message }], error: message };
      }
      const name = toolNameOf(item);
      if (name === null) {
        return { events: [] };
      }
      const events: AgentEvent[] = [];
      if (!started.has(id)) {
        started.add(id);
        events.push({ type: "tool_call", name, input: toolInputOf(item) });
      }
      if (type === "item.completed") {
        events.push({ type: "tool_result", name, ok: toolOk(item) });
      }
      return { events };
    }
    default:
      return { events: [] };
  }
}
