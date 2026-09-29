import type { Member } from "@stellaris/shared";
import type { ReactNode } from "react";
import { ago, firstParagraph } from "../lib/format.js";
import { CLI_MARKS } from "../lib/marks.js";
import type { Star, StarState } from "../sky/model.js";
import { CliIcon } from "./CliIcon.js";

interface CitizenCardProps {
  readonly member: Member;
  readonly star: Star;
  /** The role charter's purpose, when the role is known. */
  readonly purpose: string | undefined;
  /** Where the citizen is: a project's name, or the society. */
  readonly place: string;
  readonly now: number;
}

const STATE_STYLE: Record<StarState, string> = {
  working: "bg-emerald-500/15 text-emerald-300",
  queued: "bg-amber-500/15 text-amber-300",
  idle: "bg-surface-2 text-fg-tertiary",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg-secondary">{children}</dd>
    </>
  );
}

function activity(member: Member, star: Star, place: string, now: number): string {
  if (star.state === "working") {
    return `In a turn at ${place}`;
  }
  if (star.state === "queued") {
    return `Queued for ${place}`;
  }
  if (member.lastTurnAt === undefined) {
    return "No turns yet";
  }
  const outcome = member.lastTurnOutcome === undefined ? "" : `, ${member.lastTurnOutcome}`;
  return `Last turn ${ago(member.lastTurnAt, now)}${outcome}`;
}

/** Who a citizen is and what it is doing, shown beside its star. */
export function CitizenCard({ member, star, purpose, place, now }: CitizenCardProps) {
  const profile = firstParagraph(member.profile);
  const skills = member.skills.slice(0, 4).join(", ");
  return (
    <article className="card w-76 p-4" aria-label={`${member.name}, ${member.role}`}>
      <header className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-2/70">
          <CliIcon cli={star.cli} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-title truncate">{member.name}</h2>
          <p className="truncate font-mono text-xs text-fg-tertiary">{member.role}</p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATE_STYLE[star.state]}`}
        >
          {star.state}
        </span>
      </header>
      {purpose === undefined ? null : (
        <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-fg-tertiary">{purpose}</p>
      )}
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <Row label="CLI">
          {CLI_MARKS[star.cli].label} ·{" "}
          <span className="font-mono">{member.lastModel ?? member.model ?? "CLI default"}</span>
        </Row>
        <Row label="Now">{activity(member, star, place, now)}</Row>
        {star.resident ? <Row label="Session">warm, kept between turns</Row> : null}
        <Row label="Projects">{member.memberships.join(", ") || "none"}</Row>
        <Row label="Stages">
          {member.claimsHeld} held · {member.tasksDone} done
        </Row>
        {skills === "" ? null : (
          <Row label="Skills">
            {skills}
            {member.skills.length > 4 ? ` +${member.skills.length - 4}` : ""}
          </Row>
        )}
      </dl>
      {profile === "" ? null : (
        <p className="mt-3 line-clamp-3 border-t border-line pt-3 text-xs leading-relaxed text-fg-secondary">
          {profile}
        </p>
      )}
    </article>
  );
}
