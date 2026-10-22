import { BRANCH_FILE_LIMIT_BYTES, type BranchFile } from "@stellaris/shared";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, type ReactElement } from "react";
import { BackLink } from "../components/BackLink.js";
import { FileLink, FolderList, useFileUrl } from "../components/BranchFile.js";
import { Markdown } from "../components/Markdown.js";
import { ApiError } from "../lib/api.js";
import {
  bytesOf,
  citedLine,
  imageType,
  normalizePath,
  parentOf,
  runnerOf,
  sizeLabel,
  viewOf,
  type FileSource,
} from "../lib/files.js";
import { ago } from "../lib/format.js";
import { useBranchFile, useNow, useProjects, useTask } from "../lib/session.js";
import { PaneHeader, PaneNote } from "./Pane.js";

const BACK =
  "grid size-7 shrink-0 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary";
const DOWNLOAD =
  "inline-flex h-7 shrink-0 items-center rounded-md px-3 text-xs text-fg-tertiary transition-colors hover:bg-surface-2/70 hover:text-fg-primary";
/** Rows of a table shown at once; a longer one says how many more it has. */
const TABLE_ROWS = 1000;
/** Lines of text numbered one by one; a longer file shows as plain text. */
const NUMBERED_LINES = 20_000;

/** Where the path sits: the branch's root, then each folder, each a link but the last. */
function Trail({ source, path }: { source: FileSource; path: string }) {
  const segments = path === "" ? [] : path.split("/");
  const crumb = "text-fg-tertiary hover:text-fg-primary";
  return (
    <nav aria-label="Path" className="flex flex-wrap items-center gap-x-1 text-meta">
      {segments.length === 0 ? (
        <span>Files</span>
      ) : (
        <FileLink source={source} path="" className={crumb}>
          Files
        </FileLink>
      )}
      {segments.map((segment, at) => (
        <Fragment key={segments.slice(0, at + 1).join("/")}>
          <span aria-hidden="true">/</span>
          {at === segments.length - 1 ? (
            <span className="text-fg-secondary">{segment}</span>
          ) : (
            <FileLink source={source} path={segments.slice(0, at + 1).join("/")} className={crumb}>
              {segment}
            </FileLink>
          )}
        </Fragment>
      ))}
    </nav>
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
          The first {TABLE_ROWS} of {body.length} rows
        </p>
      ) : null}
    </div>
  );
}

/** Text with its lines numbered and the cited one marked. */
function TextLines({ text, line }: { text: string; line: number | undefined }) {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const frame =
    "mt-3 overflow-x-auto rounded-lg bg-surface-0/80 p-3 font-mono text-[12px] leading-relaxed text-fg-secondary shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]";
  if (lines.length > NUMBERED_LINES) {
    return <pre className={frame}>{text}</pre>;
  }
  return (
    <pre className={frame}>
      {lines.map((each, at) => (
        <span key={at} className={`flex ${at + 1 === line ? "line-target" : ""}`}>
          <span
            aria-hidden="true"
            className="w-10 shrink-0 pr-3 text-right text-fg-muted select-none"
          >
            {at + 1}
          </span>
          <span className="whitespace-pre">{each === "" ? " " : each}</span>
        </span>
      ))}
    </pre>
  );
}

function Content({
  source,
  file,
  url,
  line,
}: {
  source: FileSource;
  file: Extract<BranchFile, { kind: "file" }>;
  url: string | null;
  line: number | undefined;
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
        board shows.
      </p>
    );
  }
  if (view.kind === "markdown") {
    return (
      <div className="mt-3">
        <Markdown text={view.text} base={{ source, dir: parentOf(file.path) }} line={line} />
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
    return <TextLines text={view.text} line={line} />;
  }
  return (
    <p className="mt-3 text-sm text-fg-secondary">
      {name} is not text ({sizeLabel(file.size)}).
    </p>
  );
}

/** The cited line a file view's address names, after its path or as `?line=`. */
function useCited(splat: string | undefined, search: { line?: number }) {
  // An address made before cited lines were split off still names the line after the path.
  const cited = citedLine(normalizePath(splat ?? "") ?? "");
  return { path: cited.path, line: search.line ?? cited.line };
}

/** What a view of a branch's files says about where it reads, which differs by source. */
interface Place {
  readonly source: FileSource;
  readonly path: string;
  readonly line: number | undefined;
  /** The subtitle before the commit: the task's title, or the project's name and branch. */
  readonly where: string;
  /** The arrow back when the tab came from nowhere on the board. */
  readonly parent: ReactElement;
  /** What a 404 for the path says. */
  readonly missing: string;
  /** What a 503 says, its runner being away. */
  readonly away: string;
  /** Whose runner the read waits on, as in "Reading report.md from the task's runner…". */
  readonly readFrom: string;
}

