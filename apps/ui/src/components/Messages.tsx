import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Message } from "@stellaris/shared";
import { useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import { shortId, timeAgo } from "../lib/format.js";
import { Markdown } from "./Markdown.js";
import { Button, Empty, ErrorNote, inputClass } from "./ui.js";

export function MessageList({
  messages,
  emptyText = "No messages yet.",
}: {
  messages: readonly Message[];
  emptyText?: string;
}) {
  if (messages.length === 0) return <Empty>{emptyText}</Empty>;
  return (
    <ol className="space-y-3">
      {messages.map((message) => (
        <li key={message.id} className="rounded border border-board-border bg-board-bg/60 p-3">
          <div className="mb-1 flex items-center gap-2 text-xs text-board-muted">
            <span className="font-semibold text-board-text">@{message.author}</span>
            <span>{message.channel}</span>
            {message.thread === undefined ? null : <span>thread {shortId(message.thread)}</span>}
            <span className="ml-auto" title={message.ts}>
              {timeAgo(message.ts)}
            </span>
          </div>
          <Markdown>{message.body}</Markdown>
        </li>
      ))}
    </ol>
  );
}

/** Posts as the signed-in member. A thread id posts into that task's thread. */
export function Composer({
  channel,
  threadId,
  placeholder = "Write a message. Mention an agent with @name to wake it.",
}: {
  channel: string;
  threadId?: string | undefined;
  placeholder?: string;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const post = useMutation({
    mutationFn: () =>
      api.verb("post_message", {
        channel,
        body,
        ...(threadId === undefined ? {} : { thread_id: threadId }),
      }),
    onSuccess: () => {
      setBody("");
      void queryClient.invalidateQueries();
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (body.trim().length > 0) post.mutate();
  };
  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={placeholder}
        rows={3}
        className={`${inputClass} font-mono`}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" tone="primary" disabled={post.isPending || body.trim().length === 0}>
          Post to {threadId === undefined ? channel : `thread ${shortId(threadId)}`}
        </Button>
        <ErrorNote error={post.error} />
      </div>
    </form>
  );
}
