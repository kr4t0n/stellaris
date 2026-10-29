import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MOVE_PACK_LIMIT_BYTES } from "@stellaris/shared";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveHomeGit } from "./home-git.js";

/** A push's body that sends `head`, then `more` bytes in 64 KiB chunks, then nothing, never ending. */
function stalled(head: string, more = 0): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
    },
    pull(controller) {
      if (sent >= more) {
        return new Promise(() => undefined);
      }
      sent += 64 * 1024;
      controller.enqueue(new Uint8Array(64 * 1024));
      return undefined;
    },
  });
}

function push(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request("http://board.test/runner/moves/x/git/git-receive-pack", {
    method: "POST",
    headers: { "content-type": "application/x-git-receive-pack-request", ...headers },
    body,
    duplex: "half",
  });
}

describe("the board's git endpoint", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "stellaris-home-git-"));
    await execa("git", ["init", "--quiet", "--bare", path.join(root, "demo.git")]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("answers the probe git posts before a pack too large for one post", async () => {
    // Past `http.postBuffer`, git first posts a flush packet alone, and goes on only on a 200.
    const response = await serveHomeGit({
      root,
      repository: "demo.git",
      rest: "/git-receive-pack",
      request: new Request("http://board.test/runner/moves/x/git/git-receive-pack", {
        method: "POST",
        headers: { "content-type": "application/x-git-receive-pack-request" },
        body: "0000",
      }),
      runner: "runner-1",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-git-receive-pack-result");
  });

  it(
    "refuses a pack declared past the cap before reading any of it",
    { timeout: 5_000 },
    async () => {
      const response = await serveHomeGit({
        root,
        repository: "demo.git",
        rest: "/git-receive-pack",
        request: push(stalled("0000"), { "content-length": String(MOVE_PACK_LIMIT_BYTES + 1) }),
        runner: "runner-1",
      });
      expect(response.status).toBe(413);
    },
  );

  it("refuses a request as soon as what arrived passes the cap", { timeout: 5_000 }, async () => {
    // `http-backend` reads a fetch's whole request before it starts `upload-pack`, so it reads on.
    const response = await serveHomeGit({
      root,
      repository: "demo.git",
      rest: "/git-upload-pack",
      request: push(stalled("", 1024 * 1024), {
        "content-type": "application/x-git-upload-pack-request",
      }),
      runner: "runner-1",
      limitBytes: 512 * 1024,
    });
    expect(response.status).toBe(413);
  });

  it(
    "gives up on a push that stops arriving once its idle limit passes",
    { timeout: 5_000 },
    async () => {
      const response = await serveHomeGit({
        root,
        repository: "demo.git",
        rest: "/git-receive-pack",
        request: push(stalled("00")),
        runner: "runner-1",
        idleMs: 200,
      });
      expect(response.status).toBe(408);
    },
  );
});
