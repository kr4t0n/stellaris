import type { BoardEvent } from "@stellaris/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { followBoardEvents, staleKeys } from "./events.js";

function event(type: BoardEvent["type"], payload: Record<string, unknown>, id: string): BoardEvent {
  return { id, ts: "2026-09-29T10:00:00.000Z", type, actor: "ada", payload };
}

describe("board events", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the reads each event makes stale", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(
      staleKeys(event("message.posted", { channel: "lab/general", thread: null }, id)),
    ).toEqual([["channels"], ["channel", "lab/general"]]);
    expect(staleKeys(event("message.posted", { channel: "lab/general", thread: id }, id))).toEqual([
      ["threads"],
      ["thread", id],
    ]);
    expect(staleKeys(event("task.advanced", { taskId: id, project: "lab" }, id))).toEqual([
      ["tasks"],
      ["task", id],
      ["members"],
    ]);
    expect(staleKeys(event("turn.started", {}, id))).toEqual([["scheduler"], ["members"]]);
    expect(staleKeys(event("turn.completed", { project: "lab" }, id))).toEqual([
      ["scheduler"],
      ["members"],
      ["turns", "ada"],
      ["memory", "ada"],
      ["agent-skills", "ada"],
    ]);
    expect(staleKeys(event("knowledge.written", { topic: "x", project: null }, id))).toEqual([
      ["knowledge", "society"],
    ]);
    expect(staleKeys(event("knowledge.written", { topic: "x", project: "lab" }, id))).toEqual([
      ["knowledge", "lab"],
    ]);
    expect(staleKeys(event("proposal.decided", { proposalId: id }, id))).toEqual([
      ["proposals"],
      ["proposal", id],
    ]);
    expect(staleKeys(event("ops.signal", {}, id))).toEqual([]);
  });

  it("reads frames split across chunks and resumes after the last event it saw", async () => {
    const first = event("turn.started", {}, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    const second = event("turn.completed", {}, "01ARZ3NDEKTSV4RRFFQ69G5FAW");
    const frames = [first, second]
      .map((each) => `event: ${each.type}\ndata: ${JSON.stringify(each)}\nid: ${each.id}\n\n`)
      .join("");
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      const body =
        urls.length === 1
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                const bytes = new TextEncoder().encode(frames);
                controller.enqueue(bytes.slice(0, 40));
                controller.enqueue(bytes.slice(40));
                controller.close();
              },
            })
          : new ReadableStream<Uint8Array>();
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const seen: string[] = [];
    let resumed = 0;
    const stop = followBoardEvents("stl_token", {
      onEvent: (each) => seen.push(each.type),
      onResume: () => {
        resumed += 1;
      },
    });
    await vi.waitFor(() => expect(urls).toHaveLength(2), { timeout: 3_000 });
    stop();
    expect(seen).toEqual(["turn.started", "turn.completed"]);
    expect(urls).toEqual([
      "/api/events/stream?since=latest",
      `/api/events/stream?since=${second.id}`,
    ]);
    expect(resumed).toBe(1);
  });
});
