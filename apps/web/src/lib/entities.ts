import { describeCharter, type MessageRef, type Proposal } from "@stellaris/shared";

export type EntityKind = "task" | "proposal" | "thread" | "cron" | "message";

/** Where a message sits: its thread, or else its channel. */
export interface MessagePlace {
  readonly channel: string;
  readonly thread?: string | undefined;
}

/** Something on the board an id in text stands for, with the words to show in its place. */
export interface Entity {
  readonly kind: EntityKind;
  readonly id: string;
  readonly title: string;
  /** For a message, where it sits, which its link opens. */
  readonly place?: MessagePlace | undefined;
}

export type EntityIndex = ReadonlyMap<string, Entity>;

export const NO_ENTITIES: EntityIndex = new Map();

/**
 * A ULID standing alone: not inside a word, a path such as a task's branch, or a file name. A
 * period after it ends a sentence unless a word goes on, as in `<id>.md`.
 */
const ULID = /(?<![\w/.-])[0-9A-HJKMNP-TV-Z]{26}(?![\w/-]|\.\w)/g;

/** "your" for the user without a sign-in, else the name's possessive. */
function possessive(name: string): string {
  return name === "you" ? "your" : `${name}'s`;
}

/**
 * What each id names: threads by their titles, tasks by theirs, proposals as the board describes
 * their charters, crons by their titles, and messages by who posted them where, with `name` for
 * how a citizen's name reads. A task's and a proposal's threads share their ids, so the later
 * sources win.
 */
export function entityIndex(
  threads: readonly {
    readonly id: string;
    readonly title: string;
    readonly subject?: { readonly kind: string } | undefined;
  }[],
  tasks: readonly { readonly id: string; readonly title: string }[],
  proposals: readonly Proposal[],
  crons: readonly { readonly id: string; readonly title: string }[] = [],
  options: {
    readonly messages?: readonly MessageRef[] | undefined;
    readonly name?: ((author: string) => string) | undefined;
  } = {},
): EntityIndex {
  const index = new Map<string, Entity>();
  const name = options.name ?? ((author: string) => author);
  const titles = new Map(threads.map((thread) => [thread.id, thread.title]));
  for (const message of options.messages ?? []) {
    const where =
      message.thread === undefined
        ? `#${message.channel}`
        : (titles.get(message.thread) ?? `a thread in #${message.channel}`);
    index.set(message.id, {
      kind: "message",
      id: message.id,
      title: `${possessive(name(message.author))} post in ${where}`,
      place: {
        channel: message.channel,
        ...(message.thread === undefined ? {} : { thread: message.thread }),
      },
    });
  }
  for (const thread of threads) {
    const kind =
      thread.subject?.kind === "task"
        ? "task"
        : thread.subject?.kind === "proposal"
          ? "proposal"
          : "thread";
    index.set(thread.id, { kind, id: thread.id, title: thread.title });
  }
  for (const task of tasks) {
    index.set(task.id, { kind: "task", id: task.id, title: task.title });
  }
  for (const proposal of proposals) {
    index.set(proposal.id, {
      kind: "proposal",
      id: proposal.id,
      title: describeCharter(proposal.kind, proposal.charter),
    });
  }
  for (const cron of crons) {
    index.set(cron.id, { kind: "cron", id: cron.id, title: cron.title });
  }
  return index;
}

export type Piece = string | Entity;

/**
 * The words agents write before a message's id, "message" or "post" and whose it is, which its
 * title already says, naming its author.
 */
