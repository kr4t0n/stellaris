import type { Member, Message, Task } from "@stellaris/shared";
import { useState } from "react";
import { Markdown } from "../components/Markdown.js";
import { ago } from "../lib/format.js";
import { Avatar, displayName } from "./Avatar.js";
import { stepLabel } from "./tasks.js";

/** Longer bodies start folded, so one report does not push a whole channel off the island. */
const FOLD_AT = 1_400;

export function MessageItem({
  message,
  members,
  now,
  task,
}: {
  message: Message;
  members: readonly Member[] | undefined;
  now: number;
  /** The task whose thread the message is in, to name the stages a step's chip mentions. */
  task?: Task | undefined;
}) {
  const long = message.body.length > FOLD_AT;
  const [open, setOpen] = useState(false);
  const fromBoard = message.author === "board";
  const step = message.step === undefined ? null : stepLabel(message.step, task);
  return (
    <article className={`flex gap-3 px-4 py-2.5 ${fromBoard ? "opacity-70" : ""}`}>
      <Avatar name={message.author} members={members} />
      <div className="min-w-0 flex-1">
        <header className="flex min-w-0 items-baseline gap-2">
          <span className="text-title">{displayName(message.author)}</span>
          {step === null ? null : (
            <span className={`min-w-0 truncate rounded-md px-1.5 py-px text-[11px] ${step.tone}`}>
              {step.text}
            </span>
          )}
          <time dateTime={message.ts} title={message.ts} className="shrink-0 text-meta">
            {ago(message.ts, now)}
          </time>
        </header>
        <div className={long && !open ? "relative max-h-72 overflow-hidden" : ""}>
          <Markdown text={message.body} />
          {long && !open ? (
            <div className="absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-surface-1 to-transparent" />
          ) : null}
        </div>
        {long ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="mt-1 text-xs text-fg-tertiary hover:text-fg-primary"
          >
            {open ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
    </article>
  );
}
