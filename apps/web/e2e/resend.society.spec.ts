import http from "node:http";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
// The server's own build, by path, as the exit test takes it.
import {
  startSocietyServer,
  type SocietyServer,
} from "../../server/dist/testing/society-server.js";

// A post the board stores whose answer the browser never gets, through the real composer and a
// whole board server: a proxy in front of the board loses the first post's answer once the board
// has answered it, in each of the three ways a link can. Whatever the browser then does, by
// itself or at the user's second press, the board holds the post once.

test.setTimeout(90_000);

const LOSSES = ["reset on a reused connection", "reset on a fresh connection", "502"] as const;
type Loss = (typeof LOSSES)[number];

const TEXT = "Stored once, whatever the link did.";

let society: SocietyServer;

test.beforeEach(async () => {
  society = await startSocietyServer({
    port: 0,
    webDir: path.resolve(import.meta.dirname, "../dist"),
  });
});

test.afterEach(async () => {
  await society.stop();
});

/**
 * A proxy to the board that passes everything but the first post's answer, which it loses once the
 * board has sent it: a reset on the connection the browser reused, which Chromium answers by
 * sending the post again by itself; a reset on a fresh one, every answer closing its connection,
 * which the page sees fail; or a gateway's 502.
 */
async function lossyProxy(target: string, loss: Loss) {
  const upstream = new URL(target);
  let posts = 0;
  const server = http.createServer((request, response) => {
    const forward = http.request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (answer) => {
        if (request.url === "/api/verbs/post_message") {
          posts += 1;
          if (posts === 1) {
            answer.resume();
            answer.on("end", () => {
              if (loss === "502") {
                response.writeHead(502, { "content-type": "text/plain", connection: "close" });
                response.end("Bad Gateway");
              } else {
                request.socket.destroy();
              }
            });
            return;
          }
        }
        const headers = { ...answer.headers };
        if (loss === "reset on a fresh connection" && request.url?.includes("/stream") !== true) {
          headers["connection"] = "close";
        }
        response.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(response);
      },
    );
    forward.on("error", () => response.destroy());
    request.pipe(forward);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the proxy has no port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    posts: () => posts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

for (const loss of LOSSES) {
  test(`a post whose answer is lost to a ${loss} is stored once`, async ({ page, request }) => {
    const { token } = z
      .object({ token: z.string() })
      .parse(await (await request.post(`${society.url}/test/token`)).json());
    const proxy = await lossyProxy(society.url, loss);
    try {
      await page.goto(proxy.url);
      await page.getByLabel("Board token").fill(token);
      await page.getByRole("button", { name: "Enter the playground" }).click();
      await page.goto(`${proxy.url}/c/demo/general`);
      const box = page.getByRole("textbox", { name: "Message #general" });
      await box.fill(TEXT);
      await box.press("Enter");
      if (loss === "reset on a reused connection") {
        // Chromium sent the post again by itself: no failure shows, and the box empties.
        await expect(box).toHaveValue("");
        await expect(page.getByRole("alert")).toHaveCount(0);
      } else {
        await expect(page.getByRole("alert")).toContainText(
          loss === "502" ? "answered 502" : "The board server is not reachable.",
        );
        await expect(box).toHaveValue(TEXT);
        await box.press("Enter");
        await expect(box).toHaveValue("");
      }
      expect(proxy.posts()).toBe(2);
      const read = await request.get(`${society.url}/api/channels/demo/general`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const messages = z.array(z.object({ body: z.string() })).parse(await read.json());
      expect(messages.filter((message) => message.body.trim() === TEXT)).toHaveLength(1);
      await expect(page.getByText(TEXT, { exact: true })).toHaveCount(1);
    } finally {
      await proxy.close();
    }
  });
}
