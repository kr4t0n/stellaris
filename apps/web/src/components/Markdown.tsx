import { useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { entityOfHref, remarkEntities } from "../lib/entities.js";
import { remarkMentions } from "../lib/mentions.js";
import { EntityLink, useEntities } from "./Entities.js";

/**
 * A link to a task, a proposal, or a thread stays in the playground; any other link leaves in a
 * new tab, without handing it a reference back.
 */
function BoardLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  const entity = entityOfHref(href);
  if (entity !== null) {
    return (
      <EntityLink kind={entity.kind} id={entity.id}>
        {children}
      </EntityLink>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

const COMPONENTS = { a: BoardLink };

/**
 * A message body as markdown. Raw HTML is never rendered and unsafe URLs are dropped, so a message
 * cannot run script in the page that holds the board token. Ids of known tasks, proposals, and
 * threads read as links named by their titles.
 */
export function Markdown({ text }: { text: string }) {
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
  return (
    <div className="board-markdown">
      <ReactMarkdown remarkPlugins={plugins} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
