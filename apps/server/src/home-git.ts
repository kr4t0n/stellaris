import { execa } from "execa";

/** The smart HTTP protocol's three requests; nothing else of a repository is served. */
const SMART_PATHS = new Set(["/info/refs", "/git-upload-pack", "/git-receive-pack"]);
/** A home is markdown; a pack past this is refused rather than buffered. */
const MAX_BYTES = 256 * 1024 * 1024;

export interface HomeGitRequest {
  /** The directory holding every home, each a repository named for its agent. */
  readonly root: string;
  readonly agent: string;
  /** The path after the home's `/git`, such as `/info/refs`. */
  readonly rest: string;
  readonly request: Request;
  /** Who is pushing or fetching, for git's own records. */
  readonly runner: string;
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
    if (input.rest !== "/git-receive-pack") {
      return serveHomeGit(input);
    }
    const previous = this.pushes.get(input.agent) ?? Promise.resolve();
    const run = previous.then(
      () => serveHomeGit(input),
      () => serveHomeGit(input),
    );
    this.pushes.set(
      input.agent,
      run.catch(() => undefined),
    );
    return run;
  }
}

/**
 * Serves one smart-HTTP request against an agent's home repository through `git http-backend`,
 * which ships with git: clones and fetches through `git-upload-pack`, pushes through
 * `git-receive-pack`, where the home's own hook and `updateInstead` take over. Authentication and
 * the turn-in-flight check happen before this is called.
 */
export async function serveHomeGit(input: HomeGitRequest): Promise<Response> {
  if (!SMART_PATHS.has(input.rest)) {
    return new Response("not a smart HTTP path", { status: 404 });
  }
  const { request } = input;
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > MAX_BYTES) {
    return new Response("pack too large for a home", { status: 413 });
  }
  const url = new URL(request.url);
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/tmp",
    GIT_PROJECT_ROOT: input.root,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: request.method,
    PATH_INFO: `/${input.agent}${input.rest}`,
    QUERY_STRING: url.search.replace(/^\?/, ""),
    CONTENT_TYPE: request.headers.get("content-type") ?? "",
    CONTENT_LENGTH: String(body.length),
    REMOTE_USER: input.runner,
    REMOTE_ADDR: "127.0.0.1",
  };
  const encoding = request.headers.get("content-encoding");
  if (encoding !== null) {
    env["HTTP_CONTENT_ENCODING"] = encoding;
  }
  const protocol = request.headers.get("git-protocol");
  if (protocol !== null) {
    env["HTTP_GIT_PROTOCOL"] = protocol;
  }
  const result = await execa("git", ["http-backend"], {
    env,
    extendEnv: false,
    input: body,
    encoding: "buffer",
    reject: false,
    maxBuffer: MAX_BYTES,
  });
  if (result.exitCode !== 0 && result.stdout.length === 0) {
    return new Response(`git http-backend failed: ${Buffer.from(result.stderr).toString("utf8")}`, {
      status: 500,
    });
  }
  return parseCgi(Buffer.from(result.stdout));
}
