import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { ApiError } from "../lib/api.js";
import { useMembers, useRoles, useSession } from "../lib/session.js";
import { listed, wakesFor } from "./compose.js";

const FIELD =
  "block w-full rounded-lg bg-surface-2/50 px-3 py-2 text-sm text-fg-primary outline-none shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] placeholder:text-fg-muted focus:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]";

function Failure({ error }: { error: Error | null }) {
  return error === null ? null : (
    <p role="alert" className="text-xs text-red-400">
      {error instanceof ApiError ? error.message : "The board did not take it."}
    </p>
  );
}

/** Opens a topic thread on a channel, with an optional first message, and goes to it. */
export function NewThreadForm({ channel, onDone }: { channel: string; onDone: () => void }) {
  const { api } = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const members = useMembers();
  const roles = useRoles();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const titleField = useRef<HTMLInputElement>(null);
  useEffect(() => titleField.current?.focus(), []);

  const open = useMutation({
    mutationFn: async () => {
      const thread = await api.openThread({ channel, title: title.trim() });
      if (body.trim() !== "") {
        await api.sendMessage({ thread_id: thread.id, body: body.trim() });
      }
      return thread;
    },
    onSuccess: (thread) => {
      void client.invalidateQueries({ queryKey: ["threads"] });
      onDone();
      void navigate({ to: "/thread/$threadId", params: { threadId: thread.id } });
    },
  });
  const wakes = body.trim() === "" ? [] : wakesFor(body, members.data ?? [], roles.data ?? []);

  return (
    <form
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        open.mutate();
      }}
    >
      <input
        ref={titleField}
        value={title}
        maxLength={200}
        placeholder="What is the thread about?"
        aria-label="Thread title"
        onChange={(event) => setTitle(event.target.value)}
        className={FIELD}
      />
      <textarea
        value={body}
        rows={3}
        placeholder="First message, optional"
        aria-label="First message"
        onChange={(event) => setBody(event.target.value)}
        className={`${FIELD} resize-none`}
      />
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">
          {wakes.length > 0
            ? `The first message wakes ${listed(wakes)}.`
            : "Only its participants and anyone mentioned will read it."}
        </p>
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={title.trim() === "" || open.isPending}>
          {open.isPending ? "Opening…" : "Open thread"}
        </Button>
      </div>
      <Failure error={open.error} />
    </form>
  );
}

/** Closes a thread with a summary, which the board posts to the thread's channel. */
export function CloseThreadForm({
  threadId,
  channel,
  onDone,
}: {
  threadId: string;
  channel: string;
  onDone: () => void;
}) {
  const { api } = useSession();
  const client = useQueryClient();
  const [summary, setSummary] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  const close = useMutation({
    mutationFn: () => api.closeThread({ thread_id: threadId, summary: summary.trim() }),
    onSuccess: () => {
      for (const queryKey of [["thread", threadId], ["threads"], ["channel", channel]]) {
        void client.invalidateQueries({ queryKey });
      }
      onDone();
    },
  });
  return (
    <form
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        close.mutate();
      }}
    >
      <textarea
        ref={field}
        value={summary}
        rows={3}
        placeholder={`What did it settle? The summary is posted to #${channel}.`}
        aria-label="Closing summary"
        onChange={(event) => setSummary(event.target.value)}
        className={`${FIELD} resize-none`}
      />
      <div className="flex items-center justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={summary.trim() === "" || close.isPending}>
          {close.isPending ? "Closing…" : "Close thread"}
        </Button>
      </div>
      <Failure error={close.error} />
    </form>
  );
}
