/** The `@name` being typed where the caret is: where it starts and what is typed so far. */
export function mentionAt(text: string, caret: number): { start: number; prefix: string } | null {
  const match = /(^|[^\w@])@([a-z0-9-]*)$/.exec(text.slice(0, caret));
  const prefix = match?.[2];
  return prefix === undefined ? null : { start: caret - prefix.length - 1, prefix };
}

/** The text with the mention being typed completed to a name, and where the caret goes next. */
export function completeMention(
  text: string,
  caret: number,
  start: number,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  return {
    text: text.slice(0, start) + inserted + text.slice(caret),
    caret: start + inserted.length,
  };
}

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

export function listed(names: readonly string[]): string {
  return LIST.format(names);
}
