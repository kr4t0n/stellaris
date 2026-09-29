import type { Task } from "@stellaris/shared";
import { assigneeOf, isCurrent, phaseOf } from "./tasks.js";

/**
 * A task's plan as a row of segments: done stages filled, the current one lit (amber while it
 * waits for a holder, white while held), the rest dim; a gated stage carries a blue edge.
 */
export function PlanStrip({ task }: { task: Task }) {
  const phase = phaseOf(task);
  return (
    <ol className="flex gap-1" aria-hidden="true">
      {task.stages.map((stage, index) => {
        const done = stage.completedBy !== undefined;
        const current = isCurrent(task, stage);
        const fill = done
          ? "bg-emerald-400/60"
          : current
            ? task.status === "claimed"
              ? "bg-fg-primary/90"
              : "bg-amber-300/80"
            : phase === "abandoned"
              ? "bg-surface-2/50"
              : "bg-surface-2";
        return (
          <li
            key={stage.id}
            title={`${index + 1}. ${stage.name} · ${assigneeOf(stage)}${stage.gate ? " · gate" : ""}`}
            className={`h-1.5 min-w-3 flex-1 rounded-full ${fill} ${
              stage.gate ? "ring-1 ring-sky-300/70 ring-offset-1 ring-offset-surface-1" : ""
            }`}
          />
        );
      })}
    </ol>
  );
}
