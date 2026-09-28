import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import type { Task, TaskStatus } from "@stellaris/shared";
import { useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import { Markdown } from "../components/Markdown.js";
import { Composer, MessageList } from "../components/Messages.js";
import { Button, Empty, ErrorNote, Field, inputClass, Panel, Pill } from "../components/ui.js";
import { shortId, statusTone, timeAgo } from "../lib/format.js";
import { channelRoute, projectRoute, taskRoute } from "../router.js";

const tabClass =
  "rounded px-3 py-1 text-sm text-board-muted hover:text-board-text [&.active]:bg-board-panel [&.active]:text-board-text";

/** The project frame: header, tabs for channels, tasks, and the dashboard, then the active pane. */
export function ProjectPage() {
  const { slug } = projectRoute.useParams();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.project(slug) });
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{project.data?.name ?? slug}</h1>
        <span className="text-xs text-board-muted">
          {project.data?.repo ?? "local repository"} ·{" "}
          {project.data?.members.join(", ") || "no members"}
        </span>
      </header>
      <nav className="flex flex-wrap gap-1 border-b border-board-border pb-2">
        <Link
          to="/projects/$slug"
          params={{ slug }}
          className={tabClass}
          activeOptions={{ exact: true }}
        >
          Overview
        </Link>
        {(project.data?.channels ?? []).map((channel) => (
          <Link
            key={channel}
            to="/projects/$slug/channels/$channel"
            params={{ slug, channel }}
            className={tabClass}
          >
            #{channel}
          </Link>
        ))}
        <Link to="/projects/$slug/tasks" params={{ slug }} className={tabClass}>
          Tasks
        </Link>
        <Link to="/projects/$slug/dashboard" params={{ slug }} className={tabClass}>
          Dashboard
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}

export function ProjectOverview() {
  const { slug } = projectRoute.useParams();
  const tasks = useQuery({ queryKey: ["tasks", slug], queryFn: () => api.tasks(slug) });
  const general = useQuery({
    queryKey: ["channel", `${slug}/general`],
    queryFn: () => api.channel(`${slug}/general`),
  });
  const counts = new Map<TaskStatus, number>();
  for (const task of tasks.data ?? []) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Tasks">
        <div className="flex flex-wrap gap-2">
          {[...counts.entries()].map(([status, count]) => (
            <Pill key={status} className={statusTone(status)}>
              {status} {count}
            </Pill>
          ))}
          {counts.size === 0 ? <Empty>No tasks yet.</Empty> : null}
        </div>
        <TaskTable
          tasks={(tasks.data ?? []).filter(
            (task) => task.status !== "done" && task.status !== "abandoned",
          )}
          slug={slug}
        />
      </Panel>
      <Panel title="#general, latest">
        <MessageList messages={(general.data ?? []).slice(-5).toReversed()} />
        <Composer channel={`${slug}/general`} />
      </Panel>
    </div>
  );
}

export function ChannelPane() {
  const { slug, channel } = channelRoute.useParams();
  const ref = `${slug}/${channel}`;
  const messages = useQuery({ queryKey: ["channel", ref], queryFn: () => api.channel(ref) });
  return (
    <Panel title={`#${channel}`}>
      <ErrorNote error={messages.error} />
      <MessageList messages={(messages.data ?? []).toReversed()} />
      <Composer channel={ref} />
    </Panel>
  );
}

