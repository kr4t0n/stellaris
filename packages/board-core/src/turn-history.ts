import {
  addUsage,
  HeartbeatCauseSchema,
  NameSchema,
  UlidSchema,
  UsageSchema,
  type BoardEvent,
  type CitizenTokens,
  type HeartbeatCause,
  type MetricsWindow,
  type TokenUse,
  type TurnHistoryEntry,
  type Ulid,
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
type TurnHistoryPayload = z.infer<typeof TurnHistoryPayloadSchema>;

const TurnStartPayloadSchema = z.object({
  turnId: UlidSchema,
  heartbeat: TurnHistoryPayloadSchema.shape.heartbeat,
});

/** A turn's start as its end pairs with it: when it was logged, and what a heartbeat woke for. */
export interface PairedStart {
  readonly ts: string;
  readonly heartbeat: HeartbeatCause | undefined;
}

/** A finished turn the history lists: its end as the history reads it, and the start it pairs with. */
export interface PairedEnd {
  readonly turn: TurnHistoryPayload;
  readonly start: PairedStart | undefined;
}

/** The end an event logs as the history reads it; null for any other event, and one it cannot read. */
function historyEnd(event: BoardEvent): TurnHistoryPayload | null {
  if (event.type !== "turn.completed" && event.type !== "turn.failed") {
    return null;
  }
  const turn = TurnHistoryPayloadSchema.safeParse(event.payload);
  return turn.success ? turn.data : null;
}

/**
 * Each citizen's turn ends paired with their starts by the turn's id, in the log's order: a start
 * waits for the first end of its citizen's that names its turn, and is replaced by a later start
 * of the same turn. A start gives an end the time it began and what a heartbeat woke for.
 */
export class TurnPairing {
  private readonly starts = new Map<string, Map<string, PairedStart>>();

  /** Takes an event in the log's order; gives the end it logs, paired, or null for any other. */
  add(event: BoardEvent): PairedEnd | null {
    if (event.type === "turn.started") {
      const start = TurnStartPayloadSchema.safeParse(event.payload);
      if (start.success) {
        const waiting = this.starts.get(event.actor) ?? new Map<string, PairedStart>();
        this.starts.set(event.actor, waiting);
        waiting.set(start.data.turnId, { ts: event.ts, heartbeat: start.data.heartbeat });
      }
      return null;
    }
    const turn = historyEnd(event);
    if (turn === null) {
      return null;
    }
    if (turn.turnId === undefined) {
      return { turn, start: undefined };
    }
    const waiting = this.starts.get(event.actor);
    const start = waiting?.get(turn.turnId);
    waiting?.delete(turn.turnId);
    return { turn, start };
  }
}

/** A finished turn's entry in its citizen's history, from its end's event and the start it pairs with. */
function historyEntry(event: BoardEvent, { turn, start }: PairedEnd): TurnHistoryEntry {
  const { heartbeat: ended, ...rest } = turn;
  const heartbeat = ended ?? start?.heartbeat;
  return {
    id: event.id,
    ts: event.ts,
    outcome: event.type === "turn.failed" ? "failed" : "completed",
    ...rest,
    ...(heartbeat === undefined ? {} : { heartbeat }),
    ...(start === undefined ? {} : { startedAt: start.ts }),
  };
}

/**
 * A citizen's finished turns, oldest first, cut to the newest `limit` as `slice(-limit)` cuts, so
 * 0 and NaN give them all: each end the history can read, paired with its start.
 */
export function turnHistoryIn(
  events: readonly BoardEvent[],
  agent: string,
  limit: number,
): TurnHistoryEntry[] {
  const pairing = new TurnPairing();
  const entries: TurnHistoryEntry[] = [];
  for (const event of events) {
    if (event.actor !== agent) {
      continue;
    }
    const ended = pairing.add(event);
    if (ended !== null) {
      entries.push(historyEntry(event, ended));
    }
  }
  return entries.slice(-limit);
}

/** A finished turn as the metrics index keeps it for its citizen's history: its end's id, and its start. */
export interface KeptEnd {
  readonly id: Ulid;
  readonly start: PairedStart | undefined;
}

/** How many ends' lines an ask reads back at a time, parsing each batch before the next read. */
const HISTORY_BATCH = 250;

/**
 * The history entries of the ends the metrics index kept, oldest first, from their events read
 * back from the log by `read` a batch at a time; null when the log no longer holds one of them as
 * an end of the citizen's the history reads, so the caller reads the whole log instead.
 */
export async function entriesOf(
  agent: string,
  ends: readonly KeptEnd[],
  read: (ids: readonly Ulid[]) => Promise<(BoardEvent | null)[]>,
): Promise<TurnHistoryEntry[] | null> {
  const entries: TurnHistoryEntry[] = [];
  for (let from = 0; from < ends.length; from += HISTORY_BATCH) {
    const batch = ends.slice(from, from + HISTORY_BATCH);
    const events = await read(batch.map((end) => end.id));
    for (const [at, kept] of batch.entries()) {
      const event = events[at];
      const turn = event === null || event === undefined ? null : historyEnd(event);
      if (event === null || event === undefined || turn === null || event.actor !== agent) {
        return null;
      }
      entries.push(historyEntry(event, { turn, start: kept.start }));
    }
  }
  return entries;
}

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
  const turn = historyEnd(event);
  return turn === null ? null : { agent: event.actor, usage: turn.usage };
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
