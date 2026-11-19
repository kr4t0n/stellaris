import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { readBoardEvent, unknownEventType } from "./index.js";

const known = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  ts: "2026-11-19T06:00:00.000Z",
  type: "paused.changed",
  actor: "user",
  payload: { paused: true },
};

describe("event types", () => {
  it("reads an event of a type it knows whole, and none of a type it doesn't", () => {
    expect(readBoardEvent(known)).toEqual(known);
    expect(unknownEventType(known)).toBeNull();

    const unknown = { ...known, type: "garden.watered" };
    expect(readBoardEvent(unknown)).toBeNull();
    expect(unknownEventType(unknown)).toBe("garden.watered");
    // Only the type decides: an unknown type is skipped however the rest reads.
    expect(readBoardEvent({ type: "garden.watered" })).toBeNull();
  });

  it("still refuses a malformed event of a type it knows, and a type that isn't a string", () => {
    const unpaid = { id: known.id, ts: known.ts, type: known.type, actor: known.actor };
    expect(() => readBoardEvent(unpaid)).toThrow(ZodError);
    expect(() => readBoardEvent({ ...known, actor: "" })).toThrow(ZodError);
    expect(() => readBoardEvent({ ...known, type: 7 })).toThrow(ZodError);
    expect(() => readBoardEvent({ ...known, type: undefined })).toThrow(ZodError);
    expect(() => readBoardEvent(null)).toThrow(ZodError);
    expect(() => readBoardEvent("paused.changed")).toThrow(ZodError);
    expect(unknownEventType({ ...known, type: 7 })).toBeNull();
    expect(unknownEventType(null)).toBeNull();
  });
});
