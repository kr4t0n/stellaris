import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Board } from "@stellaris/board-core";
import { RunnerClient } from "@stellaris/runner-core";
import { RUNNER_PROTOCOL, RunnerEnrollmentSchema, SERVER_TOKEN } from "@stellaris/shared";
import { RunnerHub, TurnHost } from "@stellaris/turn-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { EnrollmentDesk } from "./enrollment.js";
import { addWorkRoles, USER } from "./testing/scripted-backend.js";

// The limits are restated here rather than imported, so changing one means changing its test too.
const KiB = 1024;
const MiB = 1024 * KiB;

/** `value` as JSON padded with trailing whitespace, which JSON allows, to exactly `size` bytes. */
function padded(value: unknown, size: number): string {
  const json = JSON.stringify(value);
  return json + " ".repeat(size - Buffer.byteLength(json));
}

/** `value` with `field` filled so that its JSON, as the runner's client sends it, is exactly `size` bytes. */
function sized<T extends Record<string, unknown>>(value: T, field: keyof T, size: number): T {
  const filler = size - Buffer.byteLength(JSON.stringify({ ...value, [field]: "" }));
  return { ...value, [field]: "x".repeat(filler) };
}

describe("request body limits", () => {
  let dir: string;
  let board: Board;
  let hub: RunnerHub;
  let desk: EnrollmentDesk;
  let server: ServerType;
  let url: string;
  let userToken: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-body-"));
    const init = await Board.init(dir, { name: "body" });
    board = init.board;
    userToken = init.userToken;
    await board.addProject(USER, { slug: "demo" });
    await addWorkRoles(board);
    const host = new TurnHost({ board, mcpUrl: `${SERVER_TOKEN}/mcp`, residentIdleMs: 60_000 });
    hub = new RunnerHub({ board, host, version: "test" });
    desk = new EnrollmentDesk(board);
    const app = createApp({ board, version: "test", runners: hub, enrollments: desk });
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  });

  afterEach(async () => {
    await hub.close();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
    await closed;
    await rm(dir, { recursive: true, force: true });
  });

  const post = (
    route: string,
    body: string | ReadableStream<Uint8Array>,
    token?: string,
    method = "POST",
  ) =>
    fetch(`${url}${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body,
      // A stream has no declared length, so the limit counts its bytes as they arrive.
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    });

  it("refuses an enroll request or poll over 16 KiB without opening or telling anything, and takes one at it", async () => {
    const ask = {
      protocol: RUNNER_PROTOCOL,
      version: "test",
      hostname: "studio",
      os: "linux",
      clis: ["claude"],
    };
    const over = await post("/runner/enroll", padded(ask, 16 * KiB + 1));
    expect(over.status).toBe(413);
    expect(over.headers.get("connection")).toBe("close");
    expect(await over.json()).toMatchObject({ error: "PAYLOAD_TOO_LARGE" });
    // Without a declared length, the bytes are counted as they stream in.
    const bytes = new TextEncoder().encode(padded(ask, 16 * KiB + 1));
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 4 * KiB) {
          controller.enqueue(bytes.subarray(at, at + 4 * KiB));
        }
        controller.close();
      },
    });
    expect((await post("/runner/enroll", streamed)).status).toBe(413);
    expect(desk.waiting()).toEqual([]);

    const at = await post("/runner/enroll", padded(ask, 16 * KiB));
    expect(at.status).toBe(200);
    const { deviceCode, userCode } = RunnerEnrollmentSchema.parse(await at.json());
    expect(desk.waiting()).toHaveLength(1);

    // An approval is told to one poll and then forgotten, so a refused poll must not have taken it.
    await desk.approve(USER, userCode, "studio");
    expect((await post("/runner/enroll/poll", padded({ deviceCode }, 16 * KiB + 1))).status).toBe(
      413,
    );
    const told = await post("/runner/enroll/poll", padded({ deviceCode }, 16 * KiB));
    expect(told.status).toBe(200);
    expect(await told.json()).toMatchObject({ status: "approved", name: "studio" });
  });

  it("refuses a write under /api over 1 MiB without running it, and runs one at it", async () => {
    const task = { project: "demo", title: "big" };
    const over = await post("/api/verbs/create_task", padded(task, MiB + 1), userToken);
    expect(over.status).toBe(413);
    expect(await board.listTasks("demo")).toEqual([]);
    // The token is checked first: a stranger's body gets a 401, not a 413.
    expect(
      (await post("/api/verbs/create_task", padded(task, MiB + 1), "stl_nothing")).status,
    ).toBe(401);

    const charter = { purpose: "Reviews.", verbs: [], wakeTriggers: ["heartbeat"] };
    const purpose = async () =>
      (await board.listRoles()).find((each) => each.name === "reviewer")?.purpose;
    const before = await purpose();
    expect(
      (await post("/api/roles/reviewer", padded(charter, MiB + 1), userToken, "PUT")).status,
    ).toBe(413);
    expect(await purpose()).toBe(before);

    const at = await post("/api/verbs/create_task", padded(task, MiB), userToken);
    expect(at.status).toBe(200);
    expect((await board.listTasks("demo")).map((each) => each.title)).toEqual(["big"]);
    expect((await post("/api/roles/reviewer", padded(charter, MiB), userToken, "PUT")).status).toBe(
      200,
    );
    expect(await purpose()).toBe("Reviews.");
  });

  it("refuses a runner's post over 8 MiB, and an answer over 16 MiB, with a 413 its client takes as final", async () => {
    const { token } = await board.addRunner(USER, "laptop");
    const client = new RunnerClient(url, token);
    const hello = {
      protocol: RUNNER_PROTOCOL,
      version: "test",
      os: "linux" as const,
      clis: ["claude" as const],
      slots: 1,
    };
    // A refusal, not a failure to reach the server, so the runner does not post it again.
    await expect(client.hello(sized(hello, "version", 8 * MiB + 1))).rejects.toMatchObject({
      status: 413,
    });
    expect(
      (await board.listRunners()).find((each) => each.name === "laptop")?.version,
    ).toBeUndefined();
    for (const route of [
      "/runner/turns/01ARZ3NDEKTSV4RRFFQ69G5FAV/events",
      "/runner/turns/01ARZ3NDEKTSV4RRFFQ69G5FAV/outcome",
      "/runner/workspaces",
      "/runner/warm",
      "/runner/board/read",
    ]) {
      const refused = await post(route, padded({}, 8 * MiB + 1), token);
      expect({ route, status: refused.status }).toEqual({ route, status: 413 });
    }
    const at = await post("/runner/hello", padded(hello, 8 * MiB), token);
    expect(at.status).toBe(200);
    expect((await board.listRunners()).find((each) => each.name === "laptop")?.version).toBe(
      "test",
    );

    // An answer may carry a file or an image as base64, so its limit is twice as large.
    const stop = new AbortController();
    const requests: string[] = [];
    let streaming: Promise<void> = Promise.resolve();
    await new Promise<void>((opened) => {
      streaming = client.stream(stop.signal, {
        onOpen: opened,
        onMessage: (message) => {
          if (message.type === "models") requests.push(message.request);
        },
      });
    });
    const models = hub.models("claude");
    await expect.poll(() => requests.length).toBe(1);
    const option = { id: "opus", name: "Opus", description: "", isDefault: true, efforts: [] };
    const empty = Buffer.byteLength(JSON.stringify({ ok: true, value: [option] }));
    const answer = (size: number) => ({
      ok: true as const,
      value: [{ ...option, description: "x".repeat(size - empty) }],
    });
    await expect(client.answer(requests[0] ?? "", answer(16 * MiB + 1))).rejects.toMatchObject({
      status: 413,
    });
    await client.answer(requests[0] ?? "", answer(16 * MiB));
    // The answer at the limit is the one the read got, so the refused one never reached it.
    expect((await models)[0]?.description).toHaveLength(16 * MiB - empty);
    stop.abort();
    await streaming.catch(() => undefined);
  });
});
