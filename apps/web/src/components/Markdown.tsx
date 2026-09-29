import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkMentions } from "../lib/mentions.js";

const PLUGINS = [remarkGfm, remarkMentions];

/** Links leave the playground in a new tab, without handing it a reference back. */
function ExternalLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

const COMPONENTS = { a: ExternalLink };

/**
 * A message body as markdown. Raw HTML is never rendered and unsafe URLs are dropped, so a message
 * cannot run script in the page that holds the board token.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="board-markdown">
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
