import type { Task } from "@stellaris/shared";
import { TaskFileLink } from "../components/TaskFile.js";
import { ApiError } from "../lib/api.js";
import { changeLabel } from "../lib/files.js";
import { ago } from "../lib/format.js";
import { useProjects, useTaskChanges } from "../lib/session.js";

/**
 * What a task's branch changed since it left the default branch: each file with what happened to
 * it and whose turn touched it last, opening in its file's view, so the work is found whether or
 * not anyone linked it.
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
          <ul className="mt-2 space-y-1">
            {files.map((file) => (
              <li key={file.path} className="flex items-baseline gap-2 text-sm">
                {file.status === "deleted" ? (
                  <span
                    className="min-w-0 truncate text-fg-tertiary line-through"
                    title={file.path}
                  >
                    {file.path}
                  </span>
                ) : (
                  <TaskFileLink
                    taskId={task.id}
                    path={file.path}
                    className="min-w-0 truncate text-fg-secondary hover:text-fg-primary"
                  >
                    {file.path}
                  </TaskFileLink>
                )}
                <span className="shrink-0 text-meta">{changeLabel(file)}</span>
                {file.lastChange === undefined ? null : (
                  <span className="ml-auto shrink-0 text-meta">
                    {file.lastChange.author} {ago(file.lastChange.at, now)}
                  </span>
                )}
              </li>
            ))}
          </ul>
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
