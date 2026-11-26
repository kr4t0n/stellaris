import { ASK_CHANNEL, type Agent } from "./board.js";
import { USER_NAME } from "./roles.js";

/** What the wake rules read of a citizen: its name, whether it is active, and its CLI. */
export type WakeableCitizen = Pick<Agent, "name" | "status" | "cli">;

/** Whether a mention wakes the citizen: it is active and has a CLI to take the turn. */
export function wakesOnMention(citizen: WakeableCitizen): boolean {
  return citizen.status === "active" && citizen.cli !== null;
}

/** Where a post was made, as the front desk's wake reads it. */
export interface PostPlace {
  readonly channel: string | null;
  /** Whether the post is the first message of its thread. */
  readonly opensThread: boolean;
}

/**
 * Whether a post is an ask: the first message of a thread on the society's `asks` channel, which is
 * what the ask box sends. A reply in an ask's thread is no ask.
 */
export function isAsk(place: PostPlace): boolean {
  return place.opensThread && place.channel === ASK_CHANNEL;
}

/**
 * Whether a post by the user wakes `desk`, a member of a role charted for `user_post`, given the
 * records of the citizens the post names and where it was made. An ask (`isAsk`) wakes the desk
 * whatever it names, beside the citizens its mentions wake, since the user asked the front desk.
 * Any other post wakes it unless one of the citizens it names wakes for it, an active citizen with
 * a CLI who is neither the user nor the desk. A post naming nobody who wakes (a mistyped name, a
 * retired citizen, a package's scope) is the desk's to route, and one naming the desk wakes it
 * once, as the mention. The scheduler's wake, the board's digest and unread counts, and the
 * new-thread form's preview all decide it here.
 */
export function userPostWakesDesk(
  desk: string,
  named: readonly WakeableCitizen[],
  place: PostPlace,
): boolean {
  return (
    isAsk(place) ||
    !named.some(
      (citizen) => citizen.name !== desk && citizen.name !== USER_NAME && wakesOnMention(citizen),
    )
  );
}
