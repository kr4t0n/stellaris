import type { StreamedFile } from "@stellaris/board-core";
import type { BoardStreamStart } from "@stellaris/shared";

/** How long a first copy's stream waits on a runner that takes nothing before it ends. */
export const BOARD_STREAM_IDLE_MS = 5 * 60_000;

/**
 * The board's stream for a runner's first copy as the bytes of its answer: each record a line of
 * JSON, a file's content right after its line, and an end line once every file went, all gzipped
 * (the format is `BoardStreamStartSchema`'s). A file is read only once the runner has taken what
 * came before, so a slow link holds one file in memory at a time, and a stream whose runner takes
 * nothing for `idleMs` ends, cut, as a git transfer silent that long does.
 */
export function boardStreamBody(
  records: AsyncGenerator<BoardStreamStart | StreamedFile>,
  idleMs: number = BOARD_STREAM_IDLE_MS,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const line = (value: unknown): Uint8Array => encoder.encode(`${JSON.stringify(value)}\n`);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const raw = new ReadableStream<Uint8Array>({
    async pull(controller) {
      clearTimeout(idle);
      const next = await records.next();
      if (next.done === true) {
        controller.enqueue(line({ end: true }));
        controller.close();
        return;
      }
      const record = next.value;
      if ("content" in record) {
        controller.enqueue(
          line({ path: record.path, version: record.version, size: record.content.length }),
        );
        controller.enqueue(record.content);
      } else {
        controller.enqueue(line(record));
      }
      idle = setTimeout(() => {
        controller.error(new Error(`the runner took nothing for ${idleMs / 1000}s`));
        void records.return(undefined);
      }, idleMs);
      idle.unref();
    },
    async cancel() {
      clearTimeout(idle);
      await records.return(undefined);
    },
  });
  return raw.pipeThrough(new CompressionStream("gzip"));
}
