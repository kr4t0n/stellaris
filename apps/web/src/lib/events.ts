import { BoardEventSchema, type BoardEvent } from "@stellaris/shared";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The `data` lines of one server-sent-events frame, joined. */
function frameData(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

interface FollowOptions {
  readonly onEvent: (event: BoardEvent) => void;
  /** Called when the stream reconnects after a drop, when events may have been missed. */
  readonly onResume: () => void;
}

/**
 * Follows the board's event stream. It reads over `fetch`, because `EventSource` cannot send the
 * bearer token; starts at the end of the log; resumes from the last event it saw after a drop;
 * and backs off while the server is away. Returns the function that stops it.
 */
export function followBoardEvents(token: string, options: FollowOptions): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  let since = "latest";
  let delay = 1_000;
  let dropped = false;

  const run = async (): Promise<void> => {
    while (!signal.aborted) {
      try {
        const response = await fetch(`/api/events/stream?since=${since}`, {
          headers: { authorization: `Bearer ${token}` },
          signal,
        });
        if (!response.ok || response.body === null) {
          throw new Error(`the event stream answered ${response.status}`);
        }
        if (dropped) {
          options.onResume();
        }
        delay = 1_000;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += value.replaceAll("\r\n", "\n");
          for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
            const data = frameData(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
            if (data !== "") {
              const event = BoardEventSchema.parse(JSON.parse(data));
              since = event.id;
              options.onEvent(event);
            }
          }
        }
      } catch {
        if (signal.aborted) {
          return;
        }
      }
      dropped = true;
      await pause(delay, signal);
      delay = Math.min(delay * 2, 15_000);
    }
  };
  void run();
  return () => controller.abort();
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The cached reads an event makes stale, by query-key prefix. */
export function staleKeys(event: BoardEvent): QueryKey[] {
  const { type, payload } = event;
  if (type === "message.posted") {
    const thread = text(payload["thread"]);
    return thread === undefined
      ? [["channels"], ["channel", text(payload["channel"])]]
      : [["threads"], ["thread", thread]];
  }
  if (type.startsWith("thread.")) {
    return [["threads"], ["thread", text(payload["threadId"])], ["channel"]];
  }
  if (type.startsWith("task.") || type.startsWith("merge.") || type === "lease.expired") {
    return [["tasks"], ["task", text(payload["taskId"])], ["members"]];
  }
  if (type.startsWith("turn.") || type === "wake.requested" || type === "paused.changed") {
    return [["scheduler"], ["members"]];
  }
  if (type.startsWith("agent.") || type === "subscription.changed") {
    return [["members"]];
  }
  if (type.startsWith("project.") || type === "channel.added") {
    return [["projects"], ["channels"], ["society"]];
  }
  if (type === "role.added") {
    return [["roles"]];
  }
  return [];
}

/** Refreshes what an event touched; keys ending in an unknown id refresh the whole prefix. */
export function refreshFor(client: QueryClient, event: BoardEvent): void {
  for (const key of staleKeys(event)) {
    const known = key.filter((part) => part !== undefined);
    void client.invalidateQueries({ queryKey: known });
  }
}
