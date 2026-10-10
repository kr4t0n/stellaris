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
import { ChannelList, NewChannelForm } from "./ChannelForms.js";
import { CrewList, Section, TopicList } from "./Overview.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { groupTasks, PHASES } from "./tasks.js";
import { Failure, FIELD } from "./ThreadForms.js";

/**
 * Changes the name the board shows for a project, the branch its tasks start from and land on, or
 * both; its slug, which everything refers to it by, stays.
 */
function EditForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const { api } = useSession();
  const client = useQueryClient();
  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.defaultBranch);
  const changes = {
    ...(name.trim() === project.name ? {} : { name: name.trim() }),
    ...(branch.trim() === project.defaultBranch ? {} : { default_branch: branch.trim() }),
  };
  const save = useMutation({
    mutationFn: () => api.configureProject(project.slug, changes),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["projects"] });
      onDone();
    },
  });
  const unchanged = Object.keys(changes).length === 0 || name.trim() === "" || branch.trim() === "";
  return (
    <form
      aria-label={`Edit ${project.slug}`}
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
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
        {/* The field is as wide as its box, so the box sets the width. */}
        <div className="w-36 shrink-0">
          <input
            value={branch}
            maxLength={100}
            spellCheck={false}
            aria-label="Default branch"
            onChange={(event) => setBranch(event.target.value)}
            className={`${FIELD} font-mono`}
          />
        </div>
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={save.isPending || unchanged}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="text-meta">
        {project.slug} stays in its addresses, channels, and branches. A new default branch is where
        tasks start and land from now; its runner makes it from the project's remote, or from where
        the repository stands, before the next turn.
      </p>
      <Failure error={save.error} />
    </form>
  );
}

/**
 * A project at a glance: who works in it, its channels, where its tasks stand, how they end, its
 * dashboard, and what it knows; an archived one also says when and why. Its name and default
 * branch are edited here, and a channel is opened here for a workstream such as a release.
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
  const [editing, setEditing] = useState(false);
  const [opening, setOpening] = useState(false);

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
            {editing || project.archived !== undefined ? null : (
              <Button onClick={() => setEditing(true)}>Edit…</Button>
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
      {editing ? <EditForm project={project} onDone={() => setEditing(false)} /> : null}
      {opening ? <NewChannelForm project={slug} onDone={() => setOpening(false)} /> : null}
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {project.archived === undefined ? null : (
          <p className="rounded-lg bg-surface-2/40 px-3 py-2 text-sm text-fg-secondary">
            Archived {ago(project.archived.at, now)} by {project.archived.by}:{" "}
            {project.archived.reason}. Its channels, tasks, and history stay readable here; nothing
            more is posted, filed, or joined.
          </p>
        )}
        <Section
          title="Channels"
          aside={
            project.archived === undefined && !opening ? (
              <Button onClick={() => setOpening(true)}>New channel…</Button>
            ) : null
          }
        >
          <ChannelList
            channels={(channels.data ?? []).filter((channel) => channel.project === slug)}
            now={now}
          />
        </Section>
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
              : project.onDone === "ghpr"
                ? `When its last stage is done, the board merges the pull request linked to it into ${project.defaultBranch} on GitHub.`
                : "When its last stage is done, it is done; nothing is merged."}
          </p>
        </Section>
        <Section
          title="Dashboard"
          aside={
            dashboard.data?.updatedBy === undefined ? undefined : (
              <span className="text-meta">
                by {dashboard.data.updatedBy}
                {dashboard.data.updatedAt === undefined
                  ? ""
                  : ` ${ago(dashboard.data.updatedAt, now)}`}
              </span>
            )
          }
        >
          {dashboard.data === undefined ? (
            <p className="text-meta">Reading…</p>
          ) : body === "" ? (
            <p className="text-meta">
              Empty. The project's members fill it in with update_dashboard.
            </p>
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
