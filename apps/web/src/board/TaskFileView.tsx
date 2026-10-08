import { BRANCH_FILE_LIMIT_BYTES, type BranchFile } from "@stellaris/shared";
import { Link, useParams } from "@tanstack/react-router";
import { Fragment, useMemo } from "react";
import { Markdown } from "../components/Markdown.js";
import { TaskFileLink, useFileUrl } from "../components/TaskFile.js";
import { ApiError } from "../lib/api.js";
import { bytesOf, imageType, normalizePath, parentOf, sizeLabel, viewOf } from "../lib/files.js";
import { ago } from "../lib/format.js";
import { useNow, useProjects, useTask, useTaskFile } from "../lib/session.js";
import { PaneHeader, PaneNote } from "./Pane.js";

const BACK =
  "grid size-7 shrink-0 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary";
const DOWNLOAD =
  "inline-flex h-7 shrink-0 items-center rounded-md px-3 text-xs text-fg-tertiary transition-colors hover:bg-surface-2/70 hover:text-fg-primary";
/** Rows of a table shown at once; a longer one says how many more it has. */
const TABLE_ROWS = 1000;

/** Where the path sits: the branch's root, then each folder, each a link but the last. */
function Trail({ taskId, path }: { taskId: string; path: string }) {
  const segments = path === "" ? [] : path.split("/");
  const crumb = "text-fg-tertiary hover:text-fg-primary";
  return (
    <nav aria-label="Path" className="flex flex-wrap items-center gap-x-1 text-meta">
      {segments.length === 0 ? (
        <span>Files</span>
      ) : (
        <TaskFileLink taskId={taskId} path="" className={crumb}>
          Files
        </TaskFileLink>
      )}
      {segments.map((segment, at) => (
        <Fragment key={segments.slice(0, at + 1).join("/")}>
          <span aria-hidden="true">/</span>
          {at === segments.length - 1 ? (
            <span className="text-fg-secondary">{segment}</span>
          ) : (
            <TaskFileLink
              taskId={taskId}
              path={segments.slice(0, at + 1).join("/")}
              className={crumb}
            >
              {segment}
            </TaskFileLink>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

function Folder({ taskId, file }: { taskId: string; file: Extract<BranchFile, { kind: "dir" }> }) {
  const entries = file.entries.toSorted((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
  );
  return (
    <ul className="mt-3 space-y-1">
      {entries.map((entry) => (
        <li key={entry.name} className="flex items-baseline gap-2">
          <TaskFileLink
            taskId={taskId}
            path={file.path === "" ? entry.name : `${file.path}/${entry.name}`}
            className="text-sm text-fg-secondary hover:text-fg-primary"
          >
            {entry.kind === "dir" ? `${entry.name}/` : entry.name}
          </TaskFileLink>
          {entry.size === null ? null : <span className="text-meta">{sizeLabel(entry.size)}</span>}
        </li>
      ))}
    </ul>
  );
}

function Table({ rows }: { rows: string[][] }) {
  const [head, ...body] = rows;
  if (head === undefined) {
    return <p className="mt-3 text-meta">The table is empty.</p>;
  }
  const shown = body.slice(0, TABLE_ROWS);
  const cell = "border border-line px-2 py-1 text-left align-top whitespace-pre-wrap";
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="text-xs text-fg-secondary">
        <thead>
          <tr>
            {head.map((name, at) => (
              <th key={at} scope="col" className={`${cell} font-medium text-fg-primary`}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, at) => (
            <tr key={at}>
              {row.map((value, column) => (
                <td key={column} className={cell}>
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length ? (
        <p className="mt-2 text-meta">
          The first {TABLE_ROWS} of {body.length} rows; download the file for the rest.
        </p>
      ) : null}
    </div>
  );
}

function Content({
  taskId,
  file,
  url,
}: {
  taskId: string;
  file: Extract<BranchFile, { kind: "file" }>;
  url: string | null;
}) {
  const view = useMemo(
    () => (file.content === null ? null : viewOf(file.path, bytesOf(file.content))),
    [file.path, file.content],
  );
  const name = file.path.split("/").at(-1) ?? file.path;
  if (view === null) {
    return (
      <p className="mt-3 text-sm text-fg-secondary">
        {name} is {sizeLabel(file.size)}, more than the {sizeLabel(BRANCH_FILE_LIMIT_BYTES)} the
        board shows. Its runner still has it on the task's branch.
      </p>
    );
  }
  if (view.kind === "markdown") {
    return (
      <div className="mt-3">
        <Markdown text={view.text} base={{ taskId, dir: parentOf(file.path) }} />
      </div>
    );
  }
  if (view.kind === "image") {
    return url === null ? null : (
      <img src={url} alt={name} className="mt-3 max-w-full rounded-lg" />
    );
  }
  if (view.kind === "table") {
    return <Table rows={view.rows} />;
  }
  if (view.kind === "text") {
    return (
      <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-0/80 p-3 font-mono text-[12px] leading-relaxed text-fg-secondary shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
        {view.text}
      </pre>
    );
  }
  return (
    <p className="mt-3 text-sm text-fg-secondary">
      {name} is not text ({sizeLabel(file.size)}). Download it to open it.
    </p>
  );
}

/** A file or a folder on a task's branch, as the branch's newest commit has it. */
export function TaskFileView() {
  const { taskId, _splat } = useParams({ from: "/task/$taskId/files/$" });
  const path = normalizePath(_splat ?? "") ?? "";
  const task = useTask(taskId);
  const projects = useProjects();
  const file = useTaskFile(taskId, path);
  const now = useNow(30_000);
  const data = file.data;
  const content = data?.kind === "file" ? data.content : null;
  // One address serves both the image and the download.
  const url = useFileUrl(content, imageType(path) ?? "application/octet-stream");
  const name = path === "" ? "Files" : (path.split("/").at(-1) ?? path);
  const title = task.data?.title ?? taskId;

  let body;
  if (data !== undefined) {
    body =
      data.kind === "dir" ? (
        <Folder taskId={taskId} file={data} />
      ) : (
        <Content taskId={taskId} file={data} url={url} />
      );
  } else if (file.error instanceof ApiError && file.error.status === 404) {
    body = (
      <p className="mt-3 text-sm text-fg-secondary">
        {path === "" ? "Nothing" : path} is not on task/{taskId} yet. What a turn writes reaches the
        branch when the turn ends.
      </p>
    );
  } else if (file.error instanceof ApiError && file.error.status === 503) {
    const project = projects.data?.find((each) => each.slug === task.data?.project);
    body = (
      <p className="mt-3 text-sm text-fg-secondary">
        {project?.runner === undefined ? "The runner" : `${project.runner}, the runner`}{" "}
        {project?.name ?? "the project"} lives on, is not connected, so the task's files cannot be
        read now.
      </p>
    );
  } else if (file.error !== null) {
    body = <p className="mt-3 text-sm text-fg-secondary">{file.error.message}</p>;
  } else {
    body = <PaneNote>Reading {name} from the task's runner…</PaneNote>;
  }

  return (
    <>
      <PaneHeader
        leading={
          <Link
            to="/task/$taskId"
            params={{ taskId }}
            aria-label={`Back to the task ${title}`}
            className={BACK}
          >
            ←
          </Link>
        }
        title={name}
        subtitle={
          data === undefined
            ? title
            : `${title} · committed by ${data.commit.author} ${ago(data.commit.at, now)} · ${data.commit.id.slice(0, 7)}`
        }
        trailing={
          url === null ? null : (
            <a href={url} download={name} className={DOWNLOAD}>
              Download
            </a>
          )
        }
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <Trail taskId={taskId} path={path} />
        {body}
      </div>
    </>
  );
}
