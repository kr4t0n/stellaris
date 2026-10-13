import { MENTION_PATTERN } from "@stellaris/shared/mentions";

/** The part of an mdast node this plugin reads and writes. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/**
 * Where a name is not highlighted: code shows text as written and wakes nobody (`mentionsIn`), and a
 * link already says where, though a name in a link or in HTML still wakes.
 */
const OPAQUE = new Set(["code", "inlineCode", "link", "linkReference", "html"]);

function split(value: string): MdNode[] {
  const nodes: MdNode[] = [];
  let last = 0;
  for (const match of value.matchAll(MENTION_PATTERN)) {
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

/** A remark plugin that marks `@mentions` so they render highlighted, outside code and links. */
export function remarkMentions() {
  return (tree: MdNode): void => walk(tree);
}
