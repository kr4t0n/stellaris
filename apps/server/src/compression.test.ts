import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createGunzip, gunzipSync } from "node:zlib";
import { serve } from "@hono/node-server";
import { Board } from "@stellaris/board-core";
import { UploadedImageSchema } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { pngOfSize } from "./testing/images.js";
import { addWorkRoles } from "./testing/scripted-backend.js";
import { TurnHub } from "./turn-hub.js";

const USER = { name: "user", role: "user" } as const;
/** What a browser asks for. */
const BROWSER = "gzip, deflate, br, zstd";
/** How long a stream's event may take: well inside its 15 s ping, which a compressor holds too. */
const PROMPTLY_MS = 5_000;

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A GET over real HTTP, read as it came: Node's `http`, unlike `fetch`, decodes nothing. */
function get(url: string, headers: Record<string, string>): Promise<Answer> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers, agent: false }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      })
      .on("error", reject);
  });
}

function withoutDate(headers: http.IncomingHttpHeaders): Record<string, unknown> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "date"));
}

/**
 * A stream's first event, read as its `content-encoding` says once it has answered and `cause` has
 * made an event, or a failure when none arrives promptly.
 */
function firstEvent(
  url: string,
  headers: Record<string, string>,
  cause: () => Promise<unknown>,
): Promise<{ headers: http.IncomingHttpHeaders; data: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers, agent: false }, (response) => {
      const text =
        response.headers["content-encoding"] === "gzip" ? response.pipe(createGunzip()) : response;
      let read = "";
      const timer = setTimeout(() => {
        request.destroy();
        reject(new Error(`no event within ${PROMPTLY_MS} ms; read ${JSON.stringify(read)}`));
      }, PROMPTLY_MS);
      text.on("data", (chunk: Buffer) => {
        read += chunk.toString("utf8");
        const data = read.split("\n").find((line) => line.startsWith("data: {"));
        if (data !== undefined) {
          clearTimeout(timer);
          request.destroy();
          resolve({ headers: response.headers, data: data.slice("data: ".length) });
        }
      });
      cause().catch(reject);
    });
    request.on("error", (error) => {
      if (!request.destroyed) {
        reject(error);
      }
    });
  });
}

describe("compression of the API's answers", () => {
  let dir: string;
  let board: Board;
  let auth: Record<string, string>;
  let server: ReturnType<typeof serve> | null;

  /** Serves the app on a free local port, as `serveBoard` does over real HTTP. */
  const listen = (app: ReturnType<typeof createApp>): Promise<string> =>
    new Promise((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
        resolve(`http://127.0.0.1:${info.port}`),
      );
    });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-compression-"));
    const init = await Board.init(dir, { name: "compression" });
    board = init.board;
    auth = { authorization: `Bearer ${init.userToken}` };
    await board.addProject(USER, { slug: "demo", channels: ["general"] });
    await addWorkRoles(board);
    server = null;
  });

  afterEach(async () => {
    server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("gzips a JSON answer of a kilobyte or more when asked, and sends it plain when not", async () => {
    for (let n = 1; n <= 30; n += 1) {
      await board.postMessage(USER, {
        channel: "demo/general",
        body: `Message ${n}: the runner synced its copy of the board and took the next turn.`,
      });
    }
    const url = await listen(createApp({ board, version: "t" }));

    const plain = await get(`${url}/api/channels/demo/general`, auth);
    expect(plain.status).toBe(200);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers["content-length"]).toBe(String(plain.body.length));
    expect(plain.body.length).toBeGreaterThan(4_096);

    const zipped = await get(`${url}/api/channels/demo/general`, {
      ...auth,
      "accept-encoding": BROWSER,
    });
    expect(zipped.status).toBe(200);
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(zipped.headers.vary).toMatch(/accept-encoding/i);
    expect(zipped.headers["content-type"]).toBe(plain.headers["content-type"]);
    expect(gunzipSync(zipped.body).toString("utf8")).toBe(plain.body.toString("utf8"));
    expect(zipped.body.length).toBeLessThan(plain.body.length / 4);

    // Under a kilobyte, compressing would save next to nothing, so the answer goes as it is.
    const small = await get(`${url}/api/scheduler`, { ...auth, "accept-encoding": BROWSER });
    expect(small.status).toBe(200);
    expect(small.headers["content-encoding"]).toBeUndefined();
    expect(small.headers["content-length"]).toBe(String(small.body.length));
    expect(small.body.length).toBeLessThan(1_024);
  });

  it("streams board events and turn events as they are when gzip is asked, each event at once", async () => {
    const turns = new TurnHub(10);
    const url = await listen(createApp({ board, version: "t", turns }));
    const asked = { ...auth, "accept-encoding": BROWSER };

    const since = (await board.latestEventId()) ?? "";
    const boardEvent = await firstEvent(`${url}/api/events/stream?since=${since}`, asked, () =>
      board.postMessage(USER, { channel: "demo/general", body: "streamed" }),
    );
    expect(JSON.parse(boardEvent.data)).toMatchObject({ type: "message.posted" });
    expect(boardEvent.headers["content-type"]).toContain("text/event-stream");
    expect(boardEvent.headers["content-encoding"]).toBeUndefined();

    const turnEvent = await firstEvent(`${url}/api/turns/stream?since=0`, asked, async () => {
      turns.push("eng-1", "demo", { type: "text", delta: "streamed" });
    });
    expect(JSON.parse(turnEvent.data)).toMatchObject({ seq: 1, agent: "eng-1" });
    expect(turnEvent.headers["content-type"]).toContain("text/event-stream");
    expect(turnEvent.headers["content-encoding"]).toBeUndefined();
  });

  it("serves an image's bytes the same whether gzip is asked or not", async () => {
    const app = createApp({ board, version: "t" });
    const png = pngOfSize(8_192);
    const posted = await app.request("/api/images?name=shot.png", {
      method: "POST",
      headers: auth,
      body: png,
    });
    const { id } = UploadedImageSchema.parse(await posted.json());
    const url = await listen(app);

    const plain = await get(`${url}/api/images/${id}`, auth);
    const asked = await get(`${url}/api/images/${id}`, { ...auth, "accept-encoding": BROWSER });
    expect(plain.status).toBe(200);
    expect(plain.body.equals(png)).toBe(true);
    expect(withoutDate(asked.headers)).toEqual(withoutDate(plain.headers));
    expect(asked.headers["content-encoding"]).toBeUndefined();
    expect(asked.headers["content-type"]).toBe("image/png");
    expect(asked.body.equals(png)).toBe(true);
  });
});
