import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * Asking to enroll and polling for the answer, which anyone may do without a token. The largest
 * body a runner sends, every field at the longest the schema accepts, is under 8 KB, and under 15 KB
 * with every character escaped as `\uXXXX`; a real request is under 200 bytes, and a poll 60.
 */
export const ENROLL_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * A write under `/api`. `/api/verbs` takes the inputs the MCP tools take, so this is the 1 MiB
 * `/mcp` allows, 17 times the largest real one, a knowledge topic of 60 KB; a charter, the other
 * large body, is under 4 KB.
 */
export const API_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * A runner's hello, its reports, a turn's steps, and its outcome. Nothing bounds a batch of steps
 * but the CLI's output, as a file a tool call writes whole: the largest real one was 132 KB, a post
 * with an image inlined, and an outcome 6 KB. A refused outcome never reaches the board, which then
 * takes the turn as running until the runner registers again, so the margin is wide.
 */
export const RUNNER_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * A runner's answer to a request, which carries a file read on a branch or an image a turn
 * uploads, each up to 8 MiB (`BRANCH_FILE_LIMIT_BYTES`, `IMAGE_LIMIT_BYTES`), as base64: 10.7 MiB,
 * and room for the rest of the answer.
 */
export const RUNNER_ANSWER_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Refuses a request whose body is over `maxSize` bytes with a 413, before anything reads it: by its
 * declared length, or once the bytes streamed in pass it. Neither `@hono/node-server` nor hono
 * limits a body on its own.
 *
 * The refusal closes the connection. `@hono/node-server` drops a connection whose body went unread
 * after the answer anyway, and an answer that offered to keep it open let the client send its next
 * request there and see it fail. A client still sending a large body may yet see the connection
 * reset rather than the 413, and a runner then posts again until it reads the 413.
 */
export function limitBody(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: (c) => {
      c.header("connection", "close");
      return c.json(
        {
          error: "PAYLOAD_TOO_LARGE",
          message: `the request body is over the ${maxSize} bytes this route takes`,
        },
        413,
      );
    },
  });
}
