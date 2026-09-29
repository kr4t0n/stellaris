import type { Trigger } from "@stellaris/shared";

export interface WakeInput {
  readonly trigger: Trigger;
  /** Unread items the digest would carry. */
  readonly digestSize: number;
  /** Stages the agent holds. */
  readonly claimsHeld: number;
  /** Current stages without a holder that name the agent or its role. */
  readonly waitingStages: number;
  readonly paused: boolean;
}

export interface WakeDecision {
  readonly wake: boolean;
  readonly reason: string;
  /** 2 jumps the queue, 1 is normal, 0 is background. */
  readonly priority: 0 | 1 | 2;
}

/**
 * Nothing wakes while paused. Every trigger wakes otherwise, except a heartbeat with nothing
 * unread, no held stage, and no stage waiting for the agent or its role; user mentions, user
 * posts, and manual wakes jump the queue.
 */
export function decideWake(input: WakeInput): WakeDecision {
  if (input.paused) {
    return { wake: false, reason: "society paused", priority: 0 };
  }
  const { trigger } = input;
  switch (trigger.kind) {
    case "manual":
      return { wake: true, reason: "manual wake", priority: 2 };
    case "mention":
      return trigger.fromUser
        ? { wake: true, reason: "user mention", priority: 2 }
        : { wake: true, reason: "mention", priority: 1 };
    case "onboarding":
      return { wake: true, reason: "onboarding turn", priority: 1 };
    case "reflection":
      return { wake: true, reason: "scheduled reflection", priority: 0 };
    case "stage":
      return { wake: true, reason: "stage waiting", priority: 1 };
    case "task_done":
      return { wake: true, reason: "task done", priority: 1 };
    case "ops_event":
      return { wake: true, reason: "operations signal", priority: 0 };
    case "user_post":
      return { wake: true, reason: "user post", priority: 2 };
    case "heartbeat":
      break;
  }
  if (input.digestSize === 0 && input.claimsHeld === 0 && input.waitingStages === 0) {
    return { wake: false, reason: "nothing to read, hold, or take", priority: 0 };
  }
  return {
    wake: true,
    reason: "heartbeat with unread items, held stages, or stages waiting",
    priority: 0,
  };
}
