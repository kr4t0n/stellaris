import { USER_NAME, type Member } from "@stellaris/shared";
import { CliIcon } from "../components/CliIcon.js";

/** Who wrote something: a citizen's CLI mark, the user, or the board itself. */
export function Avatar({
  name,
  members,
}: {
  name: string;
  members: readonly Member[] | undefined;
}) {
  const cli = members?.find((member) => member.name === name)?.cli ?? null;
  if (cli !== null) {
    return (
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2/80">
        <CliIcon cli={cli} size={16} />
      </span>
    );
  }
  if (name === USER_NAME) {
    return (
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-fg-primary/90 text-[10px] font-semibold text-surface-0">
        you
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2/50 text-xs text-fg-muted"
    >
      ✦
    </span>
  );
}

/** A citizen's name with its CLI mark, inline in a sentence. */
export function Citizen({
  name,
  members,
}: {
  name: string;
  members: readonly Member[] | undefined;
}) {
  const cli = members?.find((member) => member.name === name)?.cli ?? null;
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {cli === null ? null : <CliIcon cli={cli} size={12} />}
      <span className="text-fg-secondary">{name}</span>
    </span>
  );
}

export function displayName(name: string): string {
  return name === USER_NAME ? "you" : name;
}
