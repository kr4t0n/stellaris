import type { Context, MiddlewareHandler } from "hono";
import { compress } from "hono/compress";

/** What the API compresses: JSON, which is every answer it gives but images and event streams. */
const JSON_ANSWER = /^application\/json(?:[;\s]|$)/i;

const compressed = compress({ contentTypeFilter: JSON_ANSWER });

/**
 * Sets the length of a JSON answer, whose text is whole in memory already: `compress` leaves an
 * answer under its threshold, a kilobyte, alone only by its `content-length`, which `c.json` never
 * sets, so without it every answer would be compressed, `{"paused":true}` too.
 */
async function measure(c: Context): Promise<void> {
  const answer = c.res;
  if (
    answer.body === null ||
    answer.headers.has("content-length") ||
    !JSON_ANSWER.test(answer.headers.get("content-type") ?? "")
  ) {
    return;
  }
  const bytes = new Uint8Array(await answer.arrayBuffer());
  c.res = new Response(bytes, answer);
  c.res.headers.set("content-length", String(bytes.byteLength));
}

/**
 * The API's JSON answers of a kilobyte or more, gzipped (or deflated) when the request accepts it.
 * Nothing else is: an event stream would sit in the compressor until a buffer's worth of events
 * filled it, and an image is compressed already.
 */
export const compressJson: MiddlewareHandler = (c, next) =>
  compressed(c, async () => {
    await next();
    await measure(c);
  });
