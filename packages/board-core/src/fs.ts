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

export async function readMarkdown<T>(
  file: string,
  schema: z.ZodType<T>,
): Promise<MarkdownDocument<T>> {
  const raw = await readFile(file, "utf8");
  const parsed = matter(raw);
  return { data: schema.parse(parsed.data), body: parsed.content.replace(/^\n/, "") };
}

export async function writeMarkdown(file: string, data: object, body: string): Promise<void> {
  const normalized = body.endsWith("\n") || body.length === 0 ? body : `${body}\n`;
  await writeFileAtomic(file, matter.stringify(normalized, data));
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
