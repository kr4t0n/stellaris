import type { BranchFileChange, Task } from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { TaskFileLink } from "../components/TaskFile.js";
import { ApiError } from "../lib/api.js";
import {
  changeLabel,
  fileTree,
  openFolders,
  patchRows,
  type PatchRow,
  type TreeFolder,
  type TreeNode,
} from "../lib/files.js";
import { ago } from "../lib/format.js";
import { useProjects, useTaskChanges, useTaskDiff } from "../lib/session.js";

const ROW_TONE: Readonly<Record<PatchRow["kind"], string>> = {
  hunk: "text-fg-muted",
  note: "text-fg-muted",
  added: "bg-emerald-400/10 text-emerald-300",
  removed: "bg-red-400/10 text-red-300",
  context: "text-fg-tertiary",
};

/** Who touched a file or a folder last, and when, at a row's end. */
function Touched({ last, now }: { last: { author: string; at: string } | undefined; now: number }) {
  return last === undefined ? null : (
    <span className="ml-auto shrink-0 pl-2 text-meta">
      {last.author} {ago(last.at, now)}
    </span>
  );
}

/**
 * A file's patch, each line the file still has numbered as the branch has it. A number opens the
 * file at that line; it is left out of the tab order, since "Open the whole file" serves keyboards.
 */
function Patch({ taskId, path, patch }: { taskId: string; path: string; patch: string }) {
  const rows = useMemo(() => patchRows(patch), [patch]);
  return (
    <div className="mt-1 max-h-96 overflow-auto rounded-md bg-surface-0/60 py-1.5 font-mono text-[11px] leading-relaxed">
      {rows.map((row, at) => (
        <div key={at} className={`flex ${ROW_TONE[row.kind]}`}>
          <span
            aria-hidden="true"
            className="w-10 shrink-0 pr-2 text-right text-fg-muted select-none"
          >
            {row.line === undefined ? null : (
              <Link
                to="/task/$taskId/files/$"
                params={{ taskId, _splat: path }}
                search={{ line: row.line }}
                tabIndex={-1}
                title={`Open ${path} at line ${row.line}`}
                className="hover:text-fg-primary"
              >
                {row.line}
              </Link>
            )}
          </span>
          <span className="min-w-0 flex-1 pr-2 break-words whitespace-pre-wrap">
            {row.text === "" ? " " : row.text}
          </span>
        </div>
      ))}
    </div>
  );
}

/** An opened file: what the branch did to it, and the way to the whole file while it is there. */
function FileDiff({ taskId, change }: { taskId: string; change: BranchFileChange }) {
  const diff = useTaskDiff(taskId, change.path);
  let body;
  if (diff.data !== undefined) {
    const { patch, truncated } = diff.data;
    body =
      patch === null ? (
        <p className="mt-1 text-meta">A binary file; its contents are not shown here.</p>
      ) : patch === "" ? (
        <p className="mt-1 text-meta">No lines changed.</p>
      ) : (
        <>
          <Patch taskId={taskId} path={change.path} patch={patch} />
          {truncated ? (
            <p className="mt-1 text-meta">The rest of this file's change is cut.</p>
          ) : null}
        </>
      );
  } else if (diff.error instanceof ApiError && diff.error.status === 503) {
    body = (
      <p className="mt-1 text-meta">
        The task's runner is not connected, so the change cannot be read now.
      </p>
    );
  } else if (diff.error !== null) {
    body = <p className="mt-1 text-meta">{diff.error.message}</p>;
  } else {
    body = <p className="mt-1 text-meta">Reading the change…</p>;
  }
  return (
    <div className="mb-2 ml-[18px]">
      {change.status === "deleted" ? null : (
        <TaskFileLink
          taskId={taskId}
          path={change.path}
          className="text-meta underline decoration-line underline-offset-2 hover:text-fg-primary"
        >
          Open the whole file
        </TaskFileLink>
      )}
      {body}
    </div>
  );
}

/** Which folders and files of the tree are open, and how to open or close one. */
interface Openings {
  readonly isOpen: (folder: TreeFolder) => boolean;
  readonly toggle: (folder: TreeFolder) => void;
  readonly shown: ReadonlySet<string>;
  readonly toggleFile: (path: string) => void;
}

/**
 * One level of the tree: folders, each a button that opens or closes it, then files, each a button
 * that opens or closes its patch. A level below the top hangs from a guide line.
 */
