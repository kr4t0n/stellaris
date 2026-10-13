import vm from "node:vm";
import type { Name } from "@stellaris/shared";
import { mentionsAnywhere, mentionsIn } from "@stellaris/shared/mentions";

/** The longest the board's one thread spends parsing a post for whom it mentions. */
export const MENTION_PARSE_MS = 500;

const context = vm.createContext({});
const call = new vm.Script("work()");

/**
 * What `work` returns, or undefined once it has run for `ms`. V8 stops whatever runs when a vm
 * script's timeout passes, the functions it called included, so a synchronous parse ends there.
 */
export function within<T>(work: () => T, ms: number): T | undefined {
  let result: T | undefined;
  context["work"] = () => {
    result = work();
  };
  try {
    call.runInContext(context, { timeout: ms });
  } catch (error) {
    // Read by its code, since the error may come from another realm than this module's `Error`.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
    ) {
      return undefined;
    }
    throw error;
  } finally {
    context["work"] = undefined;
  }
  return result;
}

/**
 * Whom a post mentions: the names outside code, or every name when telling code apart would hold
 * the board longer than `MENTION_PARSE_MS`, which is no worse than before code was told apart.
 */
export function postMentions(body: string): Name[] {
  return within(() => mentionsIn(body), MENTION_PARSE_MS) ?? mentionsAnywhere(body);
}
