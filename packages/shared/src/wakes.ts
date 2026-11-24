import type { Agent } from "./board.js";
import { USER_NAME } from "./roles.js";

/** What the wake rules read of a citizen: its name, whether it is active, and its CLI. */
export type WakeableCitizen = Pick<Agent, "name" | "status" | "cli">;

/** Whether a mention wakes the citizen: it is active and has a CLI to take the turn. */
export function wakesOnMention(citizen: WakeableCitizen): boolean {
  return citizen.status === "active" && citizen.cli !== null;
}

/**
 * Whether a post by the user wakes `desk`, a member of a role charted for `user_post`, given the
 * records of the citizens the post names: unless one of them wakes for it, an active citizen with
 * a CLI who is neither the user nor the desk. A post naming nobody who wakes (a mistyped name, a
 * retired citizen, a package's scope) is the desk's to route, and one naming the desk wakes it
 * once, as the mention. The scheduler's wake, the board's digest and unread counts, and the
 * composer's preview all decide it here.
 */
export function userPostWakesDesk(desk: string, named: readonly WakeableCitizen[]): boolean {
  return !named.some(
    (citizen) => citizen.name !== desk && citizen.name !== USER_NAME && wakesOnMention(citizen),
  );
}
