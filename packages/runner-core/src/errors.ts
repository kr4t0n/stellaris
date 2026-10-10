import { inspect } from "node:util";

/**
 * An error with its causes, as far as they go. Node's fetch reports every network failure as
 * "fetch failed" or "terminated" and keeps the reason, a timeout, a reset, or a failed lookup, in
 * `cause`, which `String(error)` leaves out.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(typeof current === "string" ? current : inspect(current));
      break;
    }
    const code = "code" in current && typeof current.code === "string" ? current.code : null;
    const text = String(current);
    parts.push(code === null || text.includes(code) ? text : `${text} (${code})`);
    current = current.cause;
  }
  return parts.join(", caused by ");
}
