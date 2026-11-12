import type { Member, Stage, Task } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { BackLink } from "../components/BackLink.js";
import { LinkedText } from "../components/Entities.js";
import { Markdown } from "../components/Markdown.js";
import { ApiError } from "../lib/api.js";
import { ago, firstParagraph } from "../lib/format.js";
import {
  useMembers,
  useNow,
  useProjects,
  useSession,
  useTask,
  useThread,
  useThreads,
} from "../lib/session.js";
import { Citizen, useDisplayName } from "./Avatar.js";
import { ActionButton, Composer, type ComposerAction } from "./Composer.js";
import { stageForYou } from "./governance.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { PlanStrip } from "./PlanStrip.js";
import { StickyList } from "./StickyList.js";
import { SubjectThread } from "./SubjectThread.js";
import { TaskFileTree, useFilesSummary } from "./TaskFiles.js";
import { Failure } from "./ThreadForms.js";
import {
  assigneeOf,
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
    <div>
      <p className="text-sm">
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
    </div>
  );
}

/** Approve alone, for a stage that waits on the user on a task with no open thread to write in. */
function ApproveAlone({ action }: { action: ComposerAction }) {
  const run = useMutation({ mutationFn: () => action.run("") });
  return (
    <div className="border-t border-line p-3">
      <div className="flex justify-end">
        <ActionButton
          action={action}
          pending={run.isPending}
          disabled={action.blocked !== null || run.isPending}
          onClick={() => run.mutate()}
        />
      </div>
      <Failure error={run.error} />
    </div>
  );
}

type Part = "plan" | "files" | "brief" | "pr";

/**
 * A row of the task's top and what it opens: the button, with what the part is and one line of
 * where it stands, and under it, while open, the part itself as a region named for it.
 */
function Disclosure({
  label,
  summary,
  open,
  onToggle,
  children,
}: {
  label: string;
  summary: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="group flex w-full min-w-0 items-baseline gap-2 rounded-md py-1 text-left hover:bg-surface-2/40"
      >
        <span
          aria-hidden="true"
          className={`inline-block w-2.5 shrink-0 text-[10px] text-fg-muted transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        <span className="w-[4.75rem] shrink-0 text-caps">{label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-tertiary group-hover:text-fg-secondary">
          {summary}
        </span>
      </button>
      {open ? (
        <section id={id} aria-label={label} className="mt-1 mb-2 ml-[18px]">
          {children}
        </section>
      ) : null}
    </>
  );
}

/** Where the task stands, in one line: its stage, the stage's gate, and who it waits on. */
function StageLine({ task, now }: { task: Task; now: number }) {
  const phase = phaseOf(task);
  const stage = task.stages.find((each) => each.id === task.stage);
  if (phase === "done" || phase === "abandoned" || stage === undefined) {
    return <span className="text-sm text-fg-secondary">{progressOf(task)}</span>;
  }
  const yours = stageForYou(task) !== null;
  const who =
    phase === "landing"
      ? "landing"
      : task.status === "claimed" && task.claimedBy !== undefined
        ? `held by ${task.claimedBy}`
        : yours
          ? `waiting on you since ${ago(task.stageSince, now)}`
          : `for ${assigneeOf(stage)} · waiting ${ago(task.stageSince, now)}`;
  return (
    // The stage's name keeps its line, and who it waits on wraps under it where both don't fit.
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span className="min-w-0 truncate text-sm text-fg-primary">
        <span className="text-fg-tertiary">{progressOf(task)} · </span>
        {stage.name}
      </span>
      {stage.gate ? (
        <span className="shrink-0 rounded-md bg-sky-400/10 px-1.5 py-px text-[11px] text-sky-300">
          gate
        </span>
      ) : null}
      <span className={`shrink-0 text-meta ${yours ? "text-amber-200" : ""}`}>{who}</span>
    </span>
  );
}

/** What the task's branch becomes once its last stage is done. */
function landingOf(task: Task): string {
  const link = task.pullRequest;
  if (task.onDone === "merge") {
    return `task/${task.id} merges onto the default branch`;
  }
  if (task.onDone === "ghpr") {
    return link === undefined
      ? "its pull request merges on GitHub, once one is linked"
      : `pull request #${link.number} merges on GitHub`;
  }
  return "nothing more";
}

/**
 * What stays above the thread: the plan's strip and the stage it is at, then a row each for the
 * plan, the files the branch changed, the brief, and a ghpr task's pull request, each opening in
 * place. Every task opens with all of them closed. The top takes at most half the room between the
 * header and the box, past which it scrolls as one, a patch included, so the thread keeps the
 * other half.
 */
function TaskTop({
  task,
  now,
  members,
}: {
  task: Task;
  now: number;
  members: readonly Member[] | undefined;
}) {
  const [open, setOpen] = useState<ReadonlySet<Part>>(new Set());
  const toggle = (part: Part): void =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(part)) {
        next.add(part);
      }
      return next;
    });
  const files = useFilesSummary(task, now);
  const brief = firstParagraph(task.body, 160);
  const link = task.pullRequest;
  return (
    <section
      aria-label="Where the task stands"
      className="max-h-[50%] shrink-0 overflow-y-auto border-b border-line px-4 pt-3 pb-2 [&_[data-patch]]:max-h-none"
    >
      <PlanStrip task={task} />
      <div className="mt-2.5 mb-1.5">
        <StageLine task={task} now={now} />
      </div>
      {task.returned === undefined ? null : (
        <p className="mb-1.5 rounded-lg bg-orange-500/10 px-3 py-1.5 text-xs leading-relaxed text-orange-200">
          Sent back from {stageName(task, task.returned.from)} by {task.returned.by}{" "}
          {ago(task.returned.at, now)}.
        </p>
      )}
      <Disclosure
        label="Plan"
        summary={`${task.stages.length === 1 ? "1 stage" : `${task.stages.length} stages`} · when done, ${
          task.onDone === "merge"
            ? "merges onto the default branch"
            : task.onDone === "ghpr"
              ? link === undefined
                ? "its pull request merges, once linked"
                : `#${link.number} merges on GitHub`
              : "nothing more"
        }${task.blockedBy.length > 0 ? ` · blocked by ${task.blockedBy.length}` : ""}`}
        open={open.has("plan")}
        onToggle={() => toggle("plan")}
      >
        <ol className="mt-1">
          {task.stages.map((stage, index) => (
            <StageItem
              key={stage.id}
              stage={stage}
              index={index}
              task={task}
              members={members}
              now={now}
            />
          ))}
        </ol>
        <p className="text-meta">
          When the last stage is done: {landingOf(task)}
          {task.blockedBy.length > 0 ? (
            <>
              {" · blocked by "}
              <LinkedText text={task.blockedBy.join(", ")} />
            </>
          ) : null}
        </p>
      </Disclosure>
      <Disclosure
        label="Files"
        summary={files}
        open={open.has("files")}
        onToggle={() => toggle("files")}
      >
        <TaskFileTree task={task} now={now} />
      </Disclosure>
      {brief === "" ? null : (
        <Disclosure
          label="Brief"
          summary={brief}
          open={open.has("brief")}
          onToggle={() => toggle("brief")}
        >
          <Markdown text={task.body} />
        </Disclosure>
      )}
      {task.onDone !== "ghpr" ? null : (
        <Disclosure
          label="Pull request"
          summary={
            link === undefined
              ? "None linked yet"
              : `#${link.number} · ${link.subject ?? "linked"} · by ${link.linkedBy} ${ago(link.linkedAt, now)}`
          }
          open={open.has("pr")}
          onToggle={() => toggle("pr")}
        >
          {link === undefined ? (
            <p className="text-meta">None linked yet.</p>
          ) : (
            <PullRequest task={task} now={now} />
          )}
        </Disclosure>
      )}
    </section>
  );
}

