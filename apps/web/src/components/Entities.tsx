import { Link } from "@tanstack/react-router";
import { createContext, useContext, type ReactNode } from "react";
import { NO_ENTITIES, splitEntities, type EntityIndex, type EntityKind } from "../lib/entities.js";

/** What each id in the board's text names; the Playground provides it from threads and proposals. */
export const EntityContext = createContext<EntityIndex>(NO_ENTITIES);

export function useEntities(): EntityIndex {
  return useContext(EntityContext);
}

const LINK =
  "text-fg-primary underline decoration-fg-muted underline-offset-2 hover:decoration-fg-primary";

/** A link to a task's, a proposal's, or a thread's view, with its full id on hover. */
export function EntityLink({
  kind,
  id,
  className = LINK,
  children,
}: {
  kind: EntityKind;
  id: string;
  className?: string | undefined;
  children: ReactNode;
}) {
  const title = `${kind} ${id}`;
  if (kind === "task") {
    return (
      <Link to="/task/$taskId" params={{ taskId: id }} title={title} className={className}>
        {children}
      </Link>
    );
  }
  if (kind === "proposal") {
    return (
      <Link
        to="/proposal/$proposalId"
        params={{ proposalId: id }}
        title={title}
        className={className}
      >
        {children}
      </Link>
    );
  }
  return (
    <Link to="/thread/$threadId" params={{ threadId: id }} title={title} className={className}>
      {children}
    </Link>
  );
}

/**
 * Plain text with every known id read as what it names: a link to it, or with `links` off, for
 * text already inside a link, just its title.
 */
export function LinkedText({ text, links = true }: { text: string; links?: boolean }) {
  const index = useEntities();
  return (
    <>
      {splitEntities(text, index).map((piece, at) =>
        typeof piece === "string" ? (
          piece
        ) : links ? (
          // The same entity can appear twice in one text, so the position keys it.
          <EntityLink key={`${piece.id}-${at}`} kind={piece.kind} id={piece.id}>
            {piece.title}
          </EntityLink>
        ) : (
          <span key={`${piece.id}-${at}`} title={`${piece.kind} ${piece.id}`}>
            {piece.title}
          </span>
        ),
      )}
    </>
  );
}
