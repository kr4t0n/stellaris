import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Context } from "hono";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves the built single-page UI from a directory: hashed assets with long cache lifetimes,
 * everything else falls back to index.html so client-side routes deep-link. Paths are confined
 * to the directory.
 */
export function spaHandler(staticDir: string): (c: Context) => Promise<Response> {
  const root = path.resolve(staticDir);
  return async (c) => {
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    const candidate = path.resolve(root, `.${pathname}`);
    if (candidate.startsWith(root) && (await isFile(candidate))) {
      const type = CONTENT_TYPES[path.extname(candidate)] ?? "application/octet-stream";
      const cache = pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      return c.body(await readFile(candidate), 200, {
        "content-type": type,
        "cache-control": cache,
      });
    }
    const index = path.join(root, "index.html");
    if (!(await isFile(index))) {
      return c.text("UI not built", 404);
    }
    return c.body(await readFile(index), 200, {
      "content-type": CONTENT_TYPES[".html"] ?? "text/html",
      "cache-control": "no-cache",
    });
  };
}
