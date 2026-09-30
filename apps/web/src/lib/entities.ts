import { describeCharter, type Proposal } from "@stellaris/shared";

export type EntityKind = "task" | "proposal" | "thread";

/** Something on the board an id in text stands for, with the words to show in its place. */
export interface Entity {
  readonly kind: EntityKind;
  readonly id: string;
  readonly title: string;
}

export type EntityIndex = ReadonlyMap<string, Entity>;

export const NO_ENTITIES: EntityIndex = new Map();

/**
 * A ULID standing alone: not inside a word, a path such as a task's branch, or a file name. A
 * period after it ends a sentence unless a word goes on, as in `<id>.md`.
 */
const ULID = /(?<![\w/.-])[0-9A-HJKMNP-TV-Z]{26}(?![\w/-]|\.\w)/g;

/**
 * What each id names: threads by their titles, tasks by theirs, and proposals as the board
 * describes their charters. A task's and a proposal's threads share their ids, so the later
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
): EntityIndex {
  const index = new Map<string, Entity>();
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
  return index;
}

export type Piece = string | Entity;

/**
 * Text cut at the ids the index knows. Agents and the board often write the title right after an
 * id, quoted or after a colon; that echo is dropped, since the id now reads as the title.
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
    if (start > last) {
      pieces.push(text.slice(last, start));
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

/** The text with each known id read as its title, for places that cannot hold a link. */
export function withTitles(text: string, index: EntityIndex): string {
  return splitEntities(text, index)
    .map((piece) => (typeof piece === "string" ? piece : piece.title))
    .join("");
}

/** Where an entity's view is, as the router's paths spell it. */
export function entityHref(entity: Entity): string {
  return `/${entity.kind}/${entity.id}`;
}

const ENTITY_HREF = /^\/(task|proposal|thread)\/([0-9A-HJKMNP-TV-Z]{26})$/;

/** The entity a link made by `remarkEntities` points at, or null for any other link. */
export function entityOfHref(href: string | undefined): { kind: EntityKind; id: string } | null {
  const match = href === undefined ? null : ENTITY_HREF.exec(href);
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
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type === "text" && child.value !== undefined) {
      return splitEntities(child.value, index).map((piece) =>
        typeof piece === "string" ? { type: "text", value: piece } : linkTo(piece),
      );
    }
    // Agents often quote an id as code; a code span that is nothing but a known id is a reference.
    const quoted = child.type === "inlineCode" ? index.get(child.value?.trim() ?? "") : undefined;
    if (quoted !== undefined) {
      return [linkTo(quoted)];
    }
    if (!OPAQUE.has(child.type)) {
      walk(child, index);
    }
    return [child];
  });
}

/** A remark plugin that turns the ids of known tasks, proposals, and threads into links named by their titles. */
export function remarkEntities(options: { index: EntityIndex }) {
  return (tree: MdNode): void => walk(tree, options.index);
}
