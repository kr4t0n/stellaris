import type { Member } from "@stellaris/shared";
import { PHASE_STYLE, PHASES } from "../board/tasks.js";
import type { TaskMark } from "../sky/model.js";
import { CliIcon } from "./CliIcon.js";

/** A task in play as its mark in the sky shows it: where it stands and who has it. */
export function TaskCard({
  mark,
  project,
  members,
}: {
  mark: TaskMark;
  /** The project's name. */
  project: string;
  members: readonly Member[] | undefined;
}) {
  const cli = members?.find((member) => member.name === mark.holder)?.cli ?? null;
  const label = PHASES.find((each) => each.phase === mark.phase)?.label ?? mark.phase;
  return (
    <article className="card w-72 p-4" aria-label={`Task ${mark.title}`}>
      <header className="flex items-start gap-3">
        <h2 className="text-title min-w-0 flex-1">{mark.title}</h2>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${PHASE_STYLE[mark.phase]}`}
        >
          {label.toLowerCase()}
        </span>
      </header>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-fg-muted">Project</dt>
        <dd className="min-w-0 truncate text-fg-secondary">{project}</dd>
        <dt className="text-fg-muted">Stage</dt>
        <dd className="min-w-0 truncate text-fg-secondary">{mark.stage}</dd>
        {mark.holder !== null ? (
          <>
            <dt className="text-fg-muted">Held by</dt>
            <dd className="flex min-w-0 items-center gap-1 text-fg-secondary">
              {cli === null ? null : <CliIcon cli={cli} size={12} />}
              {mark.holder}
              {mark.linked === null ? " · resting" : " · in a turn on it"}
            </dd>
          </>
        ) : mark.waitingFor !== null ? (
          <>
            <dt className="text-fg-muted">Waiting for</dt>
            <dd className="min-w-0 truncate text-fg-secondary">{mark.waitingFor}</dd>
          </>
        ) : null}
      </dl>
    </article>
  );
}
