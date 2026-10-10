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
