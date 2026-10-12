import type { MessageRef } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { MessageLookup } from "./messages.js";

const ref = (id: string): MessageRef => ({
  id,
  author: "stew",
  channel: "general",
  ts: "2026-10-12T05:32:05.433Z",
});

const A = "01M4Q9HGDSESZHN48ZW7VSEE6E";
const B = "01M4Q9J0ZPQZM11VPQ4ZFAPY12";
const TURN = "01M4Q9KG75PX6G2GHBHSQMVMHV";

describe("MessageLookup", () => {
  it("asks for every id wanted in one pass together, and each id once", async () => {
    const asked: string[][] = [];
    const lookup = new MessageLookup(async (ids) => {
      asked.push([...ids]);
      return ids.filter((id) => id !== TURN).map(ref);
    });
    let changes = 0;
    lookup.subscribe(() => changes++);
    lookup.want([A, TURN]);
    lookup.want([B, A]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toEqual([[A, TURN, B]]);
    expect(lookup.snapshot().map((each) => each.id)).toEqual([A, B]);
    expect(changes).toBe(1);

    // A turn's id named no message, and is not asked for again; neither are the messages found.
    const before = lookup.snapshot();
    lookup.want([A, B, TURN]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toHaveLength(1);
    expect(lookup.snapshot()).toBe(before);
  });

  it("leaves ids unknown when the board cannot be asked", async () => {
    const lookup = new MessageLookup(async () => {
      throw new Error("no route");
    });
    lookup.want([A]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lookup.snapshot()).toEqual([]);
  });
});
