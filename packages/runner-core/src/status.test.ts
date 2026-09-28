import { describe, expect, it } from "vitest";
import { parseTurnStatus } from "./status.js";

describe("parseTurnStatus", () => {
  it("prefers structured output and falls back to a fenced JSON block or a trailing object", () => {
    const structured = parseTurnStatus({ summary: "did the thing", claimsHeld: [] }, "");
    expect(structured?.summary).toBe("did the thing");
    expect(structured?.needsOwnerDecision).toBe(false);

    const fenced = parseTurnStatus(
      null,
      'Done.\n```json\n{"summary":"from text","needsOwnerDecision":true}\n```\n',
    );
    expect(fenced?.summary).toBe("from text");
    expect(fenced?.needsOwnerDecision).toBe(true);

    const trailing = parseTurnStatus(null, 'All good. {"summary":"trailing"}');
    expect(trailing?.summary).toBe("trailing");

    expect(parseTurnStatus(null, "no json here")).toBeNull();
    expect(parseTurnStatus({ summary: "" }, "")).toBeNull();
  });
});