/**
 * Finishing the stage that waits on the user from the thread's box, the box's text as the step's
 * note: Approve at a gate, Advance at any other stage. On a ghpr task's last stage the board
 * refuses it while no pull request is linked, so it waits greyed, the reason in its tooltip; the
 * top's Pull request row says so too.
 */
function useApprove(task: Task | undefined): ComposerAction | undefined {
  const { api } = useSession();
  const client = useQueryClient();
  const stage = task === undefined ? null : stageForYou(task);
  if (task === undefined || stage === null) {
    return undefined;
  }
  const index = task.stages.findIndex((each) => each.id === stage.id);
  const unlinked =
    task.stages[index + 1] === undefined &&
    task.onDone === "ghpr" &&
    task.pullRequest === undefined;
  const label = stage.gate ? "Approve" : "Advance";
  return {
    label,
    title: `${label} ${stage.name}, with what the box holds as its note`,
    blocked: unlinked ? "No pull request linked yet." : null,
    run: async (text) => {
      await api.advanceTask({ task_id: task.id, ...(text === "" ? {} : { note: text }) });
      await client.invalidateQueries({ queryKey: ["task", task.id] });
      await client.invalidateQueries({ queryKey: ["tasks"] });
    },
  };
}

/**
 * One task: the plan's strip and the stage it is at above, the rows that open the plan, the
 * files, the brief and the pull request, then its thread, opening at the newest message and
 * following new ones as a thread does, or at the message a link named, with one box that posts to
 * it or, while a stage waits on the user, finishes the stage.
 */
export function TaskView() {
  const { taskId } = useParams({ from: "/task/$taskId" });
  const { message: target } = useSearch({ from: "/task/$taskId" });
  const task = useTask(taskId);
  const threads = useThreads();
  const projects = useProjects();
  const members = useMembers();
  const now = useNow(30_000);
  const displayName = useDisplayName();
  // A task's thread takes the task's id.
  const messages = useThread(
    threads.data?.some((candidate) => candidate.id === taskId) === true ? taskId : null,
  );
  const approve = useApprove(task.data);

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
        } · created by ${displayName(current.createdBy)} ${ago(current.createdAt, now)}`}
        trailing={
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${PHASE_STYLE[phase]}`}
          >
            {approve === undefined
              ? PHASES.find((each) => each.phase === phase)?.label.toLowerCase()
              : "waiting on you"}
          </span>
        }
      />
      {/* The top and the thread share the room between the header and the box. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Keyed by their subject: the route keeps the view mounted from one task to the next. */}
        <TaskTop key={`top:${current.id}`} task={current} now={now} members={members.data} />
        <StickyList
          key={`${current.id}:${target ?? ""}`}
          stick={target === undefined}
          ids={messages.data?.messages.map((message) => message.id)}
          className="px-4 pb-3"
        >
          <section aria-label="Thread">
            {threads.data === undefined ? null : thread === undefined ? (
              <p className="mt-3 text-meta">No thread on this task.</p>
            ) : (
              <SubjectThread
                thread={thread}
                now={now}
                task={current}
                target={target}
                empty="Nothing said yet."
              />
            )}
          </section>
        </StickyList>
      </div>
      {thread?.state === "open" ? (
        <Composer
          target={{ threadId: current.id }}
          placeholder="Write in the task's thread"
          action={approve}
        />
      ) : approve === undefined ? null : (
        <ApproveAlone action={approve} />
      )}
    </>
  );
}
