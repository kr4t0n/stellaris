import { SOCIETY_SCOPE } from "@stellaris/shared";
import { Link, useParams } from "@tanstack/react-router";
import { Markdown } from "../components/Markdown.js";
import { ago } from "../lib/format.js";
import { useKnowledge, useNow, useProjects } from "../lib/session.js";
import { PaneHeader, PaneNote } from "./Pane.js";

const BACK =
  "grid size-7 shrink-0 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary";

/** One knowledge topic of a project or of the society, in full. */
export function KnowledgeView() {
  const { scope, topic } = useParams({ from: "/knowledge/$scope/$topic" });
  const knowledge = useKnowledge(scope);
  const projects = useProjects();
  const now = useNow(30_000);
  const society = scope === SOCIETY_SCOPE;
  const owner = society
    ? "the society"
    : (projects.data?.find((project) => project.slug === scope)?.name ?? scope);
  const entry = knowledge.data?.find((candidate) => candidate.topic === topic);
  const back = society ? (
    <Link to="/society" aria-label="Back to the society" className={BACK}>
      ←
    </Link>
  ) : (
    <Link to="/p/$slug" params={{ slug: scope }} aria-label={`Back to ${owner}`} className={BACK}>
      ←
    </Link>
  );

  if (entry === undefined) {
    return (
      <PaneNote>
        {knowledge.data === undefined ? "Reading…" : `${owner} has no topic ${topic}.`}
      </PaneNote>
    );
  }
  return (
    <>
      <PaneHeader
        leading={back}
        title={entry.topic}
        subtitle={`Knowledge of ${owner} · written by ${entry.updatedBy} ${ago(entry.updatedAt, now)}`}
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <Markdown text={entry.body} />
      </div>
    </>
  );
}
