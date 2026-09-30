import type { Message } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../components/Button.js";
import { CliIcon } from "../components/CliIcon.js";
import { ApiError } from "../lib/api.js";
import { useMembers, useRoles, useSession } from "../lib/session.js";
import { ASK_CHANNEL, askTitle } from "./asks.js";
import { completeMention, listed, mentionAt, wakesFor } from "./compose.js";

/**
 * Where a post goes: a channel, a thread, or a new ask, which opens a thread on the society's
 * general channel titled by the post's first line, noting the ask it follows up on, if any.
 */
export type Target =
  | { readonly channel: string }
  | { readonly threadId: string }
  | { readonly ask: { readonly followUp?: string | undefined } };

const MAX_CANDIDATES = 6;

/**
 * Posts as the user into a channel or a thread. Enter sends and Shift+Enter breaks the line; an
 * `@` offers the citizens to mention; the line under the box names whom sending will wake.
 */
export function Composer({
  target,
  placeholder,
  focusOnOpen = false,
  onPosted,
  onEmptyEscape,
}: {
  target: Target;
  placeholder: string;
  /** For a composer the user just opened, such as the ask box. */
  focusOnOpen?: boolean;
  onPosted?: (message: Message) => void;
  /** Escape in an empty box, for a composer that closes. */
  onEmptyEscape?: () => void;
}) {
  const { api } = useSession();
  const client = useQueryClient();
  const members = useMembers();
  const roles = useRoles();
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once a completed mention has rendered; set in the same frame, before
  // the next keystroke can land.
  const pendingCaret = useRef<number | null>(null);

  const send = useMutation({
    mutationFn: async (body: string) => {
      if ("channel" in target) {
        return api.sendMessage({ channel: target.channel, body });
      }
      if ("threadId" in target) {
        return api.sendMessage({ thread_id: target.threadId, body });
      }
      const thread = await api.openThread({ channel: ASK_CHANNEL, title: askTitle(body) });
      const { followUp } = target.ask;
      return api.sendMessage({
        thread_id: thread.id,
        body: followUp === undefined ? body : `${body}\n\nFollows up on ${followUp}.`,
      });
    },
    onSuccess: (message) => {
      setText("");
      void client.invalidateQueries({
        queryKey:
          message.thread === undefined ? ["channel", message.channel] : ["thread", message.thread],
      });
      if ("ask" in target) {
        void client.invalidateQueries({ queryKey: ["threads"] });
      }
      // A post by the user answers whatever was asked of them where it was posted.
      void client.invalidateQueries({ queryKey: ["requests"] });
      onPosted?.(message);
    },
  });

  useEffect(() => {
    if (focusOnOpen) {
      box.current?.focus();
    }
  }, [focusOnOpen]);

  // After every render the box fits its text, up to its maximum height, past which it scrolls.
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) {
      return;
    }
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    if (pendingCaret.current !== null) {
      element.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  const fragment = dismissed ? null : mentionAt(text, caret);
  const citizens = (members.data ?? []).filter(
    (member) => member.status === "active" && member.cli !== null,
  );
  const candidates =
    fragment === null
      ? []
      : citizens
          .filter((member) => member.name.startsWith(fragment.prefix))
          .slice(0, MAX_CANDIDATES);
  const wakes = wakesFor(text, members.data ?? [], roles.data ?? []);

  const complete = (name: string): void => {
    if (fragment === null) {
      return;
    }
    const next = completeMention(text, caret, fragment.start, name);
    pendingCaret.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
  };
  const submit = (): void => {
    if (text.trim() !== "" && !send.isPending) {
      send.mutate(text.trim());
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (candidates.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : candidates.length - 1;
        setPick((pick + step) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        complete(candidates[Math.min(pick, candidates.length - 1)]?.name ?? "");
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape" && text === "" && onEmptyEscape !== undefined) {
      event.preventDefault();
      onEmptyEscape();
    }
  };

  return (
    <form
      className="border-t border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="relative rounded-xl bg-surface-2/50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] focus-within:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]">
        {candidates.length > 0 ? (
          <ul
            aria-label="Citizens to mention"
            className="card absolute bottom-full left-2 mb-2 w-60 overflow-hidden py-1"
          >
            {candidates.map((member, index) => (
              <li key={member.name}>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    complete(member.name);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                    index === pick ? "bg-surface-2 text-fg-primary" : "text-fg-secondary"
                  }`}
                >
                  {member.cli === null ? null : <CliIcon cli={member.cli} size={14} />}
                  <span className="flex-1 truncate">{member.name}</span>
                  <span className="truncate font-mono text-[11px] text-fg-muted">
                    {member.role}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          ref={box}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setPick(0);
            setDismissed(false);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          className="block max-h-48 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm text-fg-primary outline-none placeholder:text-fg-muted"
        />
        <div className="flex items-center gap-2 px-3 pb-2">
          <p className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">
            {wakes.length > 0
              ? `Sending wakes ${listed(wakes)}: a turn each.`
              : "Enter to send · Shift+Enter for a new line"}
          </p>
          <Button variant="primary" type="submit" disabled={text.trim() === "" || send.isPending}>
            {send.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
      {send.error === null ? null : (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {send.error instanceof ApiError ? send.error.message : "The message was not sent."}
        </p>
      )}
    </form>
  );
}
