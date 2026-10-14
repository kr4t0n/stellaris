import {
  addUsage,
  METRICS_WINDOW_MS,
  NameSchema,
  UlidSchema,
  UsageSchema,
  type BoardEvent,
  type CitizenTokens,
  type MetricsWindow,
  type TokenUse,
} from "@stellaris/shared";
import { z } from "zod";

/**
 * What a turn's end, `turn.completed` or `turn.failed`, carries as a citizen's turn history reads
 * it. Turns logged before a field was recorded take its default, or leave it out.
 */
export const TurnHistoryPayloadSchema = z.object({
  project: NameSchema,
  thread: UlidSchema.optional(),
  channel: NameSchema.optional(),
  trigger: z.string().default("manual"),
  exitReason: z.string().nullable().default(null),
  costUsd: z.number().default(0),
  usage: UsageSchema.optional(),
  model: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  toolCalls: z.number().int().nonnegative().optional(),
  turnId: UlidSchema.optional(),
});

/**
 * Each citizen's finished turns in a window, the ones its turn history lists, and the tokens of
 * those that counted them. A turn counts by when its end was logged, as the history dates it.
 */
export function tokenUse(
  events: readonly BoardEvent[],
  window: MetricsWindow,
  now: Date,
): TokenUse {
  const span = METRICS_WINDOW_MS[window];
  const since = span === null ? null : now.getTime() - span;
  const rows = new Map<string, CitizenTokens>();
  for (const event of events) {
    if (event.type !== "turn.completed" && event.type !== "turn.failed") {
      continue;
    }
    if (since !== null && Date.parse(event.ts) < since) {
      continue;
    }
    const turn = TurnHistoryPayloadSchema.safeParse(event.payload);
    if (!turn.success) {
      continue;
    }
    const row = rows.get(event.actor) ?? {
      agent: event.actor,
      turns: 0,
      withUsage: 0,
      usage: null,
    };
    const usage = turn.data.usage;
    rows.set(event.actor, {
      agent: event.actor,
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
