function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The `data` lines of one server-sent-events frame, joined. */
function frameData(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

export interface StreamOptions {
  readonly token: string;
  /** Where to read, asked again at every connection so a resume can start where it left off. */
  readonly url: () => string;
  /** Each frame's data, in order; keep-alive frames without data are skipped. */
  readonly onData: (data: string) => void;
  /** A connection is open; `resumed` after a drop, when frames may have been missed. */
  readonly onOpen?: (resumed: boolean) => void;
  /** The frames of one read have all been handed to `onData`. */
  readonly onBatch?: () => void;
}

/**
 * Follows a server-sent-events route. It reads over `fetch`, because `EventSource` cannot send
 * the bearer token, and reconnects with backoff while the server is away. Returns the function
 * that stops it.
 */
export function followStream(options: StreamOptions): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  let delay = 1_000;
  let dropped = false;

  const run = async (): Promise<void> => {
    while (!signal.aborted) {
      try {
        const response = await fetch(options.url(), {
          headers: { authorization: `Bearer ${options.token}` },
          signal,
        });
        if (!response.ok || response.body === null) {
          throw new Error(`the stream answered ${response.status}`);
        }
        options.onOpen?.(dropped);
        delay = 1_000;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += value.replaceAll("\r\n", "\n");
          for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
            const data = frameData(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
            if (data !== "") {
              options.onData(data);
            }
          }
          options.onBatch?.();
        }
      } catch {
        if (signal.aborted) {
          return;
        }
      }
      dropped = true;
      await pause(delay, signal);
      delay = Math.min(delay * 2, 15_000);
    }
  };
  void run();
  return () => controller.abort();
}
