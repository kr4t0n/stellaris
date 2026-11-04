import { IMAGE_LIMIT_BYTES, type RunnerMessage } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { RunnerClient } from "./client.js";
import { describeError } from "./errors.js";

/** A server whose stream sends `frames`, one every `everyMs`, then stays open and silent. */
function streamingFetch(frames: readonly string[], everyMs: number): typeof fetch {
  return (_url, init) => {
    const signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        signal?.addEventListener("abort", () => controller.error(signal.reason));
        for (const frame of frames) {
          if (signal?.aborted === true) {
            return;
          }
          controller.enqueue(encoder.encode(frame));
          await new Promise((resolve) => setTimeout(resolve, everyMs));
        }
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
}

describe("RunnerClient", () => {
  it("takes a stream that stops delivering for dead, and one that keeps pinging for alive", async () => {
    const silent = new RunnerClient(
      "http://server",
      "token",
      streamingFetch([": attached\n\n"], 0),
      50,
    );
    const opened: boolean[] = [];
    await expect(
      silent.stream(new AbortController().signal, {
        onOpen: () => opened.push(true),
        onMessage: () => undefined,
      }),
    ).rejects.toThrow("the event stream was silent for 0.05s");
    expect(opened).toEqual([true]);

    // Keepalives every 20ms hold a 50ms watchdog off for longer than it lasts.
    const pinging = new RunnerClient(
      "http://server",
      "token",
      streamingFetch(
        Array.from({ length: 8 }, () => ": ping\n\n"),
        20,
      ),
      50,
    );
    const stop = new AbortController();
    const held = pinging.stream(stop.signal, { onMessage: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop.abort();
    // Stopped by the runner itself, the stream says so rather than that it went silent.
    await expect(held).rejects.not.toThrow("silent");
  });

  it("takes every message whole however the stream cuts it, an image's of 8 MiB in 16 KiB pieces too", async () => {
    const messages: RunnerMessage[] = [
      { type: "stop", request: "first", turnId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      {
        type: "image_write",
        request: "second",
        write: {
          turnId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          id: "01M4WY483E0XG4Q2ZTHAX3JBZW",
          type: "png",
          content: Buffer.alloc(IMAGE_LIMIT_BYTES, 7).toString("base64"),
        },
      },
      { type: "stop", request: "third", turnId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    ];
    const text = `: attached\n\n${messages.map((each) => `data: ${JSON.stringify(each)}\n\n`).join("")}`;
    const firstEnd = text.indexOf("\n\n", text.indexOf("data:")) + 1;
    const cuts: Record<string, string[]> = {
      whole: [text],
      "16 KiB": Array.from({ length: Math.ceil(text.length / 16_384) }, (_, index) =>
        text.slice(index * 16_384, (index + 1) * 16_384),
      ),
      // A frame's blank line cut between its two line breaks: the first's, before more frames, and
      // the last's, with nothing after it to flush it, after the piece that ends the frame before
      // it or with each line break a piece of its own.
      "between the first's line breaks": [text.slice(0, firstEnd), text.slice(firstEnd)],
      "between the last's line breaks": [text.slice(0, -1), "\n"],
      "each of the last's line breaks alone": [text.slice(0, -2), "\n", "\n"],
    };
    for (const [cut, pieces] of Object.entries(cuts)) {
      const taken: RunnerMessage[] = [];
      const stop = new AbortController();
      const client = new RunnerClient("http://server", "token", streamingFetch(pieces, 0), 5_000);
      const held = client.stream(stop.signal, {
        onMessage: (message) => {
          taken.push(message);
          if (taken.length === messages.length) {
            stop.abort();
          }
        },
        onMalformed: (problem) => {
          throw new Error(`${cut}: ${problem}`);
        },
      });
      await expect(held).rejects.toThrow("aborted");
      expect({ cut, taken }).toEqual({ cut, taken: messages });
    }
  });

  it("describes an error with the causes fetch keeps beneath it", () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const timeout = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    expect(describeError(new TypeError("terminated", { cause: reset }))).toBe(
      "TypeError: terminated, caused by Error: read ECONNRESET",
    );
    expect(describeError(new TypeError("fetch failed", { cause: timeout }))).toBe(
      "TypeError: fetch failed, caused by Error: Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)",
    );
    expect(describeError("plain")).toBe("plain");
  });
});
