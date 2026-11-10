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

/** The runner's words for a turn it could not run, the error that stopped it after them. */
const RUNNER_FAILED = /^the runner could not run the turn: /;

/**
 * The board or a git remote out of the runner's reach, in the words `describeError` gives: fetch's
 * own failures, before an answer or while reading one, and the board answering 5xx or 429.
 */
const UNREACHABLE = /fetch failed|terminated|answered (5\d\d|429):/;

/**
 * What the error's words name, first match wins. A compaction comes before what failed it, so a
 * compaction a limit refused is a compaction. The words are the hub's and the CLIs', as the live
 * board logged them, or as the CLI gave them against a stub.
 */
const WORDS: readonly (readonly [FailureReason, RegExp])[] = [
  // The hub's words for a runner lost under a turn, before its job was sent, or before it was
  // placed, and for a job that never reached its runner.
  [
    "runner_dropped",
    /^runner \S+ (went away|restarted) (during|before) the turn|^the turn never reached runner |^the runner is gone$/,
  ],
  // Claude Code's "automatic compaction failed: …", Codex's "Error running remote compact task: …".
  ["compaction", /automatic compaction failed|remote compact task/],
  // Claude Code's, and Codex's for a context window it ran out of.
  ["context", /Prompt is too long|ran out of room in the model's context window/],
  // Claude Code's plan limits and 429s, Codex's 429 once its own retries ran out.
  ["limit", /usage limit reached|You've hit your \w+ limit|rate limit|Too Many Requests/],
  // Claude Code's sign-in, git's, cloning a workspace with no credential, and Codex's sign-in it
  // could not refresh.
  [
    "auth",
    /Failed to authenticate|Not logged in|could not read Username|Your access token could not be refreshed/,
  ],
  ["model", /unrecognized_model/],
  // The model service turning a request away or cutting it off: Claude Code's 5xx, 529, or 499,
  // and Codex's `serverOverloaded`.
  ["service", /API Error: (5\d\d|499|529)\b|overloaded|Selected model is at capacity/i],
];

/**
 * The one reason a failed turn counts under. A timeout is the turn's limit whatever it was doing;
 * a session the CLI could not resume is that, by the adapter's mark or, before ends carried it,
 * the CLI's words. A turn the runner could not run is `network` when the runner marked it
 * `transient` (`unreachable`) or its words say so, before any other words, which a board's answer
 * may hold. Then the error's words decide. A `transient` mark they leave is the adapters', the model
 * service's (the hub's own marks are on words of `runner_dropped`); anything else is `other`.
 */
export function failureReason(end: FailedTurnEnd): FailureReason {
  if (end.exitReason === "timeout") {
    return "timeout";
  }
  const error = end.error ?? "";
  if (end.resumeFailed !== undefined || SESSION_REFUSED.test(error)) {
    return "resume_failed";
  }
  if (RUNNER_FAILED.test(error) && (end.transient === true || UNREACHABLE.test(error))) {
    return "network";
  }
  for (const [reason, words] of WORDS) {
    if (words.test(error)) {
      return reason;
    }
  }
  return end.transient === true ? "service" : "other";
}