function TaskTable({ tasks, slug }: { tasks: readonly Task[]; slug: string }) {
  if (tasks.length === 0) return null;
  return (
    <table className="mt-3 w-full text-left text-sm">
      <thead className="text-xs uppercase tracking-wide text-board-muted">
        <tr>
          <th className="py-1 pr-2">Task</th>
          <th className="py-1 pr-2">Status</th>
          <th className="py-1 pr-2">Claimed by</th>
          <th className="py-1">Updated</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => (
          <tr key={task.id} className="border-t border-board-border">
            <td className="py-1.5 pr-2">
              <Link
                to="/projects/$slug/tasks/$taskId"
                params={{ slug, taskId: task.id }}
                className="text-board-accent hover:underline"
              >
                {task.title}
              </Link>
              <span className="ml-2 text-xs text-board-muted">{shortId(task.id)}</span>
            </td>
            <td className="py-1.5 pr-2">
              <Pill className={statusTone(task.status)}>{task.status}</Pill>
            </td>
            <td className="py-1.5 pr-2 text-board-muted">{task.claimedBy ?? "—"}</td>
            <td className="py-1.5 text-board-muted">{timeAgo(task.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TasksPane() {
  const { slug } = projectRoute.useParams();
  const queryClient = useQueryClient();
  const tasks = useQuery({ queryKey: ["tasks", slug], queryFn: () => api.tasks(slug) });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const create = useMutation({
    mutationFn: () => api.verb("create_task", { project: slug, title, body }),
    onSuccess: () => {
      setTitle("");
      setBody("");
      void queryClient.invalidateQueries({ queryKey: ["tasks", slug] });
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (title.trim().length > 0) create.mutate();
  };
  const sorted = (tasks.data ?? []).toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return (
    <div className="space-y-4">
      <Panel title={`Tasks (${sorted.length})`}>
        {sorted.length === 0 ? (
          <Empty>No tasks yet.</Empty>
        ) : (
          <TaskTable tasks={sorted} slug={slug} />
        )}
      </Panel>
      <Panel title="New task">
        <form onSubmit={submit} className="flex flex-col gap-2">
          <Field label="Title">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Body (markdown)">
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={4}
              className={`${inputClass} font-mono`}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              tone="primary"
              disabled={create.isPending || title.trim().length === 0}
            >
              Create task
            </Button>
            <ErrorNote error={create.error} />
          </div>
        </form>
      </Panel>
    </div>
  );
}

export function TaskPane() {
  const { slug, taskId } = taskRoute.useParams();
  const queryClient = useQueryClient();
  const task = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId) });
  const thread = useQuery({ queryKey: ["thread", taskId], queryFn: () => api.thread(taskId) });
  const act = useMutation({
    mutationFn: (action: "open_thread" | "done" | "abandon" | "changes") => {
      switch (action) {
        case "open_thread":
          return api.verb("open_thread", { task_id: taskId });
        case "done":
          return api.verb("update_task", { task_id: taskId, status: "done" });
        case "changes":
          return api.verb("update_task", {
            task_id: taskId,
            status: "claimed",
            note: "changes requested by the owner",
          });
        case "abandon":
          return api.verb("update_task", { task_id: taskId, status: "abandoned" });
        default:
          return Promise.reject(new Error(`unknown action ${String(action)}`));
      }
    },
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const current = task.data;
  return (
    <div className="space-y-4">
      <Panel
        title={current === undefined ? "Task" : current.title}
        actions={
          current === undefined ? null : (
            <>
              <Pill className={statusTone(current.status)}>{current.status}</Pill>
              {current.thread === "none" ? (
                <Button onClick={() => act.mutate("open_thread")}>Open thread</Button>
              ) : null}
              {current.status === "in_review" ? (
                <>
                  <Button tone="primary" onClick={() => act.mutate("done")}>
                    Approve (done)
                  </Button>
                  <Button onClick={() => act.mutate("changes")}>Request changes</Button>
                </>
              ) : null}
              {current.status === "open" || current.status === "claimed" ? (
                <Button tone="danger" onClick={() => act.mutate("abandon")}>
                  Abandon
                </Button>
              ) : null}
            </>
          )
        }
      >
        <ErrorNote error={task.error ?? act.error} />
        {current === undefined ? null : (
          <>
            <div className="mb-3 flex flex-wrap gap-3 text-xs text-board-muted">
              <span>id {current.id}</span>
              <span>created by @{current.createdBy}</span>
              <span>claimed by {current.claimedBy ?? "nobody"}</span>
              {current.leaseExpiresAt === undefined ? null : (
                <span>lease until {new Date(current.leaseExpiresAt).toLocaleTimeString()}</span>
              )}
              <span>thread {current.thread}</span>
              {current.blockedBy.length > 0 ? (
                <span>blocked by {current.blockedBy.map(shortId).join(", ")}</span>
              ) : null}
            </div>
            <Markdown>{current.body.length > 0 ? current.body : "_No description._"}</Markdown>
          </>
        )}
      </Panel>
      <Panel title="Thread">
        <MessageList
          messages={thread.data ?? []}
          emptyText={
            current?.thread === "none"
              ? "No thread yet. Open one to discuss this task."
              : "No messages in this thread."
          }
        />
        {current?.thread === "open" ? (
          <Composer
            channel={`${slug}/general`}
            threadId={taskId}
            placeholder="Reply in the thread."
          />
        ) : null}
      </Panel>
    </div>
  );
}

export function DashboardPane() {
  const { slug } = projectRoute.useParams();
  const dashboard = useQuery({ queryKey: ["dashboard", slug], queryFn: () => api.dashboard(slug) });
  return (
    <Panel title="Dashboard">
      <ErrorNote error={dashboard.error} />
      {dashboard.data === undefined ? null : dashboard.data.body.trim().length === 0 ? (
        <Empty>No dashboard yet. Agents may write one at the project's dashboard file.</Empty>
      ) : (
        <Markdown>{dashboard.data.body}</Markdown>
      )}
    </Panel>
  );
}