/** A file or a folder on a branch, as the branch's newest commit has it, at a cited line. */
function BranchFileView({ source, path, line, where, parent, missing, away, readFrom }: Place) {
  const file = useBranchFile(source, path);
  const now = useNow(30_000);
  const data = file.data;
  const content = data?.kind === "file" ? data.content : null;
  // One address serves both the image and the download.
  const url = useFileUrl(content, imageType(path) ?? "application/octet-stream");
  const name = path === "" ? "Files" : (path.split("/").at(-1) ?? path);
  const scroller = useRef<HTMLDivElement>(null);
  // Once the file is shown, bring the cited line into view.
  useEffect(() => {
    if (line !== undefined && data !== undefined) {
      scroller.current?.querySelector(".line-target")?.scrollIntoView({ block: "center" });
    }
  }, [line, data]);

  let body;
  if (data !== undefined) {
    body =
      data.kind === "dir" ? (
        <FolderList source={source} file={data} className="mt-3 space-y-1" />
      ) : (
        <Content source={source} file={data} url={url} line={line} />
      );
  } else if (file.error instanceof ApiError && file.error.status === 404) {
    body = <p className="mt-3 text-sm text-fg-secondary">{missing}</p>;
  } else if (file.error instanceof ApiError && file.error.status === 503) {
    body = <p className="mt-3 text-sm text-fg-secondary">{away}</p>;
  } else if (file.error !== null) {
    body = <p className="mt-3 text-sm text-fg-secondary">{file.error.message}</p>;
  } else {
    body = (
      <PaneNote>
        Reading {name} from {readFrom}…
      </PaneNote>
    );
  }

  return (
    <>
      <PaneHeader
        leading={<BackLink fallback={parent} />}
        title={name}
        subtitle={
          data === undefined
            ? where
            : `${where}${line === undefined ? "" : ` · line ${line}`} · committed by ${data.commit.author} ${ago(data.commit.at, now)} · ${data.commit.id.slice(0, 7)}`
        }
        trailing={
          url === null ? null : (
            <a href={url} download={name} className={DOWNLOAD}>
              Download
            </a>
          )
        }
      />
      <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-4">
        <Trail source={source} path={path} />
        {body}
      </div>
    </>
  );
}

/** A file or a folder on a task's branch. */
export function TaskFileView() {
  const { taskId, _splat } = useParams({ from: "/task/$taskId/files/$" });
  const { path, line } = useCited(_splat, useSearch({ from: "/task/$taskId/files/$" }));
  const task = useTask(taskId);
  const projects = useProjects();
  const title = task.data?.title ?? taskId;
  const project = projects.data?.find((each) => each.slug === task.data?.project);
  return (
    <BranchFileView
      source={{ kind: "task", taskId }}
      path={path}
      line={line}
      where={title}
      parent={
        <Link
          to="/task/$taskId"
          params={{ taskId }}
          aria-label={`Back to the task ${title}`}
          className={BACK}
        >
          ←
        </Link>
      }
      missing={`${path === "" ? "Nothing" : path} is not on task/${taskId} yet.`}
      away={`${runnerOf(project)}, is not connected, so the task's files cannot be read now.`}
      readFrom="the task's runner"
    />
  );
}

/** A file or a folder on a project's default branch. */
export function ProjectFileView() {
  const { slug, _splat } = useParams({ from: "/p/$slug/files/$" });
  const { path, line } = useCited(_splat, useSearch({ from: "/p/$slug/files/$" }));
  const projects = useProjects();
  const project = projects.data?.find((each) => each.slug === slug);
  const name = project?.name ?? slug;
  const branch = project?.defaultBranch;
  if (projects.data !== undefined && project === undefined) {
    return <PaneNote>There is no project {slug}.</PaneNote>;
  }
  return (
    <BranchFileView
      source={{ kind: "project", slug }}
      path={path}
      line={line}
      where={branch === undefined ? name : `${name} · ${branch}`}
      parent={
        <Link
          to="/p/$slug"
          params={{ slug }}
          aria-label={`Back to the project ${name}`}
          className={BACK}
        >
          ←
        </Link>
      }
      missing={
        path === ""
          ? `Nothing on ${branch ?? "the default branch"} yet.`
          : `${path} is not on ${branch ?? "the default branch"}.`
      }
      away={`${runnerOf(project)}, is not connected, so the project's files cannot be read now.`}
      readFrom="the project's runner"
    />
  );
}
