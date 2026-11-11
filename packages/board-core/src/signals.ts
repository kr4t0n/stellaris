import { OpsSignalSchema, type BoardEvent, type OpsSignal, type Ulid } from "@stellaris/shared";

/**
 * An operations signal the log holds, with its event's id and time. The metrics index hands out
 * the records it keeps, which live as long as the process, so nothing may change one.
 */
export interface SignalRecord {
  readonly id: Ulid;
  readonly ts: string;
  readonly signal: Readonly<OpsSignal>;
}

/**
 * The signal an event logs, as a read of the log gives it; null for any other event, and for a
 * payload the schema refuses. A field appended as undefined is left out, as the log's line leaves
 * it out, so a record kept as its event is appended equals the one read back.
 */
export function signalRecord(event: BoardEvent): SignalRecord | null {
  if (event.type !== "ops.signal") {
    return null;
  }
  const written = Object.fromEntries(
    Object.entries(event.payload).filter(([, value]) => value !== undefined),
  );
  const parsed = OpsSignalSchema.safeParse(written);
  return parsed.success ? { id: event.id, ts: event.ts, signal: parsed.data } : null;
}

/** The newest `limit` of the records, oldest first; all of them for a `limit` of 0, as `slice` gives. */
export function newestSignals(records: readonly SignalRecord[], limit: number): SignalRecord[] {
  return records.slice(-limit);
}

/**
 * The newest `limit` signals among the events, oldest first: what `listSignals` answers for a
 * log, which the metrics index, fed the same events, answers too.
 */
export function signalsIn(events: readonly BoardEvent[], limit: number): SignalRecord[] {
  const records: SignalRecord[] = [];
  for (const event of events) {
    const record = signalRecord(event);
    if (record !== null) {
      records.push(record);
    }
  }
  return newestSignals(records, limit);
}
