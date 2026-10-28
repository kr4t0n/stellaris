import { useContext, useMemo, type ReactNode } from "react";
import { uploadedImageId } from "@stellaris/shared";
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { entityOfHref, remarkEntities } from "../lib/entities.js";
import { isCitedPath, linkTarget, rehypeLineTarget, type FileBase } from "../lib/files.js";
import { remarkMentions } from "../lib/mentions.js";
import { EnlargeableImage, INLINE_IMAGE, InsideLinkContext } from "./EnlargeableImage.js";
import { EntityLink, useEntitiesFor } from "./Entities.js";
import { BranchImage, FileBaseContext, FileLink } from "./BranchFile.js";
import { UploadedImage } from "./UploadedImage.js";

/** What a path on a runner's machine reads as: its text, with the path on hover. */
function LocalPath({ href, children }: { href: string | undefined; children?: ReactNode }) {
  return (
    <span title={href === undefined || href === "" ? undefined : `${href}, on a runner's machine`}>
      {children}
    </span>
  );
}

/**
 * A link to a task, a proposal, a thread, a cron, or a message, or to a file on a branch, stays in
 * the playground; any other path on a machine is text, since nothing on the board can
 * open it; and any other link leaves in a new tab, without handing it a reference back. An image
 * inside any of them stays a plain image, so a click on it follows the link alone.
 */
function BoardLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  const base = useContext(FileBaseContext);
  const entity = entityOfHref(href);
  if (entity !== null) {
    return (
      <EntityLink kind={entity.kind} id={entity.id} place={entity.place}>
        <InsideLinkContext value>{children}</InsideLinkContext>
      </EntityLink>
    );
  }
  const target = linkTarget(href, base);
  if (target?.kind === "file") {
    return (
      <FileLink source={target.source} path={target.path} line={target.line}>
        <InsideLinkContext value>{children}</InsideLinkContext>
      </FileLink>
    );
  }
  if (target?.kind === "local") {
    return <LocalPath href={href}>{children}</LocalPath>;
  }
  if (target?.kind === "upload") {
    // An uploaded image shows where a post writes it as an image; a link to one has nowhere to go.
    return <span>{children}</span>;
  }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      <InsideLinkContext value>{children}</InsideLinkContext>
    </a>
  );
}

/**
 * An image on a branch or uploaded to the board shows in place; one elsewhere on a machine is its
 * description.
 */
function BoardImage({ src, alt }: { src?: string | Blob | undefined; alt?: string | undefined }) {
  const base = useContext(FileBaseContext);
  const target = linkTarget(typeof src === "string" ? src : undefined, base);
  if (target?.kind === "file") {
    return <BranchImage source={target.source} path={target.path} alt={alt ?? ""} />;
  }
  if (target?.kind === "upload") {
    return <UploadedImage id={target.id} alt={alt ?? ""} />;
  }
  if (target?.kind === "local") {
    const path = typeof src === "string" ? src : undefined;
    return <LocalPath href={path}>{alt === undefined || alt === "" ? path : alt}</LocalPath>;
  }
  if (typeof src !== "string") {
    return <img alt={alt} className={INLINE_IMAGE} />;
  }
  return <EnlargeableImage src={src} alt={alt ?? ""} />;
}

const COMPONENTS: Components = { a: BoardLink, img: BoardImage };

/**
 * The default refusal of unsafe URLs, which would also refuse `report.md:67` and an uploaded
 * image's `image:<id>` as schemes.
 */
export function urlTransform(url: string): string {
  return isCitedPath(url) || uploadedImageId(url) !== null ? url : defaultUrlTransform(url);
}

/**
 * A message body as markdown. Raw HTML is never rendered and unsafe URLs are dropped, so a message
 * cannot run script in the page that holds the board token. Ids of known tasks, proposals,
 * threads, crons, and messages read as links named by their titles. `base` is where a file sits on its branch,
 * for relative links and images inside it, and `line` a source line to mark as `line-target`.
 */
export function Markdown({
  text,
  base,
  line,
}: {
  text: string;
  base?: FileBase | undefined;
  line?: number | undefined;
}) {
  const index = useEntitiesFor(text);
  // Entities run before mentions, so a title that holds an @name is not marked as a mention.
  const plugins = useMemo(
    (): NonNullable<Options["remarkPlugins"]> => [
      remarkGfm,
      [remarkEntities, { index }],
      remarkMentions,
    ],
    [index],
  );
  const rehypePlugins = useMemo(
    (): NonNullable<Options["rehypePlugins"]> =>
      line === undefined ? [] : [[rehypeLineTarget, { line }]],
    [line],
  );
  // Kept by value, so a caller's fresh object does not re-render every link and image.
  const source = base?.source;
  const kind = source?.kind;
  const id =
    source === undefined ? undefined : source.kind === "task" ? source.taskId : source.slug;
  const dir = base?.dir;
  const at = useMemo((): FileBase | undefined => {
    if (kind === undefined || id === undefined || dir === undefined) {
      return undefined;
    }
    return { source: kind === "task" ? { kind, taskId: id } : { kind, slug: id }, dir };
  }, [kind, id, dir]);
  return (
    <div className="board-markdown">
      <FileBaseContext value={at}>
        <ReactMarkdown
          remarkPlugins={plugins}
          rehypePlugins={rehypePlugins}
          components={COMPONENTS}
          urlTransform={urlTransform}
        >
          {text}
        </ReactMarkdown>
      </FileBaseContext>
    </div>
  );
}
