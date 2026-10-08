import { useContext, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { entityOfHref, remarkEntities } from "../lib/entities.js";
import { linkTarget, type FileBase } from "../lib/files.js";
import { remarkMentions } from "../lib/mentions.js";
import { EntityLink, useEntities } from "./Entities.js";
import { FileBaseContext, TaskFileLink, TaskImage } from "./TaskFile.js";

/** What a path on a runner's machine reads as: its text, with the path on hover. */
function LocalPath({ href, children }: { href: string | undefined; children?: ReactNode }) {
  return (
    <span title={href === undefined || href === "" ? undefined : `${href}, on a runner's machine`}>
      {children}
    </span>
  );
}

/**
 * A link to a task, a proposal, or a thread, or to a file on a task's branch, stays in the
 * playground; any other path on a machine is text, since nothing on the board can open it; and any
 * other link leaves in a new tab, without handing it a reference back.
 */
function BoardLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  const base = useContext(FileBaseContext);
  const entity = entityOfHref(href);
  if (entity !== null) {
    return (
      <EntityLink kind={entity.kind} id={entity.id}>
        {children}
      </EntityLink>
    );
  }
  const target = linkTarget(href, base);
  if (target?.kind === "task-file") {
    return (
      <TaskFileLink taskId={target.taskId} path={target.path}>
        {children}
      </TaskFileLink>
    );
  }
  if (target?.kind === "local") {
    return <LocalPath href={href}>{children}</LocalPath>;
  }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/** An image on a task's branch shows in place; one elsewhere on a machine is its description. */
function BoardImage({ src, alt }: { src?: string | Blob | undefined; alt?: string | undefined }) {
  const base = useContext(FileBaseContext);
  const target = linkTarget(typeof src === "string" ? src : undefined, base);
  if (target?.kind === "task-file") {
    return <TaskImage taskId={target.taskId} path={target.path} alt={alt ?? ""} />;
  }
  if (target?.kind === "local") {
    const path = typeof src === "string" ? src : undefined;
    return <LocalPath href={path}>{alt === undefined || alt === "" ? path : alt}</LocalPath>;
  }
  return (
    <img
      src={typeof src === "string" ? src : undefined}
      alt={alt}
      className="max-h-[32rem] max-w-full rounded-lg"
    />
  );
}

const COMPONENTS: Components = { a: BoardLink, img: BoardImage };

/**
 * A message body as markdown. Raw HTML is never rendered and unsafe URLs are dropped, so a message
 * cannot run script in the page that holds the board token. Ids of known tasks, proposals, and
 * threads read as links named by their titles. `base` is where a task's file sits on its branch,
 * for relative links and images inside it.
 */
export function Markdown({ text, base }: { text: string; base?: FileBase | undefined }) {
  const index = useEntities();
  // Entities run before mentions, so a title that holds an @name is not marked as a mention.
  const plugins = useMemo(
    (): NonNullable<Options["remarkPlugins"]> => [
      remarkGfm,
      [remarkEntities, { index }],
      remarkMentions,
    ],
    [index],
  );
  // Kept by value, so a caller's fresh object does not re-render every link and image.
  const taskId = base?.taskId;
  const dir = base?.dir;
  const at = useMemo(
    () => (taskId === undefined || dir === undefined ? undefined : { taskId, dir }),
    [taskId, dir],
  );
  return (
    <div className="board-markdown">
      <FileBaseContext value={at}>
        <ReactMarkdown remarkPlugins={plugins} components={COMPONENTS}>
          {text}
        </ReactMarkdown>
      </FileBaseContext>
    </div>
  );
}
