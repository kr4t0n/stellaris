// Apart from compose.ts, which the ask box loads with the sky, so the markdown parser behind
// `mentionsIn` loads only with the board's views.
import type { Member, RoleCharter } from "@stellaris/shared";
import { mentionsIn } from "@stellaris/shared/mentions";

/**
 * Whom sending a post as the user wakes, as the scheduler decides it: every active member of a
 * role charted for `user_post`, and every active citizen the post mentions. Each wake is a turn.
 */
export function wakesFor(
  text: string,
  members: readonly Member[],
  roles: readonly RoleCharter[],
): string[] {
  const active = members.filter((member) => member.status === "active" && member.cli !== null);
  const frontDesk = active
    .filter((member) =>
      roles.find((role) => role.name === member.role)?.wakeTriggers.includes("user_post"),
    )
    .map((member) => member.name);
  const mentioned = mentionsIn(text).filter((name) =>
    active.some((member) => member.name === name),
  );
  return [...new Set([...frontDesk, ...mentioned])];
}