const MESSAGE_WORD =
  /(?:\b(?:my|your|our|their|his|her|its|[\w-]+['’]s)\s+)?\b(?:message|post)\s+$/i;

/**
 * Text cut at the ids the index knows. Agents and the board often write the title right after an
 * id, quoted or after a colon; that echo is dropped, since the id now reads as the title, and so
 * is "message" or "post", and whose, right before a message's id, which reads as
 * "<name>'s post in …".
 */
export function splitEntities(text: string, index: EntityIndex): Piece[] {
  if (index.size === 0) {
    return [text];
  }
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(ULID)) {
    const start = match.index ?? 0;
    const entity = index.get(match[0]);
    if (entity === undefined || start < last) {
      continue;
    }
    const before = text.slice(last, start);
    const kept = entity.kind === "message" ? before.replace(MESSAGE_WORD, "") : before;
    if (kept !== "") {
      pieces.push(kept);
    }
    pieces.push(entity);
    last = start + match[0].length;
    const echo = [` "${entity.title}"`, `: ${entity.title}`].find((each) =>
      text.startsWith(each, last),
    );
    last += echo?.length ?? 0;
  }
  if (last < text.length) {
    pieces.push(text.slice(last));
  }
  return pieces;
}

/** The ids in a text the index does not know yet, which may name messages. */
export function unknownIds(text: string, index: EntityIndex): string[] {
  return [...new Set([...text.matchAll(ULID)].map((match) => match[0]))].filter(
    (id) => !index.has(id),
  );
}

/** The text with each known id read as its title, for places that cannot hold a link. */
export function withTitles(text: string, index: EntityIndex): string {
  return splitEntities(text, index)
    .map((piece) => (typeof piece === "string" ? piece : piece.title))
    .join("");
}

/**
 * Where an entity's view is, as the router's paths spell it: a cron opens in the crons view, and
 * a message in its thread, or else its channel, marked there.
 */
export function entityHref(entity: Entity): string {
  if (entity.kind === "cron") {
    return `/crons?cron=${entity.id}`;
  }
  if (entity.kind === "message") {
    const thread = entity.place?.thread;
    return thread === undefined
      ? `/c/${entity.place?.channel ?? "general"}?message=${entity.id}`
      : `/thread/${thread}?message=${entity.id}`;
  }
  return `/${entity.kind}/${entity.id}`;
}

const ENTITY_HREF = /^\/(task|proposal|thread)\/([0-9A-HJKMNP-TV-Z]{26})$/;
const CRON_HREF = /^\/crons\?cron=([0-9A-HJKMNP-TV-Z]{26})$/;
const THREAD_MESSAGE_HREF =
  /^\/thread\/([0-9A-HJKMNP-TV-Z]{26})\?message=([0-9A-HJKMNP-TV-Z]{26})$/;
const CHANNEL_MESSAGE_HREF =
  /^\/c\/([a-z0-9-]+(?:\/[a-z0-9-]+)?)\?message=([0-9A-HJKMNP-TV-Z]{26})$/;

/** The entity a link made by `remarkEntities` points at, or null for any other link. */
export function entityOfHref(
  href: string | undefined,
): { kind: EntityKind; id: string; place?: MessagePlace } | null {
  if (href === undefined) {
    return null;
  }
  const cron = CRON_HREF.exec(href)?.[1];
  if (cron !== undefined) {
    return { kind: "cron", id: cron };
  }
  const inThread = THREAD_MESSAGE_HREF.exec(href);
  if (inThread?.[1] !== undefined && inThread[2] !== undefined) {
    // The channel goes unused while there is a thread; the link opens the thread.
    return { kind: "message", id: inThread[2], place: { channel: "", thread: inThread[1] } };
  }
  const inChannel = CHANNEL_MESSAGE_HREF.exec(href);
  if (inChannel?.[1] !== undefined && inChannel[2] !== undefined) {
    return { kind: "message", id: inChannel[2], place: { channel: inChannel[1] } };
  }
  const match = ENTITY_HREF.exec(href);
  const kind = match?.[1];
  const id = match?.[2];
  return kind === "task" || kind === "proposal" || kind === "thread"
    ? id === undefined
      ? null
      : { kind, id }
    : null;
}

/** The part of an mdast node this plugin reads and writes. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  children?: MdNode[];
}

/** Code shows text as written, and a link already says where it goes. */
const OPAQUE = new Set(["code", "inlineCode", "link", "linkReference", "html"]);

function linkTo(entity: Entity): MdNode {
  return {
    type: "link",
    url: entityHref(entity),
    title: `${entity.kind} ${entity.id}`,
    children: [{ type: "text", value: entity.title }],
  };
}

function walk(node: MdNode, index: EntityIndex): void {
  if (node.children === undefined) {
    return;
  }
  const children: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value !== undefined) {
      for (const piece of splitEntities(child.value, index)) {
        children.push(typeof piece === "string" ? { type: "text", value: piece } : linkTo(piece));
      }
      continue;
    }
    // Agents often quote an id as code; a code span that is nothing but a known id is a reference.
    const quoted = child.type === "inlineCode" ? index.get(child.value?.trim() ?? "") : undefined;
    if (quoted !== undefined) {
      const before = children.at(-1);
      if (quoted.kind === "message" && before?.type === "text" && before.value !== undefined) {
        before.value = before.value.replace(MESSAGE_WORD, "");
      }
      children.push(linkTo(quoted));
      continue;
    }
    if (!OPAQUE.has(child.type)) {
      walk(child, index);
    }
    children.push(child);
  }
  node.children = children;
}

/**
 * A remark plugin that turns the ids of known tasks, proposals, threads, crons, and messages into
 * links named by their titles.
 */
export function remarkEntities(options: { index: EntityIndex }) {
  return (tree: MdNode): void => walk(tree, options.index);
}
