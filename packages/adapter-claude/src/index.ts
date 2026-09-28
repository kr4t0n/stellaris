import type { AgentBackend, SessionId, TurnResult } from "@stellaris/runner-core";

/**
 * Claude Code through the Claude Agent SDK: one SDK call per wakeup, resuming the pair's session.
 * The SDK integration lands in Phase 1; the shape is fixed here so the runner can be wired now.
 */
export class ClaudeAgentBackend implements AgentBackend {
  readonly kind = "claude" as const;

  newSession(): Promise<SessionId> {
    return Promise.reject(
      new Error("ClaudeAgentBackend.newSession: Phase 1 delivers the Agent SDK integration"),
    );
  }

  runTurn(): Promise<TurnResult> {
    return Promise.reject(
      new Error("ClaudeAgentBackend.runTurn: Phase 1 delivers the Agent SDK integration"),
    );
  }
}
