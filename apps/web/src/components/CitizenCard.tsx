import type { Member } from "@stellaris/shared";
import { ago } from "../lib/format.js";
import type { Star, StarState } from "../sky/model.js";
import { CliIcon } from "./CliIcon.js";

interface CitizenCardProps {
  readonly member: Member;
  readonly star: Star;
  /** Where the citizen is: a project's name, or the society. */
  readonly place: string;
  readonly now: number;
}

const STATE: Record<StarState, { label: string; style: string }> = {
  working: { label: "working", style: "bg-emerald-500/15 text-emerald-300" },
  queued: { label: "queued", style: "bg-amber-500/15 text-amber-300" },
  idle: { label: "resting", style: "bg-surface-2 text-fg-tertiary" },
};

function activity(member: Member, star: Star, place: string, now: number): string {
  if (star.state === "working") {
    return `In a turn at ${place}`;
  }
  if (star.state === "queued") {
    return `Queued for ${place}`;
  }
  return member.lastTurnAt === undefined
    ? "No turns yet"
    : `Last turn ${ago(member.lastTurnAt, now)}`;
}

/**
 * Who a citizen is and what it is doing now, beside its star. Everything else, its turns, memory,
 * and model, is in its view, a click on the star away.
 */
export function CitizenCard({ member, star, place, now }: CitizenCardProps) {
  const model = member.lastModel ?? member.model;
  const state = STATE[star.state];
  return (
    <article className="card w-72 p-3.5" aria-label={`${member.name}, ${member.role}`}>
      <header className="flex items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2/70">
          <CliIcon cli={star.cli} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-title truncate">{member.name}</h2>
          <p className="truncate text-meta">
            {member.role}
            {model === undefined ? "" : ` · ${model}`}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${state.style}`}
        >
          {state.label}
        </span>
      </header>
      <p className="mt-2.5 text-sm text-fg-secondary">{activity(member, star, place, now)}</p>
    </article>
  );
}
