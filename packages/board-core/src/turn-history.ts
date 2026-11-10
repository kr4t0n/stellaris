import {
  addUsage,
  HeartbeatCauseSchema,
  NameSchema,
  UlidSchema,
  UsageSchema,
  type BoardEvent,
  type CitizenTokens,
  type MetricsWindow,
  type TokenUse,
  type Usage,
} from "@stellaris/shared";
import { z } from "zod";
import { windowStart } from "./metrics.js";

/**
 * What a turn's end, `turn.completed` or `turn.failed`, carries as a citizen's turn history reads
 * it. Turns logged before a field was recorded take its default, or leave it out.
 */
export const TurnHistoryPayloadSchema = z.object({
  project: NameSchema,
  thread: UlidSchema.optional(),
  channel: NameSchema.optional(),
  place: NameSchema.optional(),
  trigger: z.string().default("manual"),
  // One a later board added reads as none, so the turn stays in the history.
  heartbeat: HeartbeatCauseSchema.optional().catch(undefined),
  exitReason: z.string().nullable().default(null),
  costUsd: z.number().default(0),
  usage: UsageSchema.optional(),
  model: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  toolCalls: z.number().int().nonnegative().optional(),
  boardActions: z.number().int().nonnegative().optional(),
  turnId: UlidSchema.optional(),
});

/** A finished turn as `tokenUse` counts it: whose it was, and the tokens it counted, if any. */
export interface TokenEnd {
  readonly agent: string;
  readonly usage: Usage | undefined;
}

/**
 * The finished turn an event logs, read as the turn history reads it; null for any other event,
 * and for an end the history cannot read.
 */
export function tokenEnd(event: BoardEvent): TokenEnd | null {
  if (event.type !== "turn.completed" && event.type !== "turn.failed") {
    return null;
  }
  const turn = TurnHistoryPayloadSchema.safeParse(event.payload);
  return turn.success ? { agent: event.actor, usage: turn.data.usage } : null;
}

/**
 * Each citizen's finished turns in a window, the ones its turn history lists, and the tokens of
 * those that counted them. A turn counts by when its end was logged, as the history dates it.
 */
export function tokenUse(
  events: readonly BoardEvent[],
  window: MetricsWindow,
  now: Date,
): TokenUse {
  const since = windowStart(window, now);
  const ends: TokenEnd[] = [];
  for (const event of events) {
    if (since !== null && Date.parse(event.ts) < since) {
      continue;
    }
    const end = tokenEnd(event);
    if (end !== null) {
      ends.push(end);
    }
  }
  return sumTokens(ends, window, now);
}

/**
 * `tokenUse`'s answer from the finished turns in its window, in the log's order, which the log's
 * replay and the metrics index both give it.
 */
export function sumTokens(ends: Iterable<TokenEnd>, window: MetricsWindow, now: Date): TokenUse {
  const since = windowStart(window, now);
  const rows = new Map<string, CitizenTokens>();
  for (const { agent, usage } of ends) {
    const row = rows.get(agent) ?? { agent, turns: 0, withUsage: 0, usage: null };
    rows.set(agent, {
      agent,
      turns: row.turns + 1,
      withUsage: row.withUsage + (usage === undefined ? 0 : 1),
      usage:
        usage === undefined ? row.usage : row.usage === null ? usage : addUsage(row.usage, usage),
    });
  }
  return {
    window,
    since: since === null ? null : new Date(since).toISOString(),
    until: now.toISOString(),
    citizens: [...rows.values()].toSorted((a, b) => a.agent.localeCompare(b.agent)),
  };
}
