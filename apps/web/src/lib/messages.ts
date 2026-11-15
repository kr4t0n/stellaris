import { MESSAGE_LOOKUP_LIMIT, type Message, type MessageRef } from "@stellaris/shared";

/**
 * The messages text names by id, looked up from the board as the text shows: every id asked for
 * in one pass goes in one request. An id is asked for once, since a message never moves once
 * posted, so an id that names something else, such as a turn, or whose lookup failed, stays
 * unknown until the page loads again.
 */
export class MessageLookup {
  private readonly asked = new Set<string>();
  private readonly waiting = new Set<string>();
  private readonly found = new Map<string, MessageRef>();
  private readonly listeners = new Set<() => void>();
  private refs: readonly MessageRef[] = [];
  private scheduled = false;

  constructor(private readonly fetch: (ids: readonly string[]) => Promise<readonly MessageRef[]>) {}

  /** Asks for the ids not asked for before, together with the others asked for in this pass. */
  want(ids: Iterable<string>): void {
    for (const id of ids) {
      if (!this.asked.has(id)) {
        this.asked.add(id);
        this.waiting.add(id);
      }
    }
    if (this.waiting.size > 0 && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => void this.flush());
    }
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    const ids = [...this.waiting];
    this.waiting.clear();
    const before = this.found.size;
    for (let at = 0; at < ids.length; at += MESSAGE_LOOKUP_LIMIT) {
      try {
        for (const ref of await this.fetch(ids.slice(at, at + MESSAGE_LOOKUP_LIMIT))) {
          this.found.set(ref.id, ref);
        }
      } catch {
        // Left unknown: the ids read as written.
      }
    }
    if (this.found.size !== before) {
      this.refs = [...this.found.values()];
      for (const listener of this.listeners) {
        listener();
      }
    }
  }

  /** For `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Every message found so far; the same array until another is found. */
  readonly snapshot = (): readonly MessageRef[] => this.refs;
}

/**
 * `messages` with `message` in its place by id, as a read of its thread or channel would have it,
 * or `messages` itself when it is there already. A post's answer carries the message, so the view
 * shows it at once, before the read the board's event brings.
 */
export function withMessage<T extends Pick<Message, "id">>(messages: T[], message: T): T[] {
  if (messages.some((each) => each.id === message.id)) {
    return messages;
  }
  const at = messages.findIndex((each) => each.id > message.id);
  return at === -1
    ? [...messages, message]
    : [...messages.slice(0, at), message, ...messages.slice(at)];
}

/**
 * A key for one post, sent again with it if its answer never arrives, so the board stores it
 * once. Random bytes rather than `crypto.randomUUID`, which a board served over plain HTTP to
 * another machine doesn't have.
 */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
