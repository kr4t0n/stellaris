import { describe, expect, it } from "vitest";
import { FAILURE_REASONS, failureReason, type FailedTurnEnd } from "./failure-reason.js";

/** A failed end that says only its error, as most ends logged before the marks did. */
function failed(error: string | null, marks: Partial<FailedTurnEnd> = {}): FailedTurnEnd {
  return { exitReason: "error", error, ...marks };
}

/**
 * The shapes of the failed turns on a live board, ids, paths, times, and runner names replaced,
 * with the CLI each came from and the reason it counts under.
 */
const SHAPES: readonly (readonly ["claude" | "codex", FailedTurnEnd, string])[] = [
  ["claude", { exitReason: "timeout", error: null }, "timeout"],
  ["codex", { exitReason: "timeout", error: null, resumeFailed: "retry" }, "timeout"],
  [
    "claude",
    failed(
      "Claude Code process exited with code 1. stderr: Error: Invalid session ID. Must be a valid UUID.",
    ),
    "resume_failed",
  ],
  [
    "claude",
    failed(
      "Claude Code process exited with code 1. stderr: No conversation found with session ID: 3f2a9c1e-0b6d-4e8a-9f7c-2d1b5a6e8c40",
    ),
    "resume_failed",
  ],
  ["codex", failed(null, { resumeFailed: "lost" }), "resume_failed"],
  [
    "claude",
    failed("Claude Code process exited with code 1", { resumeFailed: "retry" }),
    "resume_failed",
  ],
  [
    "claude",
    failed(
      "usage limit reached: API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
    ),
    "limit",
  ],
  [
    "claude",
    failed("usage limit reached: You've hit your weekly limit · resets Nov 12, 9am (UTC)"),
    "limit",
  ],
  [
    "claude",
    failed("usage limit reached: You've hit your session limit · resets 4:10pm (UTC)"),
    "limit",
  ],
  [
    "claude",
    failed(
      "Claude Code returned an error result: You've hit your session limit · resets 4:10pm (UTC)",
    ),
    "limit",
  ],
  [
    "codex",
    failed("exceeded retry limit, last status: 429 Too Many Requests", { transient: true }),
    "limit",
  ],
  ["codex", failed("exceeded retry limit, last status: 429 Too Many Requests"), "limit"],
  [
    "claude",
    failed(
      "Prompt is too long · automatic compaction failed: API Error: 499 Client Closed Request",
    ),
    "compaction",
  ],
  [
    "claude",
    failed(
      "Prompt is too long · automatic compaction failed: API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
    ),
    "compaction",
  ],
  [
    "claude",
    failed(
      "Prompt is too long · automatic compaction failed: Failed to authenticate: OAuth session expired and could not be refreshed",
    ),
    "compaction",
  ],
  [
    "codex",
    failed(
      "Error running remote compact task: Selected model is at capacity. Please try a different model.",
    ),
    "compaction",
  ],
  ["claude", failed("Prompt is too long"), "context"],
  [
    "claude",
    failed(
      "the runner could not run the turn: TypeError: fetch failed, caused by SocketError: other side closed (UND_ERR_SOCKET)",
    ),
    "network",
  ],
  [
    "claude",
    failed(
      "the runner could not run the turn: TypeError: terminated, caused by BodyTimeoutError: Body Timeout Error (UND_ERR_BODY_TIMEOUT)",
      { transient: true },
    ),
    "network",
  ],
  [
    "claude",
    failed(
      "the runner could not run the turn: TypeError: terminated, caused by Error: read ECONNRESET",
    ),
    "network",
  ],
  [
    "codex",
    failed(
      "the runner could not run the turn: TypeError: fetch failed, caused by ConnectTimeoutError: Connect Timeout Error (attempted address: board.example:443, timeout: 10000ms)",
    ),
    "network",
  ],
  [
    "codex",
    failed(
      "the runner could not run the turn: Error: git fetch failed in /work/demo\nfatal: unable to access 'https://github.com/example/demo.git/': CONNECT tunnel failed, response 503",
    ),
    "network",
  ],
  [
    "claude",
    failed(
      "the runner could not run the turn: Error: git fetch failed in /work/demo\nfatal: unable to access 'https://github.com/example/demo.git/': gnutls_handshake() failed: The TLS connection was non-properly terminated.",
    ),
    "network",
  ],
  [
    "claude",
    failed(
      'Claude Code process exited with code 1. stderr: [claude-code:unrecognized_model] {"model":"model-x","query_source":"sdk"}',
    ),
    "model",
  ],
  ["claude", failed("API Error: 499 Client Closed Request"), "service"],
  // Claude Code's words against a stub, in docs/internals/adapters.md.
  [
    "claude",
    failed(
      "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.",
      { transient: true },
    ),
    "service",
  ],
  ["claude", failed("API Error: 500 Internal server error.", { transient: true }), "service"],
  ["codex", failed("Selected model is at capacity. Please try a different model."), "service"],
  [
    "codex",
    failed("Selected model is at capacity. Please try a different model.", { transient: true }),
    "service",
  ],
  // A mark the words do not explain is the model service's, the one `transient` the adapters set.
  ["claude", failed("Request timed out", { transient: true }), "service"],
  ["claude", failed("API Error: Connection dropped (ECONNRESET).", { transient: true }), "service"],
  ["claude", failed("runner runner-1 went away during the turn"), "runner_dropped"],
  ["claude", failed("runner runner-1 restarted during the turn"), "runner_dropped"],
  ["codex", failed("runner runner-1 restarted during the turn"), "runner_dropped"],
  [
    "claude",
    failed("the turn never reached runner runner-1, which went away", { transient: true }),
    "runner_dropped",
  ],
  [
    "claude",
    failed("Failed to authenticate: OAuth session expired and could not be refreshed"),
    "auth",
  ],
  ["claude", failed("Not logged in · Please run /login"), "auth"],
  [
    "claude",
    failed(
      "could not prepare the workspace: Error: git clone --branch main https://github.com/example/demo.git /work/demo failed: Cloning into '/work/demo'...\nfatal: could not read Username for 'https://github.com': No such device or address",
    ),
    "auth",
  ],
  ["claude", failed("Claude Code process exited with code 1"), "other"],
  [
    "claude",
    failed(
      "Claude Code process exited with code 1. stderr: ⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set",
    ),
    "other",
  ],
  [
    "claude",
    failed("the runner could not run the turn: Error: EIO: i/o error, scandir '/work/demo'"),
    "other",
  ],
  ["codex", failed(null), "other"],
];

describe("failureReason", () => {
  it.each(SHAPES)("counts a %s turn's failure under its reason: %j", (_cli, end, reason) => {
    expect(failureReason(end)).toBe(reason);
  });

  it("gives every reason for some shape of both CLIs, and no reason outside the set", () => {
    const given = new Set(SHAPES.map(([, end]) => failureReason(end)));
    expect([...given].toSorted()).toEqual([...FAILURE_REASONS].toSorted());
    for (const cli of ["claude", "codex"]) {
      expect(SHAPES.some(([of]) => of === cli)).toBe(true);
    }
  });
});
