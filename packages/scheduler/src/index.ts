import type { Name } from "@stellaris/shared";

/** What caused a wake to be considered. Mentions and claim events wake; subscriptions never do. */
export type TriggerKind =
  | "mention"
  | "claim_event"
  | "heartbeat"
  | "unclaimed_task"
  | "reflection"
  | "onboarding"
  | "manual";

export interface Trigger {
  readonly kind: TriggerKind;
  readonly from?: Name | undefined;
  readonly fromOwner?: boolean | undefined;
}

export interface WakeInput {
  readonly trigger: Trigger;
  /** Unread items the digest would carry. */
  readonly digestSize: number;
  /** Claims the agent currently holds. */
  readonly claimsHeld: number;
  readonly paused: boolean;
}

export interface WakeDecision {
  readonly wake: boolean;
  readonly reason: string;
  /** 2 jumps the queue, 1 is normal, 0 is background. */
  readonly priority: 0 | 1 | 2;
}

/** Timings the plan leaves open; defaults to tune once the first society has run. */
export const DEFAULT_TIMINGS = Object.freeze({
  debounceMs: 30_000,
  ownerDebounceMs: 5_000,
  heartbeatMs: 15 * 60_000,
  leaseMs: 30 * 60_000,
  unclaimedTaskMs: 10 * 60_000,
  reflectionMs: 24 * 60 * 60_000,
});

/**
 * The wake rule from PLAN.md section 6.1. Pure, so it is testable without a board:
 * the pause switch wins, owner mentions jump the queue, and an empty digest never wakes anyone
 * except for reflection, onboarding, owner mentions, and manual wakes.
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
      return trigger.fromOwner === true
        ? { wake: true, reason: "owner mention", priority: 2 }
        : { wake: true, reason: "mention", priority: 1 };
    case "onboarding":
      return { wake: true, reason: "onboarding turn", priority: 1 };
    case "reflection":
      return { wake: true, reason: "scheduled reflection", priority: 0 };
    case "claim_event":
      return { wake: true, reason: "claim event", priority: 1 };
    case "unclaimed_task":
      return { wake: true, reason: "unclaimed task", priority: 0 };
    case "heartbeat":
      break;
  }
  if (input.digestSize === 0 && input.claimsHeld === 0) {
    return { wake: false, reason: "empty digest", priority: 0 };
  }
  return { wake: true, reason: "heartbeat with unread items or held claims", priority: 0 };
}
