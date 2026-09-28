import type { AgentBackend, SessionId, TurnResult } from "@stellaris/runner-core";

/**
 * Codex through its app server: a resident JSON-RPC daemon that holds this runner's threads.
 * The protocol is experimental and large; the exec backend is the shipping path until this
 * client is implemented against the generated bindings.
 */
export class CodexAppServerBackend implements AgentBackend {
  readonly kind = "codex" as const;

  newSession(): Promise<SessionId> {
    return Promise.reject(
      new Error("CodexAppServerBackend: not implemented; use CodexExecBackend"),
    );
  }

  runTurn(): Promise<TurnResult> {
    return Promise.reject(
      new Error("CodexAppServerBackend: not implemented; use CodexExecBackend"),
    );
  }
}
