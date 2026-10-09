import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { z } from "zod";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Writes through a temporary file and a rename so readers never observe a partial file. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

export async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await readFile(file, "utf8");
  return schema.parse(JSON.parse(raw));
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export interface MarkdownDocument<T> {
  readonly data: T;
  readonly body: string;
}

/**
 * gray-matter without its cache, which an options object turns off: it caches a file's text before
 * parsing it, so frontmatter that does not parse throws once and then reads as empty, and the cache
 * keeps every text it ever saw.
 */
function parseMatter(raw: string): matter.GrayMatterFile<string> {
  return matter(raw, {});
}

export async function readMarkdown<T>(
  file: string,
  schema: z.ZodType<T>,
): Promise<MarkdownDocument<T>> {
  const raw = await readFile(file, "utf8");
  const parsed = parseMatter(raw);
  return { data: schema.parse(parsed.data), body: parsed.content.replace(/^\n/, "") };
}

export interface LooseMarkdownDocument extends MarkdownDocument<Record<string, unknown>> {
  /** Why the frontmatter did not parse, or null when it did. */
  readonly error: string | null;
}

/**
 * Markdown a citizen writes, such as its profile, memory, and skills, which the board reads but
 * never validates: frontmatter that does not parse leaves the data empty and the body the whole text.
 */
export async function readLooseMarkdown(file: string): Promise<LooseMarkdownDocument> {
  const raw = await readFile(file, "utf8");
  try {
    const parsed = parseMatter(raw);
    return { data: parsed.data, body: parsed.content.replace(/^\n/, ""), error: null };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
    return { data: {}, body: raw, error: reason.replace(/:$/, "") };
  }
}

export async function writeMarkdown(file: string, data: object, body: string): Promise<void> {
  const normalized = body.endsWith("\n") || body.length === 0 ? body : `${body}\n`;
  // Given a string, gray-matter parses it as a document first, so a body opening with a `---`
  // block would lose that block to the frontmatter, or throw when it is not YAML.
  await writeFileAtomic(file, matter.stringify({ content: normalized }, data, {}));
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

/** Sorted file names with the given extension, or an empty list when the directory does not exist. */
export async function listFiles(dir: string, extension = ".md"): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => entry.name)
      .toSorted();
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}
