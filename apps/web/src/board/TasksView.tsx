import { currentStage, type Member, type Task } from "@stellaris/shared";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { ago } from "../lib/format.js";
import { useMembers, useNow, useProjects, useTasks } from "../lib/session.js";
import { Citizen } from "./Avatar.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { PlanStrip } from "./PlanStrip.js";
import { assigneeOf, groupTasks, PHASES, phaseOf, progressOf, stageName } from "./tasks.js";

/** Groups that end a task keep only their newest few until asked for the rest. */
const FOLDED = 5;

function TaskRow({
  task,
  members,
  now,
}: {
  task: Task;
  members: readonly Member[] | undefined;
  now: number;
}) {
  const phase = phaseOf(task);
  const stage = currentStage(task);
  return (
    <li>
      <Link
        to="/task/$taskId"
        params={{ taskId: task.id }}
        className="block rounded-xl px-3 py-2.5 transition-colors hover:bg-surface-2/50"
      >
        <div className="flex items-baseline gap-2">
          <span className="text-title min-w-0 flex-1 truncate">{task.title}</span>
          <span className="shrink-0 text-meta">{progressOf(task)}</span>
        </div>
        <div className="mt-2">
          <PlanStrip task={task} />
        </div>
        {task.returned === undefined ? null : (
          <p className="mt-1.5 truncate text-xs text-orange-300/90">
            Sent back from {stageName(task, task.returned.from)} by {task.returned.by}{" "}
            {ago(task.returned.at, now)}
          </p>
        )}
        <p className="mt-1.5 truncate text-meta">
          {task.status === "claimed" && phase !== "landing" && stage !== undefined ? (
            <>
              {stage.name} · held by <Citizen name={task.claimedBy ?? ""} members={members} />
            </>
          ) : task.status === "open" && phase !== "landing" && stage !== undefined ? (
            `${stage.name} · waiting for ${assigneeOf(stage)} since ${ago(task.stageSince, now)}`
          ) : phase === "landing" ? (
            `landing task/${task.id} on the default branch`
          ) : (
            `${phase} ${ago(task.updatedAt, now)}`
          )}
        </p>
      </Link>
    </li>
  );
}

/** A project's tasks grouped by where they stand, each with its plan as a strip. */
export function TasksView() {
  const { slug } = useParams({ from: "/p/$slug/tasks" });
  const tasks = useTasks(slug);
  const projects = useProjects();
  const members = useMembers();
  const now = useNow(30_000);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const project = projects.data?.find((candidate) => candidate.slug === slug);
  const groups = groupTasks(tasks.data ?? []);
  const inPlay = groups
    .filter((group) => group.phase !== "done" && group.phase !== "abandoned")
    .reduce((sum, group) => sum + group.tasks.length, 0);

  return (
    <>
      <PaneHeader
        title="Tasks"
        subtitle={`${project?.name ?? slug} · ${inPlay} in play · ${tasks.data?.length ?? 0} in all`}
      />
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {tasks.data === undefined ? (
          <PaneNote>Reading the tasks…</PaneNote>
        ) : groups.length === 0 ? (
          <PaneNote>No tasks in this project yet.</PaneNote>
        ) : (
          groups.map((group) => {
            const ending = group.phase === "done" || group.phase === "abandoned";
            const open = !ending || unfolded.has(group.phase);
            const shown = open ? group.tasks : group.tasks.slice(0, FOLDED);
            return (
              <section key={group.phase} className="mb-3">
                <h3 className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-fg-muted uppercase">
                  {PHASES.find((each) => each.phase === group.phase)?.label} · {group.tasks.length}
                </h3>
                <ul>
                  {shown.map((task) => (
                    <TaskRow key={task.id} task={task} members={members.data} now={now} />
                  ))}
                </ul>
                {shown.length < group.tasks.length ? (
                  <button
                    type="button"
                    onClick={() => setUnfolded(new Set([...unfolded, group.phase]))}
                    className="px-3 pt-1 text-xs text-fg-tertiary hover:text-fg-primary"
                  >
                    Show all {group.tasks.length}
                  </button>
                ) : null}
              </section>
            );
          })
        )}
      </div>
    </>
  );
}
