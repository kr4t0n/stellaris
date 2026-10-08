import type { Task } from "@stellaris/shared";
import { useMemo, useState } from "react";
import { TaskFileLink } from "../components/TaskFile.js";
import { ApiError } from "../lib/api.js";
import {
  changeLabel,
  fileTree,
  openFolders,
  type TreeFolder,
  type TreeNode,
} from "../lib/files.js";
import { ago } from "../lib/format.js";
import { useProjects, useTaskChanges } from "../lib/session.js";

/** Who touched a file or a folder last, and when, at a row's end. */
function Touched({ last, now }: { last: { author: string; at: string } | undefined; now: number }) {
  return last === undefined ? null : (
    <span className="ml-auto shrink-0 pl-2 text-meta">
      {last.author} {ago(last.at, now)}
    </span>
  );
}

/**
 * One level of the tree: folders, each a button that opens or closes it, then files, each a link
 * to its view but a deleted one. A level below the top hangs from a guide line.
 */
function Level({
  taskId,
  nodes,
  nested,
  isOpen,
  toggle,
  now,
}: {
  taskId: string;
  nodes: readonly TreeNode[];
  nested: boolean;
  isOpen: (folder: TreeFolder) => boolean;
  toggle: (folder: TreeFolder) => void;
  now: number;
}) {
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
                <Level
                  taskId={taskId}
                  nodes={node.children}
                  nested
                  isOpen={isOpen}
                  toggle={toggle}
                  now={now}
                />
              ) : null}
            </li>
          );
        }
        const { change } = node;
        return (
          <li key={change.path} className="flex items-baseline gap-2 py-0.5 text-sm">
            <span aria-hidden="true" className="w-2.5 shrink-0" />
            {change.status === "deleted" ? (
              <span className="min-w-0 truncate text-fg-tertiary line-through" title={change.path}>
                {node.name}
              </span>
            ) : (
              <TaskFileLink
                taskId={taskId}
                path={change.path}
                className="min-w-0 truncate text-fg-secondary hover:text-fg-primary"
              >
                {node.name}
              </TaskFileLink>
            )}
            <span className="shrink-0 text-meta">{changeLabel(change)}</span>
            <Touched last={change.lastChange} now={now} />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The tree of what a branch changed. It opens with as much as fits in a couple of dozen rows, and
 * what the user opens or closes stays so while the list refreshes.
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
  return (
    <Level
      taskId={taskId}
      nodes={tree.children}
      nested={false}
      isOpen={isOpen}
      toggle={toggle}
      now={now}
    />
  );
}

/**
 * What a task's branch changed since it left the default branch, as a tree of folders: each file
 * with what happened to it and whose turn touched it last, opening in its file's view, so the work
 * is found whether or not anyone linked it.
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
        <p className="mt-2 text-meta">
          Nothing changed on {branch} yet. What a turn writes reaches the branch when the turn ends.
        </p>
      ) : (
        <>
          <p className="mt-2 text-meta">
            {total === 1 ? "1 file" : `${total} files`} changed · newest commit by {head.author}{" "}
            {ago(head.at, now)}
          </p>
          <ChangeTree taskId={task.id} changes={files} now={now} />
          {total > files.length ? (
            <p className="mt-2 text-meta">
              The first {files.length} of {total}; browse the branch for the rest.
            </p>
          ) : null}
        </>
      );
  } else if (changes.error instanceof ApiError && changes.error.status === 404) {
    body = (
      <p className="mt-2 text-meta">
        Nothing on {branch} yet. What a turn writes reaches the branch when the turn ends.
      </p>
    );
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
