/** The board's own mention pattern: `@name` not inside a word or an address. */
const MENTION = /(^|[^\w@])@([a-z0-9][a-z0-9-]{0,31})(?![\w-])/g;

/** The part of an mdast node this plugin reads and writes. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** Where a mention would not be one: code shows text as written, and links already say where. */
const OPAQUE = new Set(["code", "inlineCode", "link", "linkReference", "html"]);

function split(value: string): MdNode[] {
  const nodes: MdNode[] = [];
  let last = 0;
  for (const match of value.matchAll(MENTION)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    if (start > last) {
      nodes.push({ type: "text", value: value.slice(last, start) });
    }
    const name = match[2] ?? "";
    nodes.push({
      type: "mention",
      data: {
        hName: "span",
        hProperties: { className: ["mention"] },
        hChildren: [{ type: "text", value: `@${name}` }],
      },
    });
    last = start + name.length + 1;
  }
  if (last < value.length) {
    nodes.push({ type: "text", value: value.slice(last) });
  }
  return nodes;
}

function walk(node: MdNode): void {
  if (node.children === undefined) {
    return;
  }
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value !== undefined) {
      return split(child.value);
    }
    if (!OPAQUE.has(child.type)) {
      walk(child);
    }
    return [child];
  });
}

/** The names a text mentions, as the board reads them to decide whom a post wakes. */
export function mentionsIn(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((match) => match[2] ?? ""))].filter(
    (name) => name !== "",
  );
}

/** A remark plugin that marks `@mentions` so they render highlighted, outside code and links. */
export function remarkMentions() {
  return (tree: MdNode): void => walk(tree);
}
