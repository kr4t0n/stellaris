/** A parsed server-sent event. */
export interface SseMessage {
  readonly event: string;
  readonly data: string;
  readonly id: string | null;
}

/**
 * Incremental SSE parser. Feed raw chunks; it returns complete messages and keeps the remainder.
 * Pure, so the stream reader and tests share it.
 */
export function createSseParser(): { feed(chunk: string): SseMessage[] } {
  let pending = "";
  return {
    feed(chunk: string): SseMessage[] {
      pending += chunk;
      const messages: SseMessage[] = [];
      let boundary = pending.indexOf("\n\n");
      while (boundary !== -1) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const message = parseBlock(block);
        if (message !== null) {
          messages.push(message);
        }
        boundary = pending.indexOf("\n\n");
      }
      return messages;
    },
  };
}

function parseBlock(block: string): SseMessage | null {
  let event = "message";
  let id: string | null = null;
  const data: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    } else if (field === "id") {
      id = value;
    }
  }
  if (data.length === 0) {
    return null;
  }
  return { event, data: data.join("\n"), id };
}

/**
 * Streams SSE over fetch, which unlike EventSource can carry an authorization header.
 * Resolves when the stream ends or the signal aborts; throws on a non-2xx response.
 */
export async function streamSse(
  url: string,
  headers: Record<string, string>,
  onMessage: (message: SseMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    headers: { ...headers, accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || response.body === null) {
    throw new Error(`stream failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      for (const message of parser.feed(decoder.decode(value, { stream: true }))) {
        onMessage(message);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
