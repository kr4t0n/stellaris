// Apart from compose.ts, which the ask box loads with the sky, so the markdown parser behind
// `mentionsIn` loads only with the board's views.
import {
  userPostWakesDesk,
  wakesOnMention,
  type Member,
  type PostPlace,
  type RoleCharter,
} from "@stellaris/shared";
import { mentionsIn } from "@stellaris/shared/mentions";

/**
 * Whom sending a post as the user where `place` says wakes, as the scheduler decides it: every
 * active citizen the post mentions, and every active member of a role charted for `user_post`
 * when the post is an ask or names nobody else who wakes (`userPostWakesDesk`). Each wake is a
 * turn.
 */
export function wakesFor(
  text: string,
  members: readonly Member[],
  roles: readonly RoleCharter[],
  place: PostPlace,
): string[] {
  const mentions = mentionsIn(text);
  const named = members.filter((member) => mentions.includes(member.name));
  const active = members.filter(wakesOnMention);
  const frontDesk = active
    .filter(
      (member) =>
        roles.find((role) => role.name === member.role)?.wakeTriggers.includes("user_post") &&
        userPostWakesDesk(member.name, named, place),
    )
    .map((member) => member.name);
  const mentioned = mentions.filter((name) => active.some((member) => member.name === name));
  return [...new Set([...frontDesk, ...mentioned])];
}
