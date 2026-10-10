import type { Member, Stage, Task } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { BackLink } from "../components/BackLink.js";
import { Button } from "../components/Button.js";
import { LinkedText } from "../components/Entities.js";
import { Markdown } from "../components/Markdown.js";
import { ApiError } from "../lib/api.js";
import { ago } from "../lib/format.js";
import {
  useMembers,
  useNow,
  useProjects,
  useSession,
  useTask,
  useThreads,
} from "../lib/session.js";
import { Citizen, useDisplayName } from "./Avatar.js";
import { Composer } from "./Composer.js";
import { stageForYou } from "./governance.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { SubjectThread } from "./SubjectThread.js";
import { TaskFiles } from "./TaskFiles.js";
import { Failure, FIELD } from "./ThreadForms.js";
import {
  assigneeOf,
  inPlay,
  isCurrent,
  PHASE_STYLE,
  PHASES,
  phaseOf,
  progressOf,
  stageName,
} from "./tasks.js";

function StageItem({
  stage,
  index,
  task,
  members,
  now,
}: {
  stage: Stage;
  index: number;
  task: Task;
  members: readonly Member[] | undefined;
  now: number;
}) {
  const done = stage.completedBy !== undefined;
  const current = isCurrent(task, stage);
  const last = index === task.stages.length - 1;
  // `holders` is everyone who ever held the stage; only the current stage has a holder now.
  const holder = current && task.status === "claimed" ? task.claimedBy : undefined;
  const earlier = stage.holders.filter((name) => name !== holder && name !== stage.completedBy);
  const returned = task.returned?.from === stage.id ? task.returned : undefined;
  return (
    <li className="relative flex gap-3 pb-4">
      {last ? null : (
        <span aria-hidden="true" className="absolute top-6 bottom-0 left-2.5 w-px bg-line" />
      )}
      <span
        aria-hidden="true"
        className={`relative z-10 grid size-5 shrink-0 place-items-center rounded-full text-[10px] ${
          done
            ? "bg-emerald-400/20 text-emerald-300"
            : current
              ? "bg-fg-primary text-surface-0"
              : "bg-surface-2 text-fg-muted"
        }`}
      >
        {done ? "✓" : index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm ${current ? "font-medium text-fg-primary" : "text-fg-secondary"}`}>
          {stage.name}
          {stage.gate ? (
            <span className="ml-2 rounded-md bg-sky-400/10 px-1.5 py-px text-[11px] text-sky-300">
              gate
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-meta">
          for {assigneeOf(stage)}
          {holder === undefined ? null : (
            <>
              {" · held by "}
              <Citizen name={holder} members={members} />
            </>
          )}
          {stage.completedBy !== undefined && stage.completedAt !== undefined
            ? ` · done by ${stage.completedBy} ${ago(stage.completedAt, now)}`
            : current && task.status === "open"
              ? ` · waiting since ${ago(task.stageSince, now)}`
              : ""}
          {earlier.length > 0 ? ` · held before by ${earlier.join(", ")}` : ""}
          {returned === undefined ? "" : ` · sent back by ${returned.by} ${ago(returned.at, now)}`}
        </p>
      </div>
    </li>
  );
}

/** What finishing a task's last stage sets off, said where the user approves it. */
function landingOf(task: Task): string {
  if (task.onDone === "ghpr") {
    return task.pullRequest === undefined
      ? "It lands through a pull request, and none is linked yet, so the board refuses to finish it."
      : `Approving lands it: the board merges pull request #${task.pullRequest.number} on GitHub.`;
  }
  return task.onDone === "merge"
    ? `Approving lands it: the board merges task/${task.id}.`
    : "Approving finishes the task.";
}

/**
 * Finishes the stage that names the user, as the user, with an optional note for the task's
 * thread; on a task's last stage that is the approval its landing waits for.
 */
function ApproveStage({ task, stage }: { task: Task; stage: Stage }) {
  const { api } = useSession();
  const client = useQueryClient();
  const [note, setNote] = useState("");
  const index = task.stages.findIndex((each) => each.id === stage.id);
  const next = task.stages[index + 1];
  const approve = useMutation({
    mutationFn: () =>
      api.advanceTask({
        task_id: task.id,
        ...(note.trim() === "" ? {} : { note: note.trim() }),
      }),
    onSuccess: async () => {
      setNote("");
      await client.invalidateQueries({ queryKey: ["task", task.id] });
      await client.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  return (
    <form
      aria-label={`Approve ${stage.name}`}
      className="mt-1 mb-4 space-y-2 rounded-lg bg-surface-2/40 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        approve.mutate();
      }}
    >
      <p className="text-sm text-fg-secondary">
        {stage.name} waits on you.{" "}
        {next === undefined ? landingOf(task) : `Approving moves the task on to ${next.name}.`}
      </p>
      <textarea
        value={note}
        rows={2}
        aria-label="Note for the task's thread"
        placeholder="A note for the thread, if any"
        onChange={(event) => setNote(event.target.value)}
        className={FIELD}
      />
      <div className="flex justify-end">
        <Button variant="primary" type="submit" disabled={approve.isPending}>
          {approve.isPending ? "Approving…" : "Approve"}
        </Button>
      </div>
      <Failure error={approve.error} />
    </form>
  );
}

/** A ghpr task's pull request and the merge commit the board will make of it. */
function PullRequest({ task, now }: { task: Task; now: number }) {
  const link = task.pullRequest;
  if (link === undefined) {
    return null;
  }
  const message = [link.subject ?? "The pull request's title", link.body ?? ""]
    .filter((part) => part !== "")
    .join("\n\n");
  return (
    <section aria-label="Pull request" className="mt-5 border-t border-line pt-4">
      <h3 className="text-section">Pull request</h3>
      <p className="mt-2 text-sm">
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="text-fg-primary underline decoration-line underline-offset-2 hover:decoration-fg-tertiary"
        >
          #{link.number} on GitHub
        </a>
        <span className="text-meta">
          {" "}
          · linked by {link.linkedBy} {ago(link.linkedAt, now)}
        </span>
      </p>
      {task.status === "abandoned" && task.onDone === "ghpr" ? (
        <p className="mt-2 text-sm text-fg-secondary">
          {link.closed === undefined
            ? "The task was abandoned, so the board closes the pull request on GitHub."
            : link.closed.ok
              ? `The task was abandoned: ${link.closed.detail}.`
              : `The task was abandoned, and the board could not close the pull request: ${link.closed.detail}.`}
          {link.closed === undefined ? null : (
            <span className="text-meta"> · {ago(link.closed.at, now)}</span>
          )}
        </p>
      ) : (
        <>
          <p className="mt-3 text-caps text-fg-muted">Merges as</p>
          <pre className="mt-1 rounded-lg bg-surface-2/40 p-3 font-mono text-xs whitespace-pre-wrap text-fg-secondary">
            {message}
          </pre>
        </>
      )}
    </section>
  );
}

/** Opens a thread for a task from before tasks opened their own. */
function OpenTaskThread({ taskId }: { taskId: string }) {
  const { api } = useSession();
  const client = useQueryClient();
  const open = useMutation({
    mutationFn: () => api.openThread({ task_id: taskId }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["threads"] });
    },
  });
  return (
    <div className="mt-2 flex items-center gap-3">
      <Button variant="primary" disabled={open.isPending} onClick={() => open.mutate()}>
        {open.isPending ? "Opening…" : "Open its thread"}
      </Button>
      <p className="text-meta">
        {open.error === null
          ? "This task is older than task threads. It closes when the task ends."
          : open.error.message}
      </p>
    </div>
  );
}

