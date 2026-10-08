import { Link } from "@tanstack/react-router";
import { createContext, useMemo, type ReactNode } from "react";
import { imageType, type FileBase } from "../lib/files.js";
import { useTaskFile } from "../lib/session.js";

const LINK =
  "text-fg-primary underline decoration-fg-muted underline-offset-2 hover:decoration-fg-primary";

/** Where the markdown being rendered sits on a task's branch, for its relative links and images. */
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

/** A link to a file or a folder on a task's branch, with its path on hover. */
export function TaskFileLink({
  taskId,
  path,
  className = LINK,
  children,
}: {
  taskId: string;
  path: string;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Link
      to="/task/$taskId/files/$"
      params={{ taskId, _splat: path }}
      title={`${path === "" ? "The files" : path} on task/${taskId}`}
      className={className}
    >
      {children}
    </Link>
  );
}

/** An image on a task's branch, read through the board and linked to its file's view. */
export function TaskImage({ taskId, path, alt }: { taskId: string; path: string; alt: string }) {
  const file = useTaskFile(taskId, path);
  const content = file.data?.kind === "file" ? file.data.content : null;
  const url = useFileUrl(content, imageType(path) ?? "application/octet-stream");
  const name = alt === "" ? (path.split("/").at(-1) ?? path) : alt;
  return (
    <TaskFileLink taskId={taskId} path={path}>
      {url === null ? (
        <span className="text-meta">
          {file.isPending ? `Loading ${name}…` : `${name} cannot be shown here`}
        </span>
      ) : (
        <img src={url} alt={alt} className="max-h-[32rem] max-w-full rounded-lg" />
      )}
    </TaskFileLink>
  );
}
