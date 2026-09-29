const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 minutes ago", "yesterday", or "just now" for anything under a minute. */
export function ago(iso: string, now: number): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) {
      return relative.format(Math.round(seconds / size), unit);
    }
  }
  return "just now";
}

/** The first paragraph of a markdown text that is not a heading, as plain text. */
export function firstParagraph(markdown: string, limit = 220): string {
  const paragraph =
    markdown
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block.length > 0 && !block.startsWith("#")) ?? "";
  const plain = paragraph
    .replaceAll(/[*_`>]/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  return plain.length <= limit ? plain : `${plain.slice(0, limit - 1).trimEnd()}…`;
}
