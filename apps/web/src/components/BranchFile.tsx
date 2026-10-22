import type { BranchFile } from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import { createContext, useMemo, type ReactNode } from "react";
import { imageType, sizeLabel, type FileBase, type FileSource } from "../lib/files.js";
import { useBranchFile } from "../lib/session.js";

const LINK =
  "text-fg-primary underline decoration-fg-muted underline-offset-2 hover:decoration-fg-primary";

/** Where the markdown being rendered sits on a branch, for its relative links and images. */
export const FileBaseContext = createContext<FileBase | undefined>(undefined);

/**
 * An address holding a file's bytes, since a request for them needs the board's token, which an
 * `<img>` or a download link cannot send. A data URL rather than an object URL, so nothing has to
 * be let go when the view does.
 */
export function useFileUrl(content: string | null | undefined, type: string): string | null {
  return useMemo(
    () => (content === null || content === undefined ? null : `data:${type};base64,${content}`),
    [content, type],
  );
}

/**
 * A link to a file or a folder on a task's branch or a project's default branch, at a line when
 * one is cited, with its path on hover.
 */
export function FileLink({
  source,
  path,
  line,
  className = LINK,
  children,
}: {
  source: FileSource;
  path: string;
  line?: number | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  const search = line === undefined ? {} : { line };
  const title = `${path === "" ? "The files" : path}${line === undefined ? "" : `:${line}`} on ${source.kind === "task" ? `task/${source.taskId}` : `${source.slug}'s default branch`}`;
  return source.kind === "task" ? (
    <Link
      to="/task/$taskId/files/$"
      params={{ taskId: source.taskId, _splat: path }}
      search={search}
      title={title}
      className={className}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/p/$slug/files/$"
      params={{ slug: source.slug, _splat: path }}
      search={search}
      title={title}
      className={className}
    >
      {children}
    </Link>
  );
}

/** A folder's entries, folders first and each by name, each opening its own view, files with their sizes. */
export function FolderList({
  source,
  file,
  className,
}: {
  source: FileSource;
  file: Extract<BranchFile, { kind: "dir" }>;
  className: string;
}) {
  const entries = file.entries.toSorted((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
  );
  return (
    <ul className={className}>
      {entries.map((entry) => (
        <li key={entry.name} className="flex items-baseline gap-2">
          <FileLink
            source={source}
            path={file.path === "" ? entry.name : `${file.path}/${entry.name}`}
            className="text-sm text-fg-secondary hover:text-fg-primary"
          >
            {entry.kind === "dir" ? `${entry.name}/` : entry.name}
          </FileLink>
          {entry.size === null ? null : <span className="text-meta">{sizeLabel(entry.size)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** An image on a branch, read through the board and linked to its file's view. */
export function BranchImage({
  source,
  path,
  alt,
}: {
  source: FileSource;
  path: string;
  alt: string;
}) {
  const file = useBranchFile(source, path);
  const content = file.data?.kind === "file" ? file.data.content : null;
  const url = useFileUrl(content, imageType(path) ?? "application/octet-stream");
  const name = alt === "" ? (path.split("/").at(-1) ?? path) : alt;
  return (
    <FileLink source={source} path={path}>
      {url === null ? (
        <span className="text-meta">
          {file.isPending ? `Loading ${name}…` : `${name} cannot be shown here`}
        </span>
      ) : (
        <img src={url} alt={alt} className="max-h-[32rem] max-w-full rounded-lg" />
      )}
    </FileLink>
  );
}
