import { Link, useParams } from "@tanstack/react-router";
import { Markdown } from "../components/Markdown.js";
import {
  useDashboard,
  useKnowledge,
  useMembers,
  useNow,
  useProjects,
  useTasks,
} from "../lib/session.js";
import { CrewList, Section, TopicList } from "./Overview.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { groupTasks, PHASES } from "./tasks.js";

/** A project at a glance: who works in it, where its tasks stand, how they end, its dashboard, and what it knows. */
export function ProjectView() {
  const { slug } = useParams({ from: "/p/$slug" });
  const projects = useProjects();
  const members = useMembers();
  const tasks = useTasks(slug);
  const dashboard = useDashboard(slug);
  const knowledge = useKnowledge(slug);
  const now = useNow(30_000);

  const project = projects.data?.find((candidate) => candidate.slug === slug);
  if (project === undefined) {
    return (
      <PaneNote>
        {projects.data === undefined ? "Reading the project…" : `There is no project ${slug}.`}
      </PaneNote>
    );
  }
  const crew = (members.data ?? []).filter(
    (member) => member.status === "active" && project.members.includes(member.name),
  );
  const groups = groupTasks(tasks.data ?? []);
  const body = dashboard.data?.body.trim() ?? "";

  return (
    <>
      <PaneHeader
        title={project.name}
        subtitle={`${slug} · ${project.repo ?? "a local repository"} · ${project.defaultBranch}`}
        trailing={
          <Link
            to="/p/$slug/tasks"
            params={{ slug }}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary"
          >
            Tasks →
          </Link>
        }
      />
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <Section title="Members">
          <CrewList members={crew} scope={slug} />
        </Section>
        <Section title="Tasks">
          {tasks.data === undefined ? (
            <p className="text-meta">Reading…</p>
          ) : groups.length === 0 ? (
            <p className="text-meta">No tasks yet.</p>
          ) : (
            <Link to="/p/$slug/tasks" params={{ slug }} className="flex flex-wrap gap-1.5">
              {groups.map((group) => (
                <span
                  key={group.phase}
                  className="rounded-md bg-surface-2/60 px-2 py-0.5 text-xs text-fg-secondary"
                >
                  {group.tasks.length}{" "}
                  {PHASES.find((each) => each.phase === group.phase)?.label.toLowerCase()}
                </span>
              ))}
            </Link>
          )}
        </Section>
        <Section title="How a task ends">
          <p className="text-sm text-fg-secondary">
            {project.onDone === "merge"
              ? `When its last stage is done, the board merges task/<id> onto ${project.defaultBranch}.`
              : "When its last stage is done, it is done; nothing is merged."}
          </p>
          {project.defaultPlan.length === 0 ? (
            <p className="mt-2 text-meta">
              No default plan: each task is planned when it is filed.
            </p>
          ) : (
            <ol className="mt-2 space-y-1">
              {project.defaultPlan.map((stage, index) => (
                <li key={`${index}-${stage.name}`} className="flex items-center gap-2 text-sm">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-2 text-[10px] text-fg-muted">
                    {index + 1}
                  </span>
                  <span className="text-fg-secondary">{stage.name}</span>
                  <span className="text-meta">
                    for {stage.agent ?? (stage.role === undefined ? "anyone" : `any ${stage.role}`)}
                  </span>
                  {stage.gate ? (
                    <span className="rounded-md bg-sky-400/10 px-1.5 py-px text-[11px] text-sky-300">
                      gate
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </Section>
        <Section title="Dashboard">
          {dashboard.data === undefined ? (
            <p className="text-meta">Reading…</p>
          ) : body === "" ? (
            <p className="text-meta">Empty. Agents on the server's machine may edit it.</p>
          ) : (
            <Markdown text={body} />
          )}
        </Section>
        <Section title="Knowledge">
          <TopicList scope={slug} topics={knowledge.data} now={now} />
        </Section>
      </div>
    </>
  );
}