/** One task: where it stands, its plan as a timeline, its brief, and its thread with a composer. */
export function TaskView() {
  const { taskId } = useParams({ from: "/task/$taskId" });
  const task = useTask(taskId);
  const threads = useThreads();
  const projects = useProjects();
  const members = useMembers();
  const now = useNow(30_000);
  const displayName = useDisplayName();

  if (task.data === undefined) {
    return (
      <PaneNote>
        {task.error instanceof ApiError && task.error.status === 404
          ? `There is no task ${taskId}.`
          : "Reading the task…"}
      </PaneNote>
    );
  }
  const current = task.data;
  const phase = phaseOf(current);
  const yours = stageForYou(current);
  const project = projects.data?.find((candidate) => candidate.slug === current.project);
  const thread = threads.data?.find((candidate) => candidate.id === current.id);
  return (
    <>
      <PaneHeader
        leading={
          <BackLink
            fallback={
              <Link
                to="/p/$slug/tasks"
                params={{ slug: current.project }}
                aria-label={`Back to the tasks of ${project?.name ?? current.project}`}
                className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary"
              >
                ←
              </Link>
            }
          />
        }
        title={current.title}
        subtitle={`${project?.name ?? current.project}${
          current.channel === "general" ? "" : ` #${current.channel}`
        } · ${progressOf(current)} · created by ${displayName(
          current.createdBy,
        )} ${ago(current.createdAt, now)}`}
        trailing={
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${PHASE_STYLE[phase]}`}
          >
            {PHASES.find((each) => each.phase === phase)?.label.toLowerCase()}
          </span>
        }
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <h3 className="text-section">Plan</h3>
        {current.returned === undefined ? null : (
          <p className="mt-2 rounded-lg bg-orange-500/10 px-3 py-2 text-xs leading-relaxed text-orange-200">
            Sent back from {stageName(current, current.returned.from)} by {current.returned.by}{" "}
            {ago(current.returned.at, now)}. The work is redone from{" "}
            {stageName(current, current.stage)} until it reaches that stage again.
          </p>
        )}
        <ol className="mt-3">
          {current.stages.map((stage, index) => (
            <StageItem
              key={stage.id}
              stage={stage}
              index={index}
              task={current}
              members={members.data}
              now={now}
            />
          ))}
        </ol>
        {yours === null ? null : <ApproveStage task={current} stage={yours} />}
        <p className="text-meta">
          When the last stage is done:{" "}
          {current.onDone === "merge"
            ? `task/${current.id} merges onto the default branch`
            : current.onDone === "ghpr"
              ? current.pullRequest === undefined
                ? "its pull request merges on GitHub, once one is linked"
                : `pull request #${current.pullRequest.number} merges on GitHub`
              : "nothing more"}
          {current.blockedBy.length > 0 ? (
            <>
              {" · blocked by "}
              <LinkedText text={current.blockedBy.join(", ")} />
            </>
          ) : null}
        </p>
        {current.body.trim() === "" ? null : (
          <section className="mt-5 border-t border-line pt-4">
            <h3 className="text-section">Brief</h3>
            <div className="mt-2">
              <Markdown text={current.body} />
            </div>
          </section>
        )}
        <PullRequest task={current} now={now} />
        <TaskFiles task={current} now={now} />
        <section aria-label="Thread" className="mt-5 border-t border-line pt-4">
          <h3 className="text-section">Thread</h3>
          {threads.data === undefined ? null : thread === undefined ? (
            inPlay(current) ? (
              <OpenTaskThread taskId={current.id} />
            ) : (
              <p className="mt-2 text-meta">No thread on this task.</p>
            )
          ) : (
            <SubjectThread
              thread={thread}
              now={now}
              task={current}
              empty="Nothing said yet. Each stage's handover lands here, and so does anything written below."
            />
          )}
        </section>
      </div>
      {thread?.state === "open" ? (
        <Composer target={{ threadId: current.id }} placeholder="Write in the task's thread" />
      ) : null}
    </>
  );
}
