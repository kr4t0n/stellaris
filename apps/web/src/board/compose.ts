import {
  channelConversation,
  parseChannelRef,
  wakeScope,
  type Member,
  type RoleCharter,
  type RunningTurn,
} from "@stellaris/shared";
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

/**
 * Which of the citizens a post wakes are in a turn of the very conversation it goes to, whose
 * runner delivers it into that turn rather than waking another: the thread's, or for a channel
 * post, in the scope the wake rule gives, that channel's conversation, or the home for general.
 */
export function reachedTurns(
  names: readonly string[],
  members: readonly Member[],
  turns: readonly RunningTurn[],
  place: { readonly channel: string } | { readonly thread: string },
): string[] {
  return names.filter((name) =>
    turns.some((turn) => {
      if (turn.agent !== name || !turn.steerable) {
        return false;
      }
      if ("thread" in place) {
        return turn.thread === place.thread;
      }
      const member = members.find((each) => each.name === name);
      if (member === undefined || turn.thread !== undefined) {
        return false;
      }
      const scope = wakeScope(member, parseChannelRef(place.channel).project);
      return turn.scope === scope && turn.channel === channelConversation(scope, place.channel);
    }),
  );
}

/** The line under the composer: whom sending reaches in a turn under way, and whom it wakes. */
export function wakeLine(reached: readonly string[], woken: readonly string[]): string | null {
  const reaches = reached.length === 0 ? null : `reaches ${listed(reached)} in the turn under way`;
  const wakes = woken.length === 0 ? null : `wakes ${listed(woken)}: a turn each`;
  if (reaches === null && wakes === null) {
    return null;
  }
  return `Sending ${[reaches, wakes].filter((part) => part !== null).join(" and ")}.`;
}

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

export function listed(names: readonly string[]): string {
  return LIST.format(names);
}
