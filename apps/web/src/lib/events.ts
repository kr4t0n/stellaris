import { BoardEventSchema, SOCIETY_SCOPE, type BoardEvent } from "@stellaris/shared";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { followStream } from "./sse.js";

interface FollowOptions {
  readonly onEvent: (event: BoardEvent) => void;
  /** Called when the stream reconnects after a drop, when events may have been missed. */
  readonly onResume: () => void;
}

/** Follows the board's event stream from the end of the log, resuming after the last event seen. */
export function followBoardEvents(token: string, options: FollowOptions): () => void {
  let since = "latest";
  return followStream({
    token,
    url: () => `/api/events/stream?since=${since}`,
    onData: (data) => {
      const event = BoardEventSchema.parse(JSON.parse(data));
      since = event.id;
      options.onEvent(event);
    },
    onOpen: (resumed) => {
      if (resumed) {
        options.onResume();
      }
    },
  });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The cached reads an event makes stale, by query-key prefix. */
export function staleKeys(event: BoardEvent): QueryKey[] {
  const { type, payload, actor } = event;
  if (type === "message.posted") {
    const thread = text(payload["thread"]);
    return thread === undefined
      ? [["channels"], ["channel", text(payload["channel"])], ["requests"]]
      : [["threads"], ["thread", thread], ["requests"]];
  }
  if (type.startsWith("thread.")) {
    return [["threads"], ["thread", text(payload["threadId"])], ["channel"], ["requests"]];
  }
  if (type.startsWith("task.") || type.startsWith("merge.") || type === "lease.expired") {
    return [["tasks"], ["task", text(payload["taskId"])], ["members"], ["metrics"]];
  }
  if (type === "turn.completed" || type === "turn.failed") {
    // A turn may have rewritten the citizen's memory and skills, or reconciled or left a conflict
    // copy, each a change in its home's history, as well as its turns; and its hand-back committed
    // what it left on a task's branch, which a home turn may have worked on too.
    return [
      ["scheduler"],
      ["members"],
      ["turns", actor],
      ["memory", actor],
      ["agent-skills", actor],
      ["conflicts", actor],
      ["history", actor],
      ["task-file"],
      ["task-changes"],
      ["metrics"],
    ];
  }
  if (type === "turn.started") {
    return [["scheduler"], ["members"], ["metrics"]];
  }
  if (type.startsWith("turn.") || type === "wake.requested" || type === "paused.changed") {
    return [["scheduler"], ["members"]];
  }
  if (type === "knowledge.written") {
    return [["knowledge", text(payload["project"]) ?? SOCIETY_SCOPE]];
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
  // A runner that comes or goes may list other models, and the server forgets what it listed.
  if (type.startsWith("runner.")) {
    return [["runners"], ["models"]];
  }
  if (type.startsWith("proposal.")) {
    return [["proposals"], ["proposal", text(payload["proposalId"])], ["metrics"]];
  }
  if (type === "skill.promoted") {
    return [["skills"]];
  }
  if (type === "ops.signal") {
    return [["signals"], ["scheduler"], ["metrics"]];
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
