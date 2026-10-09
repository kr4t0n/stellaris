import { SOCIETY_SCOPE } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { BackLink } from "../components/BackLink.js";
import { Button } from "../components/Button.js";
import { Markdown } from "../components/Markdown.js";
import { ago } from "../lib/format.js";
import { useKnowledge, useNow, useProjects, useSession } from "../lib/session.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { Failure } from "./ThreadForms.js";

const BACK =
  "grid size-7 shrink-0 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary";

/**
 * One knowledge topic of a project or of the society, in full. Removing it takes a second click,
 * which says what removing does, and returns to the overview that listed it.
 */
export function KnowledgeView() {
  const { scope, topic } = useParams({ from: "/knowledge/$scope/$topic" });
  const { api } = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const knowledge = useKnowledge(scope);
  const projects = useProjects();
  const now = useNow(30_000);
  const [confirming, setConfirming] = useState(false);
  const society = scope === SOCIETY_SCOPE;
  const owner = society
    ? "the society"
    : (projects.data?.find((project) => project.slug === scope)?.name ?? scope);
  const entry = knowledge.data?.find((candidate) => candidate.topic === topic);
  const remove = useMutation({
    mutationFn: () => api.removeKnowledge({ project: society ? null : scope, topic }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["knowledge", scope] });
      await navigate(society ? { to: "/society" } : { to: "/p/$slug", params: { slug: scope } });
    },
  });
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
        leading={<BackLink fallback={back} />}
        title={entry.topic}
        subtitle={`Knowledge of ${owner} · written by ${entry.updatedBy} ${ago(entry.updatedAt, now)}`}
        trailing={confirming ? null : <Button onClick={() => setConfirming(true)}>Remove…</Button>}
      />
      {confirming ? (
        <form
          aria-label="Remove the topic"
          className="space-y-2 border-b border-line bg-surface-2/20 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            remove.mutate();
          }}
        >
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-meta">
              No turn or search finds {entry.topic} again, and a note in{" "}
              {society ? "#general" : `#${scope}/general`} says so without waking anyone. The server
              keeps its text aside.
            </p>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={remove.isPending}>
              {remove.isPending ? "Removing…" : "Remove topic"}
            </Button>
          </div>
          <Failure error={remove.error} />
        </form>
      ) : null}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <Markdown text={entry.body} />
      </div>
    </>
  );
}
