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

/** A path inside `root`, or null for one that decodes badly or climbs out of it. */
function within(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = path.resolve(root, `.${decoded}`);
  // A bare prefix test would let `/dist-other` pass for `/dist`.
  return candidate === root || candidate.startsWith(root + path.sep) ? candidate : null;
}

/**
 * Serves the built single-page interface from a directory, read on every request so a rebuild
 * shows without a restart: hashed assets cached for good, everything else revalidated, and any
 * other path answered with index.html so the interface's own routes load from a link. An unknown
 * `/api` path or asset stays a 404, never the page.
 */
export function spaHandler(staticDir: string): (c: Context) => Promise<Response> {
  const root = path.resolve(staticDir);
  return async (c) => {
    const { pathname } = new URL(c.req.url);
    if (pathname.startsWith("/api/")) {
      return c.json({ error: "NOT_FOUND", message: `no route ${pathname}` }, 404);
    }
    const file = within(root, pathname);
    const headers = { "x-content-type-options": "nosniff" };
    if (file !== null && (await isFile(file))) {
      return c.body(await readFile(file), 200, {
        ...headers,
        "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        "cache-control": pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
    }
    // A chunk a rebuild deleted, asked for by a tab opened before it, is missing, not a page.
    if (pathname.startsWith("/assets/")) {
      return c.text("not found", 404, headers);
    }
    const index = path.join(root, "index.html");
    if (!(await isFile(index))) {
      return c.text("The interface is not built: run pnpm build:web.", 404);
    }
    return c.body(await readFile(index), 200, {
      ...headers,
      "content-type": CONTENT_TYPES[".html"] ?? "text/html",
      "cache-control": "no-cache",
    });
  };
}
