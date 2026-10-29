import { once } from "node:events";
import type { Writable } from "node:stream";
import { MOVE_PACK_LIMIT_BYTES } from "@stellaris/shared";
import { execa } from "execa";
import { liftDeadline } from "./serve.js";

/** The smart HTTP protocol's three requests; nothing else of a repository is served. */
const SMART_PATHS = new Set(["/info/refs", "/git-upload-pack", "/git-receive-pack"]);
/**
 * A home is markdown, and a move carries a project's packs, which the old runner measures against
 * the same limit before it pushes; a request past this is refused as soon as it passes it.
 */
const MAX_BYTES = MOVE_PACK_LIMIT_BYTES;
/**
 * How long a request may send nothing before the board gives up on it: a runner's git gives up on
 * a transfer under 1,000 bytes a second for as long, and a dead peer would otherwise hold its
 * `http-backend`, and a home's later pushes behind it, for good.
 */
const IDLE_MS = 5 * 60_000;

export interface HomeGitRequest {
  /**
   * The directory holding the repository: every home, each named for its agent, or the moves'
   * repositories, each named for its move.
   */
  readonly root: string;
  /** The repository's directory under `root`: an agent's name, or a move's `<id>.git`. */
  readonly repository: string;
  /** The path after the home's `/git`, such as `/info/refs`. */
  readonly rest: string;
  readonly request: Request;
  /** Who is pushing or fetching, for git's own records. */
  readonly runner: string;
  /** How long the request may send nothing; five minutes unless a test shortens it. */
  readonly idleMs?: number | undefined;
  /** The most the request may carry; `MOVE_PACK_LIMIT_BYTES` unless a test lowers it. */
  readonly limitBytes?: number | undefined;
}

/** How feeding a request's body to `http-backend` ended. */
type Fed = "done" | "too large" | "idle" | "cut" | "stopped";

/**
 * Writes a request's body into `http-backend` as it arrives, at the pace git reads it: so git
 * indexes a pack while the rest is on its way, and the board holds no more of it than a pipe does.
 * It stops at the first byte past `limit`, after `idleMs` with nothing new, when the client goes
 * (`cut`), or when `http-backend` stops reading (`stopped`), whose answer then says why. A body
 * stopped or past the limit is left unread, so the answer still reaches the client.
 *
 * Nothing here races a read against a promise that outlives it: each race would hang a reaction
 * holding that read's chunk on the longer promise, and a 128 MiB push kept 136 MiB of them.
 */
async function feed(
  body: ReadableStream<Uint8Array> | null,
  stdin: Writable,
  limit: number,
  idleMs: number,
): Promise<Fed> {
  if (body === null) {
    stdin.end();
    return "done";
  }
  const reader = body.getReader();
  const waits = new AbortController();
  let ended: Exclude<Fed, "done"> | null = null;
  const endedAs = (): Exclude<Fed, "done"> | null => ended;
  // A client gone or silent loses its connection; any other end leaves the rest unread. Either
  // settles a read in flight, and `waits` a wait for the pipe to drain.
  const end = (why: Exclude<Fed, "done">): Exclude<Fed, "done"> => {
    if (ended === null) {
      ended = why;
      waits.abort();
      if (why === "idle" || why === "cut") {
        reader.cancel().catch(() => undefined);
      } else {
        reader.releaseLock();
      }
    }
    return ended;
  };
  const timer = setTimeout(() => end("idle"), idleMs);
  const stopped = (): void => {
    end("stopped");
  };
  // `http-backend` that exits before reading everything fails the next write with EPIPE.
  stdin.on("error", stopped);
  stdin.once("close", stopped);
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read().catch(() => null);
      const early = endedAs();
      if (early !== null) {
        return early;
      }
      if (next === null) {
        return end("cut");
      }
      if (next.done) {
        stdin.end();
        return "done";
      }
      timer.refresh();
      total += next.value.byteLength;
      if (total > limit) {
        return end("too large");
      }
      if (!stdin.write(next.value)) {
        const drained = await once(stdin, "drain", { signal: waits.signal }).then(
          () => true,
          () => false,
        );
        if (!drained) {
          return end("stopped");
        }
      }
    }
  } finally {
    clearTimeout(timer);
    stdin.off("close", stopped);
  }
}

