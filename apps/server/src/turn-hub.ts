import type { AgentEvent, Name } from "@stellaris/shared";

/** One agent event as seen by the UI: which agent and project produced it, in a global sequence. */
export interface LiveTurnEvent {
  readonly seq: number;
  readonly ts: string;
  readonly agent: Name;
  readonly project: Name;
  readonly event: AgentEvent;
}

/**
 * In-memory fan-out of live turn events. The runner pushes what its adapters emit; the SSE
 * endpoint replays the recent buffer and then streams. Nothing here is persisted: the board's
 * event log keeps turn outcomes, this keeps the live picture.
 */
export class TurnHub {
  private seq = 0;
  private readonly buffer: LiveTurnEvent[] = [];
  private readonly listeners = new Set<(event: LiveTurnEvent) => void>();

  constructor(
    private readonly capacity = 2_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get lastSeq(): number {
    return this.seq;
  }

  push(agent: Name, project: Name, event: AgentEvent): LiveTurnEvent {
    this.seq += 1;
    const item: LiveTurnEvent = {
      seq: this.seq,
      ts: this.now().toISOString(),
      agent,
      project,
      event,
    };
    this.buffer.push(item);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
    for (const listener of this.listeners) {
      listener(item);
    }
    return item;
  }

  /** Buffered events after `seq`, oldest first, capped at `limit` most recent. */
  since(seq: number, limit = 500): LiveTurnEvent[] {
    const after = this.buffer.filter((item) => item.seq > seq);
    return after.length > limit ? after.slice(after.length - limit) : after;
  }

  subscribe(listener: (event: LiveTurnEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
