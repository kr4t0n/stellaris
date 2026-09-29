import type { Member, RoleCharter } from "@stellaris/shared";
import { mentionsIn } from "../lib/mentions.js";

/** The `@name` being typed where the caret is: where it starts and what is typed so far. */
export function mentionAt(text: string, caret: number): { start: number; prefix: string } | null {
  const match = /(^|[^\w@])@([a-z0-9-]*)$/.exec(text.slice(0, caret));
  const prefix = match?.[2];
  return prefix === undefined ? null : { start: caret - prefix.length - 1, prefix };
}

/** The text with the mention being typed completed to a name, and where the caret goes next. */
export function completeMention(
  text: string,
  caret: number,
  start: number,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  return {
    text: text.slice(0, start) + inserted + text.slice(caret),
    caret: start + inserted.length,
  };
}

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

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

export function listed(names: readonly string[]): string {
  return LIST.format(names);
}
