import { Link } from "@tanstack/react-router";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import {
  NO_ENTITIES,
  splitEntities,
  unknownIds,
  type EntityIndex,
  type EntityKind,
  type MessagePlace,
} from "../lib/entities.js";

/**
 * What each id in the board's text names; the Playground provides it from threads, tasks,
 * proposals, crons, and the messages text has named so far.
 */
export const EntityContext = createContext<EntityIndex>(NO_ENTITIES);

/** Where text reports ids nothing names yet, which the Playground looks up as messages. */
export const NamedIdsContext = createContext<(ids: readonly string[]) => void>(() => {});

export function useEntities(): EntityIndex {
  return useContext(EntityContext);
}

/**
 * The index for a text, which also reports the ids in it nothing names yet, so a message it names
 * reads as one once the board has said where it is.
 */
export function useEntitiesFor(text: string): EntityIndex {
  const index = useEntities();
  const report = useContext(NamedIdsContext);
  useEffect(() => {
    const ids = unknownIds(text, index);
    if (ids.length > 0) {
      report(ids);
    }
  }, [text, index, report]);
  return index;
}

const LINK =
  "text-fg-primary underline decoration-fg-muted underline-offset-2 hover:decoration-fg-primary";

/**
 * A link to a task's, a proposal's, or a thread's view, a cron in the crons view, or a message in
 * its thread or channel, with its full id on hover.
 */
export function EntityLink({
  kind,
  id,
  place,
  className = LINK,
  children,
}: {
  kind: EntityKind;
  id: string;
  /** For a message, where it sits. */
  place?: MessagePlace | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  const title = `${kind} ${id}`;
  if (kind === "message" && place !== undefined) {
    return place.thread === undefined ? (
      <Link
        to="/c/$"
        params={{ _splat: place.channel }}
        search={{ message: id }}
        title={title}
        className={className}
      >
        {children}
      </Link>
    ) : (
      <Link
        to="/thread/$threadId"
        params={{ threadId: place.thread }}
        search={{ message: id }}
        title={title}
        className={className}
      >
        {children}
      </Link>
    );
  }
  if (kind === "task") {
    return (
      <Link to="/task/$taskId" params={{ taskId: id }} title={title} className={className}>
        {children}
      </Link>
    );
  }
  if (kind === "cron") {
    return (
      <Link to="/crons" search={{ cron: id }} title={title} className={className}>
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
  const index = useEntitiesFor(text);
  return (
    <>
      {splitEntities(text, index).map((piece, at) =>
        typeof piece === "string" ? (
          piece
        ) : links ? (
          // The same entity can appear twice in one text, so the position keys it.
          <EntityLink key={`${piece.id}-${at}`} kind={piece.kind} id={piece.id} place={piece.place}>
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
