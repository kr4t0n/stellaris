import { useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useProjects } from "../lib/session.js";
import { placeName, previousView, useTrail } from "../lib/trail.js";
import { useEntities } from "./Entities.js";

const BACK =
  "grid size-7 shrink-0 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary";

/**
 * A view's back arrow: to the board view this tab came from, named, or, when it came from the sky
 * or from outside, as a link opened in a new tab does, the view's own parent in `fallback`.
 */
export function BackLink({ fallback }: { fallback: ReactElement }) {
  const router = useRouter();
  const index = useRouterState({ select: (state) => state.location.state.__TSR_index });
  const trail = useTrail();
  const entities = useEntities();
  const projects = useProjects();
  const previous = previousView(trail, index);
  if (previous === null) {
    return fallback;
  }
  const name = placeName(previous, {
    entity: (id) => entities.get(id)?.title,
    project: (slug) => projects.data?.find((project) => project.slug === slug)?.name,
  });
  return (
    <button
      type="button"
      onClick={() => router.history.back()}
      aria-label={`Back to ${name}`}
      title={`Back to ${name}`}
      className={BACK}
    >
      ←
    </button>
  );
}
