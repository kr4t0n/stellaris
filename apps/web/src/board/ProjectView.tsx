import type { Project } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { Markdown } from "../components/Markdown.js";
import { ago } from "../lib/format.js";
import {
  useChannels,
  useDashboard,
  useKnowledge,
  useMembers,
  useNow,
  useProjects,
  useSession,
  useTasks,
} from "../lib/session.js";
import { CrewList, Section, TopicList } from "./Overview.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { groupTasks, PHASES } from "./tasks.js";
import { Failure, FIELD } from "./ThreadForms.js";

/** Changes the name the board shows for a project; its slug, which everything refers to it by, stays. */
function RenameForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const { api } = useSession();
  const client = useQueryClient();
  const [name, setName] = useState(project.name);
  const rename = useMutation({
    mutationFn: () => api.renameProject(project.slug, name.trim()),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["projects"] });
      onDone();
    },
  });
  const unchanged = name.trim() === "" || name.trim() === project.name;
  return (
    <form
      aria-label={`Rename ${project.slug}`}
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        rename.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        <input
          value={name}
          maxLength={120}
          aria-label="Project name"
          onChange={(event) => setName(event.target.value)}
          className={`${FIELD} min-w-0 flex-1`}
        />
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={rename.isPending || unchanged}>
          {rename.isPending ? "Saving…" : "Rename"}
        </Button>
      </div>
      <p className="text-meta">
        Only the name shown changes; {project.slug} stays in its addresses, channels, and branches.
      </p>
      <Failure error={rename.error} />
    </form>
  );
}

/**
 * A project at a glance: who works in it, where its tasks stand, how they end, its dashboard, and
 * what it knows; an archived one also says when and why, and lists its channels, which the
 * navigator no longer does.
 */
export function ProjectView() {
  const { slug } = useParams({ from: "/p/$slug" });
  const projects = useProjects();
  const channels = useChannels();
  const members = useMembers();
  const tasks = useTasks(slug);
  const dashboard = useDashboard(slug);
  const knowledge = useKnowledge(slug);
  const now = useNow(30_000);
  const [renaming, setRenaming] = useState(false);

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
          <>
            {renaming || project.archived !== undefined ? null : (
              <Button onClick={() => setRenaming(true)}>Rename…</Button>
            )}
            <Link
              to="/p/$slug/tasks"
              params={{ slug }}
              className="shrink-0 rounded-md px-2 py-1 text-xs text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary"
            >
              Tasks →
            </Link>
          </>
        }
      />
      {renaming ? <RenameForm project={project} onDone={() => setRenaming(false)} /> : null}
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {project.archived === undefined ? null : (
          <p className="rounded-lg bg-surface-2/40 px-3 py-2 text-sm text-fg-secondary">
            Archived {ago(project.archived.at, now)} by {project.archived.by}:{" "}
            {project.archived.reason}. Its channels, tasks, and history stay readable here; nothing
            more is posted, filed, or joined.
          </p>
        )}
        {project.archived === undefined ? null : (
          <Section title="Channels">
            <ul className="space-y-1">
              {(channels.data ?? [])
                .filter((channel) => channel.project === slug)
                .map((channel) => (
                  <li key={channel.ref}>
                    <Link
                      to="/c/$"
                      params={{ _splat: channel.ref }}
                      className="text-sm text-fg-secondary hover:text-fg-primary"
                    >
                      # {channel.name}
                    </Link>
                    <span className="text-meta"> · {channel.messages} messages</span>
                  </li>
                ))}
            </ul>
          </Section>
        )}
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
