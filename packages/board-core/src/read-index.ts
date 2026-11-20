import path from "node:path";
import type { Message, Name, Thread, Ulid } from "@stellaris/shared";

/** A thread record as the board finds it: the record and the folder of its scope's threads. */
export interface FoundThread {
  readonly thread: Thread;
  readonly threads: string;
}

/** A folder's message count and its newest message, as a listing of its files gives them. */
export interface FolderSummary {
  readonly count: number;
  readonly newest: Message | undefined;
}

/** What a write the index has not taken yet changed, kept while the index is seeded. */
export type ReadIndexWrite =
  | { readonly kind: "message"; readonly folder: string; readonly message: Message }
  | { readonly kind: "thread"; readonly threads: string; readonly thread: Thread }
  | { readonly kind: "task"; readonly project: Name; readonly id: Ulid };

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The position of the first entry whose id sorts after `id`, in a list sorted by id. */
function after(list: readonly { id: string }[], id: string): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((list[middle]?.id ?? "") <= id) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Puts `entry` in its place in a list sorted by id, at the end when it is the newest. */
function insert<T extends { id: string }>(list: T[], entry: T): void {
  const last = list.at(-1);
  if (last === undefined || last.id < entry.id) {
    list.push(entry);
  } else {
    list.splice(after(list, entry.id), 0, entry);
  }
}

function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) {
      frozen(member);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * What the board's reads of threads, channels, and messages need, held in memory: every message
 * parsed, by the folder it is filed in and in id order across the board, every thread record with
 * its scope, and the project of every task. The board seeds it from the files once and keeps it up
 * from its own writes, each right after the write's file (`Board.indexReads`); the files stay the
 * record. Held messages and records are frozen and every answer is a list of its own, so nothing a
 * reader does changes what the next one reads.
 */
export class ReadIndex {
  private readonly folders = new Map<string, Message[]>();
  private readonly ordered: Message[] = [];
  private readonly byMessage = new Map<Ulid, Message>();
  private readonly threads = new Map<Ulid, FoundThread>();
  private readonly threadsByScope = new Map<string, Map<Ulid, Thread>>();
  private readonly tasks = new Map<Ulid, Name>();

  /** Takes a message filed in `folder`, once: a message the index holds already is left as it is. */
  addMessage(folder: string, message: Message): void {
    if (this.byMessage.has(message.id)) {
      return;
    }
    const held = frozen(message);
    const key = path.resolve(folder);
    let list = this.folders.get(key);
    if (list === undefined) {
      list = [];
      this.folders.set(key, list);
    }
    insert(list, held);
    insert(this.ordered, held);
    this.byMessage.set(held.id, held);
  }

  /**
   * Takes a thread record written to `threads`. With `first`, a thread the index finds in another
   * scope already is still found there, as the first scope that has a thread's file is the one the
   * board finds it in, while each scope lists the records filed in it.
   */
  setThread(threads: string, thread: Thread, first = false): void {
    const key = path.resolve(threads);
    const held = frozen(thread);
    if (!(first && this.threads.has(held.id))) {
      this.threads.set(held.id, { thread: held, threads: key });
    }
    let scope = this.threadsByScope.get(key);
    if (scope === undefined) {
      scope = new Map();
      this.threadsByScope.set(key, scope);
    }
    scope.set(held.id, held);
  }

  /** Takes the project a task's file is in; with `first`, a place the index holds already stays. */
  setTask(id: Ulid, project: Name, first = false): void {
    if (!(first && this.tasks.has(id))) {
      this.tasks.set(id, project);
    }
  }

  /** Takes a write made while the index was seeded, as it would have when the write was made. */
  apply(write: ReadIndexWrite): void {
    if (write.kind === "message") {
      this.addMessage(write.folder, write.message);
    } else if (write.kind === "thread") {
      this.setThread(write.threads, write.thread);
    } else {
      this.setTask(write.id, write.project);
    }
  }

  /** The messages in a folder after `since` and, when given, up to `upto`, oldest first. */
  messagesIn(folder: string, since: Ulid | null, upto?: Ulid): Message[] {
    const list = this.folders.get(path.resolve(folder)) ?? [];
    const start = since === null ? 0 : after(list, since);
    const end = upto === undefined ? list.length : after(list, upto);
    return list.slice(start, Math.max(start, end));
  }

  /** Every message on the board after `since` and up to `upto`, oldest first. */
  messagesBetween(since: Ulid | null, upto?: Ulid): Message[] {
    const start = since === null ? 0 : after(this.ordered, since);
    const end = upto === undefined ? this.ordered.length : after(this.ordered, upto);
    return this.ordered.slice(start, Math.max(start, end));
  }

  /** Whether `author` wrote any message in a folder. */
  wroteIn(folder: string, author: Name): boolean {
    return (this.folders.get(path.resolve(folder)) ?? []).some(
      (message) => message.author === author,
    );
  }

  /** How many messages a folder holds, and its newest. */
  summary(folder: string): FolderSummary {
    const list = this.folders.get(path.resolve(folder)) ?? [];
    return { count: list.length, newest: list.at(-1) };
  }

  message(id: Ulid): Message | undefined {
    return this.byMessage.get(id);
  }

  thread(id: Ulid): FoundThread | undefined {
    return this.threads.get(id);
  }

  /** The thread records filed in one scope's folder of threads, in id order. */
  threadsIn(threads: string): Thread[] {
    return [...(this.threadsByScope.get(path.resolve(threads))?.values() ?? [])].toSorted(byId);
  }

  taskProject(id: Ulid): Name | undefined {
    return this.tasks.get(id);
  }
}