/** Splits a CGI answer into its status, headers, and body. */
function parseCgi(output: Buffer): Response {
  const crlf = output.indexOf("\r\n\r\n");
  const lf = output.indexOf("\n\n");
  const [end, gap] =
    crlf !== -1 && (lf === -1 || crlf < lf) ? [crlf, 4] : lf !== -1 ? [lf, 2] : [-1, 0];
  if (end === -1) {
    return new Response("git http-backend answered nothing usable", { status: 502 });
  }
  const headers = new Headers();
  let status = 200;
  for (const line of output.subarray(0, end).toString("utf8").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") {
      status = Number.parseInt(value, 10) || 200;
    } else {
      headers.append(name, value);
    }
  }
  return new Response(output.subarray(end + gap), { status, headers });
}

/**
 * The board's git endpoint for homes. Pushes to one home are taken one at a time: a push into a
 * checked-out branch (`updateInstead`) rewrites the working tree before it takes the branch's lock,
 * so of two pushes at once the loser could leave its files on disk while the branch kept the
 * winner's, and every later push would be refused as dirty. Fetches run side by side.
 */
export class HomeGit {
  private readonly pushes = new Map<string, Promise<unknown>>();

  serve(input: HomeGitRequest): Promise<Response> {
    // Authorized by now, and a push may wait here behind another to the same home.
    liftDeadline(input.request);
    if (input.rest !== "/git-receive-pack") {
      return serveHomeGit(input);
    }
    const previous = this.pushes.get(input.repository) ?? Promise.resolve();
    const run = previous.then(
      () => serveHomeGit(input),
      () => serveHomeGit(input),
    );
    this.pushes.set(
      input.repository,
      run.catch(() => undefined),
    );
    return run;
  }
}

/**
 * Serves one smart-HTTP request against a repository on the board, an agent's home or a move's,
 * through `git http-backend`, which ships with git: clones and fetches through `git-upload-pack`,
 * pushes through `git-receive-pack`, where a home's own hook and `updateInstead` take over.
 * Authentication and the check of who may reach the repository happen before this is called, so
 * the request's deadline gives way to the idle limit: a pack takes as long as it keeps arriving.
 */
export async function serveHomeGit(input: HomeGitRequest): Promise<Response> {
  if (!SMART_PATHS.has(input.rest)) {
    return new Response("not a smart HTTP path", { status: 404 });
  }
  const { request } = input;
  const limit = input.limitBytes ?? MAX_BYTES;
  const length = request.headers.get("content-length");
  // git posts a pack past `http.postBuffer` in chunks, with no length, and the rest with one.
  const declared = length !== null && /^\d+$/.test(length) ? length : null;
  if (declared !== null && Number(declared) > limit) {
    return new Response("pack too large for the board to take", { status: 413 });
  }
  liftDeadline(request);
  const url = new URL(request.url);
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/tmp",
    GIT_PROJECT_ROOT: input.root,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: request.method,
    PATH_INFO: `/${input.repository}${input.rest}`,
    QUERY_STRING: url.search.replace(/^\?/, ""),
    CONTENT_TYPE: request.headers.get("content-type") ?? "",
    REMOTE_USER: input.runner,
    REMOTE_ADDR: "127.0.0.1",
  };
  // With no length, `http-backend` reads the body to its end.
  if (declared !== null) {
    env["CONTENT_LENGTH"] = declared;
  }
  const encoding = request.headers.get("content-encoding");
  if (encoding !== null) {
    env["HTTP_CONTENT_ENCODING"] = encoding;
  }
  const protocol = request.headers.get("git-protocol");
  if (protocol !== null) {
    env["HTTP_GIT_PROTOCOL"] = protocol;
  }
  const backend = execa("git", ["http-backend"], {
    env,
    extendEnv: false,
    encoding: "buffer",
    // The blank line that ends the headers ends the whole answer when the body is empty, as for
    // the 4-byte probe git sends before a pack too large for one post; stripped, it reads as none.
    stripFinalNewline: false,
    reject: false,
    maxBuffer: MAX_BYTES,
  });
  const fed = await feed(request.body, backend.stdin, limit, input.idleMs ?? IDLE_MS);
  if (fed !== "done" && fed !== "stopped") {
    backend.kill();
    await backend;
    return fed === "too large"
      ? new Response("pack too large for the board to take", { status: 413 })
      : new Response(fed === "idle" ? "the request stopped arriving" : "the request was cut", {
          status: fed === "idle" ? 408 : 400,
        });
  }
  const result = await backend;
  if (result.exitCode !== 0 && result.stdout.length === 0) {
    return new Response(`git http-backend failed: ${Buffer.from(result.stderr).toString("utf8")}`, {
      status: 500,
    });
  }
  return parseCgi(Buffer.from(result.stdout));
}
