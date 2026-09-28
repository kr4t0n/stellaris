import type { AgentBackend, SessionId, TurnResult } from "@stellaris/runner-core";

/**
 * Codex through its app server: a resident JSON-RPC daemon that holds this runner's threads.
 * The generated protocol bindings and the client land in Phase 2.
 */
export class CodexAppServerBackend implements AgentBackend {
  readonly kind = "codex" as const;

  newSession(): Promise<SessionId> {
    return Promise.reject(
      new Error("CodexAppServerBackend.newSession: Phase 2 delivers the app-server client"),
    );
  }

  runTurn(): Promise<TurnResult> {
    return Promise.reject(
      new Error("CodexAppServerBackend.runTurn: Phase 2 delivers the app-server client"),
    );
  }
}

/** The exec fallback: one `codex exec resume` process per turn with JSON output. Same interface, no daemon. */
export class CodexExecBackend implements AgentBackend {
  readonly kind = "codex" as const;

  newSession(): Promise<SessionId> {
    return Promise.reject(
      new Error("CodexExecBackend.newSession: Phase 2 delivers the exec fallback"),
    );
  }

  runTurn(): Promise<TurnResult> {
    return Promise.reject(
      new Error("CodexExecBackend.runTurn: Phase 2 delivers the exec fallback"),
    );
  }
}
