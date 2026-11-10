/**
 * Why a turn failed, as `stellaris_turns_failed_total` labels it: a set that stays small and fixed,
 * so a dashboard can name every value.
 */
export const FAILURE_REASONS = [
  "timeout",
  "resume_failed",
  "compaction",
  "context",
  "limit",
  "auth",
  "model",
  "runner_dropped",
  "network",
  "service",
  "other",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** What a failed turn's end says of why, as `finishTurn` logs it. */
export interface FailedTurnEnd {
  readonly exitReason: string | null;
  readonly error: string | null;
  readonly resumeFailed?: string | undefined;
  readonly transient?: boolean | undefined;
}

/** A CLI refusing the session it was handed: Claude Code's words for an id it finds nothing under or will not take. */
const SESSION_REFUSED = /No conversation found with session ID|Invalid session ID/;

/**
 * What the error's words name, first match wins. A compaction comes before what failed it, so a
 * compaction a limit refused is a compaction. The words are the CLIs', the runner's, and the
 * hub's, as the live board logged them.
 */
const WORDS: readonly (readonly [FailureReason, RegExp])[] = [
  // Claude Code's "automatic compaction failed: …", Codex's "Error running remote compact task: …".
  ["compaction", /automatic compaction failed|remote compact task/],
  ["context", /Prompt is too long/],
  // Claude Code's plan limits and 429s, Codex's 429 once its own retries ran out.
  ["limit", /usage limit reached|You've hit your \w+ limit|rate limit|Too Many Requests/],
  // Claude Code's sign-in, and git's, cloning a workspace with no credential.
  ["auth", /Failed to authenticate|Not logged in|could not read Username/],
  ["model", /unrecognized_model/],
  // The hub's words for a runner lost under a turn, or before its job reached it.
  [
    "runner_dropped",
    /^runner \S+ (went away|restarted) during the turn|^the turn never reached runner /,
  ],
  // The runner reaching the board, or git reaching its remote, before the CLI started.
  ["network", /^the runner could not run the turn: .*(fetch failed|terminated)/s],
  // The model service turning a request away or cutting it off: Claude Code's 5xx, 529, or 499,
  // and Codex's `serverOverloaded`.
  ["service", /API Error: (5\d\d|499|529)\b|overloaded|Selected model is at capacity/i],
];

/**
 * The one reason a failed turn counts under. A timeout is the turn's limit whatever it was doing;
 * a session the CLI could not resume is that, by the adapter's mark or, before ends carried it,
 * the CLI's words; then the error's words; then a `transient` mark the words did not explain is the
 * model service's; anything else is `other`.
 */
export function failureReason(end: FailedTurnEnd): FailureReason {
  if (end.exitReason === "timeout") {
    return "timeout";
  }
  const error = end.error ?? "";
  if (end.resumeFailed !== undefined || SESSION_REFUSED.test(error)) {
    return "resume_failed";
  }
  for (const [reason, words] of WORDS) {
    if (words.test(error)) {
      return reason;
    }
  }
  return end.transient === true ? "service" : "other";
}
