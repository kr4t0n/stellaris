import type { HomeChange, HomeFileChange, HomeFileDiff } from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ago } from "../lib/format.js";
import { useHomeChange, useHomeHistory, useNow } from "../lib/session.js";
import { PaneNote } from "./Pane.js";
import { time } from "./Transcript.js";

const PAGE = 30;

const KIND_LABEL: Readonly<Record<HomeChange["kind"], string>> = {
  turn: "turn",
  board: "board",
  merge: "both kept",
};

/** The same, as a screen reader hears a row. */
const KIND_TITLE: Readonly<Record<HomeChange["kind"], string>> = {
  turn: "Changed by a turn",
  board: "Written by the board",
  merge: "Both versions kept",
};

/** What a change did to one file, in a word or a count. */
function fileEffect(file: HomeFileChange): string {
  if (file.status === "added") return "new";
  if (file.status === "deleted") return "deleted";
  return file.added === null || file.removed === null
    ? "binary"
    : `+${file.added} −${file.removed}`;
}

/** The files a change touched, as one line. */
function filesLine(change: HomeChange): string {
  return change.files.map((file) => `${file.path} ${fileEffect(file)}`).join(", ");
}

function lineTone(line: string): string {
  if (line.startsWith("@@") || line.startsWith("\\")) return "text-fg-muted";
  if (line.startsWith("+")) return "text-emerald-300";
  if (line.startsWith("-")) return "text-red-300";
  return "text-fg-tertiary";
}

function FilePatch({ file }: { file: HomeFileDiff }) {
  return (
    <div>
      <p className="text-xs text-fg-secondary">
        {file.path}
        {file.status === "modified" ? "" : <span className="text-fg-muted"> · {file.status}</span>}
      </p>
      {file.patch === null ? (
        <p className="mt-1 text-meta">A binary file; its contents are not shown.</p>
      ) : file.patch === "" ? (
        <p className="mt-1 text-meta">Empty.</p>
      ) : (
        <pre className="mt-1 max-h-96 overflow-auto rounded-md bg-surface-0/60 p-2 font-mono text-[11px] leading-relaxed">
          {file.patch.split("\n").map((line, index) => (
            <span key={index} className={`block whitespace-pre-wrap break-words ${lineTone(line)}`}>
              {line === "" ? " " : line}
            </span>
          ))}
        </pre>
      )}
      {file.truncated ? (
        <p className="mt-1 text-meta">The rest of this file's change is cut.</p>
      ) : null}
    </div>
  );
}

/** An opened change: where it came from, then every file's patch. */
function ChangeBody({ name, change }: { name: string; change: HomeChange }) {
  const patches = useHomeChange(name, change.commit, true);
  return (
    <div className="space-y-3 px-4 pt-1 pb-3">
      <p className="text-xs text-fg-secondary">
        {change.kind === "merge" ? (
          "Two turns on different runners changed the same lines at once. The file kept one turn's version, and this copy holds the other's until the citizen reconciles them."
        ) : change.kind === "board" ? (
          `Written by the board: ${change.subject.replace(/^home: /, "")}.`
        ) : change.turnId === undefined ? (
          change.subject
        ) : (
          <Link
            to="/citizen/$name"
            params={{ name }}
            search={{ tab: "turns", turn: change.turnId }}
            className="text-fg-secondary underline decoration-line underline-offset-2 hover:text-fg-primary"
          >
            Open the turn that made it
          </Link>
        )}
        <span className="text-fg-muted"> · {time(change.at)}</span>
      </p>
      {patches.data === undefined ? (
        <p className="text-meta">
          {patches.isError ? "Could not read the change." : "Reading the change…"}
        </p>
      ) : (
        patches.data.map((file) => <FilePatch key={file.path} file={file} />)
      )}
    </div>
  );
}

function ChangeRow({ name, change, now }: { name: string; change: HomeChange; now: number }) {
  const [open, setOpen] = useState(false);
  const files = change.files.length === 0 ? change.subject : filesLine(change);
  return (
    <li className="border-b border-line/60 last:border-b-0">
      <details className="group" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary
          aria-label={`${KIND_TITLE[change.kind]} ${ago(change.at, now)}: ${files}`}
          className="block cursor-pointer list-none px-4 py-2.5 transition-colors hover:bg-surface-2/30 group-open:bg-surface-2/20"
        >
          <span className="flex items-center gap-2 text-xs">
            <span className="shrink-0 text-fg-muted">{KIND_LABEL[change.kind]}</span>
            <span className="min-w-0 flex-1 truncate text-fg-secondary">{files}</span>
            <span className="shrink-0 text-fg-muted">{ago(change.at, now)}</span>
            <span
              aria-hidden="true"
              className="shrink-0 text-[10px] text-fg-muted transition-transform group-open:rotate-90"
            >
              ▸
            </span>
          </span>
        </summary>
        {open ? <ChangeBody name={name} change={change} /> : null}
      </details>
    </li>
  );
}

/**
 * How the citizen's home came to be: every change a turn or the board made to it, newest first,
 * and the merges that kept two versions of a file; each opens to its patch.
 */
export function CitizenHistory({ name }: { name: string }) {
  const [limit, setLimit] = useState(PAGE);
  const history = useHomeHistory(name, limit);
  const now = useNow(30_000);
  if (history.data === undefined) {
    return (
      <PaneNote>
        {history.isError ? "Could not read the home's history." : "Reading the history…"}
      </PaneNote>
    );
  }
  const { changes, more } = history.data;
  if (changes.length === 0) {
    return (
      <PaneNote>
        {name}'s home has no history yet; it starts with the citizen's first turn.
      </PaneNote>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto">
      <p className="px-4 pt-3 pb-1 text-meta">
        What {name}'s turns changed in its memory, skills, and profile, newest first.
      </p>
      <ol>
        {changes.map((change) => (
          <ChangeRow key={change.commit} name={name} change={change} now={now} />
        ))}
      </ol>
      {more ? (
        <button
          type="button"
          onClick={() => setLimit(limit + PAGE)}
          className="px-4 py-3 text-xs text-fg-tertiary hover:text-fg-primary"
        >
          Show earlier changes
        </button>
      ) : null}
    </div>
  );
}
