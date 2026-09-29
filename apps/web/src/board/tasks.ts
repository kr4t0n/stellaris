import { stageIndex, type Stage, type Task } from "@stellaris/shared";

/** Where a task stands, as the tasks view groups it. */
export type TaskPhase = "waiting" | "working" | "landing" | "done" | "abandoned";

export const PHASES: ReadonlyArray<{ readonly phase: TaskPhase; readonly label: string }> = [
  { phase: "waiting", label: "Waiting for a holder" },
  { phase: "working", label: "Being worked" },
  { phase: "landing", label: "Landing" },
  { phase: "done", label: "Done" },
  { phase: "abandoned", label: "Abandoned" },
];

export function phaseOf(task: Task): TaskPhase {
  if (task.status === "done" || task.status === "abandoned") {
    return task.status;
  }
  if (task.completing) {
    return "landing";
  }
  return task.status === "claimed" ? "working" : "waiting";
}

export function inPlay(task: Task): boolean {
  const phase = phaseOf(task);
  return phase !== "done" && phase !== "abandoned";
}

/** Who may hold a stage, in words: a named citizen, any member of a role, or anyone. */
export function assigneeOf(stage: Stage): string {
  if (stage.agent !== undefined) {
    return stage.agent;
  }
  return stage.role === undefined ? "anyone in the project" : `any ${stage.role}`;
}

/** Tasks grouped by phase in the order the view shows them, each group newest first. */
export function groupTasks(tasks: readonly Task[]): Array<{ phase: TaskPhase; tasks: Task[] }> {
  return PHASES.map(({ phase }) => ({
    phase,
    tasks: tasks
      .filter((task) => phaseOf(task) === phase)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  })).filter((group) => group.tasks.length > 0);
}

/** "Stage 2 of 3", or where the task ended. */
export function progressOf(task: Task): string {
  const phase = phaseOf(task);
  if (phase === "done") {
    return `All ${task.stages.length} stages done`;
  }
  if (phase === "abandoned") {
    return "Abandoned";
  }
  return `Stage ${stageIndex(task, task.stage) + 1} of ${task.stages.length}`;
}