function Level({
  taskId,
  nodes,
  nested,
  openings,
  now,
}: {
  taskId: string;
  nodes: readonly TreeNode[];
  nested: boolean;
  openings: Openings;
  now: number;
}) {
  const { isOpen, toggle, shown, toggleFile } = openings;
  return (
    <ul className={nested ? "ml-[5px] border-l border-line-strong pl-2" : "mt-2"}>
      {nodes.map((node) => {
        if (node.kind === "dir") {
          const open = isOpen(node);
          return (
            <li key={`dir:${node.path}`}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(node)}
                className="flex w-full items-baseline gap-2 rounded-md py-0.5 text-left text-sm hover:bg-surface-2/40"
              >
                <span
                  aria-hidden="true"
                  className={`inline-block w-2.5 shrink-0 text-[10px] text-fg-muted transition-transform ${open ? "rotate-90" : ""}`}
                >
                  ▸
                </span>
                <span className="min-w-0 truncate text-fg-primary">{node.name}/</span>
                <span className="shrink-0 text-meta">
                  {node.files === 1 ? "1 file" : `${node.files} files`}
                </span>
                <Touched last={node.lastChange} now={now} />
              </button>
              {open ? (
                <Level taskId={taskId} nodes={node.children} nested openings={openings} now={now} />
              ) : null}
            </li>
          );
        }
        const { change } = node;
        const open = shown.has(change.path);
        const name =
          change.status === "deleted"
            ? "text-fg-tertiary line-through"
            : open
              ? "text-fg-primary"
              : "text-fg-secondary group-hover:text-fg-primary";
        return (
          <li key={change.path}>
            <button
              type="button"
              aria-expanded={open}
              title={change.path}
              onClick={() => toggleFile(change.path)}
              className={`group flex w-full items-baseline gap-2 rounded-md py-0.5 text-left text-sm hover:bg-surface-2/40 ${open ? "bg-surface-2/30" : ""}`}
            >
              <span aria-hidden="true" className="w-2.5 shrink-0" />
              <span className={`min-w-0 truncate ${name}`}>{node.name}</span>
              <span className="shrink-0 text-meta">{changeLabel(change)}</span>
              <Touched last={change.lastChange} now={now} />
            </button>
            {open ? <FileDiff taskId={taskId} change={change} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The tree of what a branch changed. It opens with as much as fits in a couple of dozen rows and
 * every file closed, and what the user opens or closes stays so while the list refreshes.
 */
function ChangeTree({
  taskId,
  changes,
  now,
}: {
  taskId: string;
  changes: Parameters<typeof fileTree>[0];
  now: number;
}) {
  const tree = useMemo(() => fileTree(changes), [changes]);
  const opened = useMemo(() => openFolders(tree), [tree]);
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const isOpen = (folder: TreeFolder): boolean =>
    chosen.get(folder.path) ?? opened.has(folder.path);
  const toggle = (folder: TreeFolder): void => {
    setChosen((was) =>
      new Map(was).set(folder.path, !(was.get(folder.path) ?? opened.has(folder.path))),
    );
  };
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const toggleFile = (path: string): void => {
    setShown((was) => {
      const next = new Set(was);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });
  };
  return (
    <Level
      taskId={taskId}
      nodes={tree.children}
      nested={false}
      openings={{ isOpen, toggle, shown, toggleFile }}
      now={now}
    />
  );
}

/**
 * What a task's branch changed since it left the default branch, as a tree of folders: each file
 * with what happened to it and whose turn touched it last, opening to its patch and from there to
 * its file's view, so the work is found whether or not anyone linked it.
 */
export function TaskFiles({ task, now }: { task: Task; now: number }) {
  const changes = useTaskChanges(task.id);
  const projects = useProjects();
  const branch = `task/${task.id}`;

  let body;
  if (changes.data !== undefined) {
    const { files, total, head } = changes.data;
    body =
      files.length === 0 ? (
        <p className="mt-2 text-meta">Nothing changed on {branch} yet.</p>
      ) : (
        <>
          <p className="mt-2 text-meta">
            {total === 1 ? "1 file" : `${total} files`} changed · newest commit by {head.author}{" "}
            {ago(head.at, now)}
          </p>
          <ChangeTree taskId={task.id} changes={files} now={now} />
          {total > files.length ? (
            <p className="mt-2 text-meta">
              The first {files.length} of {total}
            </p>
          ) : null}
        </>
      );
  } else if (changes.error instanceof ApiError && changes.error.status === 404) {
    body = <p className="mt-2 text-meta">Nothing on {branch} yet.</p>;
  } else if (changes.error instanceof ApiError && changes.error.status === 503) {
    const project = projects.data?.find((each) => each.slug === task.project);
    body = (
      <p className="mt-2 text-meta">
        {project?.runner === undefined ? "The runner" : `${project.runner}, the runner`}{" "}
        {project?.name ?? task.project} lives on, is not connected, so the task's files cannot be
        listed now.
      </p>
    );
  } else if (changes.error !== null) {
    body = <p className="mt-2 text-meta">{changes.error.message}</p>;
  } else {
    body = <p className="mt-2 text-meta">Reading the task's branch…</p>;
  }

  return (
    <section aria-label="Files" className="mt-5 border-t border-line pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-section">Files</h3>
        <TaskFileLink
          taskId={task.id}
          path=""
          className="text-meta underline decoration-line underline-offset-2 hover:text-fg-primary"
        >
          Browse the branch
        </TaskFileLink>
      </div>
      {body}
    </section>
  );
}
