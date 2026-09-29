import type { AgentEvent, LiveTurnEvent } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import {
  applyLive,
  describeCall,
  elapsed,
  lastLine,
  toolLabel,
  transcriptTurn,
  turnsOf,
  type LiveTurns,
} from "./live.js";

let seq = 0;
function item(agent: string, project: string, event: AgentEvent): LiveTurnEvent {
  seq += 1;
  return {
    seq,
    ts: `2026-09-29T13:00:${String(seq).padStart(2, "0")}.000Z`,
    agent,
    project,
    event,
  };
}

function replay(events: readonly LiveTurnEvent[]): LiveTurns {
  return events.reduce<LiveTurns>((turns, each) => applyLive(turns, each), new Map());
}

const STARTED = {
  type: "turn_started",
  agent: "ada",
  session: "s-1",
  runner: "server",
  model: "claude-opus-5-5",
} as const;

describe("live turns", () => {
  it("follows a turn from its start to its end, pairing results with their calls", () => {
    const turns = replay([
      item("ada", "lab", STARTED),
      item("ada", "lab", { type: "text", delta: "Checking the citations.\nThen the venues." }),
      item("ada", "lab", { type: "tool_call", name: "WebFetch", input: { url: "https://a.org" } }),
      item("ada", "lab", { type: "tool_call", name: "WebFetch", input: { url: "https://b.org" } }),
      item("ada", "lab", { type: "tool_result", name: "WebFetch", ok: true }),
      item("ada", "lab", { type: "tool_result", name: "WebFetch", ok: false }),
      item("ref", "pi", { type: "tool_call", name: "Bash", input: { command: "ls" } }),
    ]);
    const ada = turns.get("ada/lab");
    expect(ada?.fromStart).toBe(true);
    expect(ada?.model).toBe("claude-opus-5-5");
    expect(
      ada?.steps.map((step) => (step.kind === "tool" ? [step.summary, step.ok] : step.kind)),
    ).toEqual(["say", ["https://a.org", true], ["https://b.org", false]]);
    expect(ada === undefined ? null : lastLine(ada)).toBe("WebFetch · https://b.org");

    const ended = applyLive(
      turns,
      item("ada", "lab", {
        type: "turn_completed",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.42,
        status: {
          summary: "Checked 44 citations.",
          claimsHeld: [],
          blockedOn: [],
          needsUserDecision: false,
          memoryUpdated: false,
        },
        exitReason: "completed",
      }),
    );
    expect(ended.get("ada/lab")?.end).toMatchObject({ exitReason: "completed", costUsd: 0.42 });
    expect(ended.get("ada/lab")?.end?.summary).toBe("Checked 44 citations.");
    expect(turns.get("ada/lab")?.end).toBeNull();
  });

  it("marks a turn whose start is no longer in the buffer, and starts over on a new turn", () => {
    const partial = replay([item("ref", "pi", { type: "text", delta: "Re-review passed." })]);
    expect(partial.get("ref/pi")?.fromStart).toBe(false);
    const next = applyLive(partial, item("ref", "pi", { ...STARTED, agent: "ref" }));
    expect(next.get("ref/pi")?.fromStart).toBe(true);
    expect(next.get("ref/pi")?.steps).toEqual([]);
  });

  it("leaves the status report to the turn's end", () => {
    const status = {
      summary: "Completion notices read.",
      claimsHeld: [],
      blockedOn: [],
      needsUserDecision: false,
      memoryUpdated: false,
    };
    const turns = replay([
      item("ref", "pi", { ...STARTED, agent: "ref" }),
      item("ref", "pi", { type: "text", delta: "Nothing to review." }),
      item("ref", "pi", { type: "tool_call", name: "StructuredOutput", input: status }),
      item("ref", "pi", { type: "tool_result", name: "StructuredOutput", ok: true }),
      item("ref", "pi", { type: "text", delta: JSON.stringify(status) }),
      item("ref", "pi", {
        type: "turn_completed",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        status,
        exitReason: "completed",
      }),
    ]);
    expect(turns.get("ref/pi")?.steps.map((step) => step.kind)).toEqual(["say"]);
    expect(turns.get("ref/pi")?.end?.summary).toBe("Completion notices read.");
  });

  it("keeps a citizen's turns in two scopes apart", () => {
    const turns = replay([
      item("ada", "pi", STARTED),
      item("ada", "paths", STARTED),
      item("ada", "paths", { type: "text", delta: "Surveying." }),
      item("ada", "pi", { type: "tool_call", name: "Read", input: { file_path: "report.md" } }),
    ]);
    expect(turnsOf(turns, "ada").map((turn) => [turn.scope, turn.steps.length])).toEqual([
      ["pi", 1],
      ["paths", 1],
    ]);
    expect(turnsOf(turns, "ref")).toEqual([]);
  });

  it("says what a call was about on one line, line breaks and all", () => {
    expect(describeCall({ command: `/bin/bash -lc "uv run pytest -q\n  echo done"` })).toEqual({
      summary: "uv run pytest -q echo done",
      detail: "uv run pytest -q\n  echo done",
    });
    expect(describeCall({ file_path: "/w/report.md", content: "x" }).summary).toBe("/w/report.md");
    expect(
      describeCall({ changes: [{ path: "a.ts", kind: "update" }, { path: "b.ts" }] }).summary,
    ).toBe("a.ts, b.ts");
    expect(describeCall({ task_id: "01M3PK", stage: "s2", note: true }).summary).toBe(
      "01M3PK · s2",
    );
    expect(toolLabel("mcp__board__advance_task")).toBe("advance_task");
    expect(toolLabel("mcp__github__list_prs")).toBe("github:list_prs");
    expect(toolLabel("Bash")).toBe("Bash");
  });

  it("counts time since a moment compactly", () => {
    const start = "2026-09-29T13:00:00.000Z";
    const at = (seconds: number): number => Date.parse(start) + seconds * 1000;
    expect(elapsed(start, at(42))).toBe("42s");
    expect(elapsed(start, at(4 * 60 + 5))).toBe("4m");
    expect(elapsed(start, at(72 * 60))).toBe("1h 12m");
  });

  it("pairs a result's output with its call", () => {
    const turns = replay([
      item("ada", "lab", STARTED),
      item("ada", "lab", { type: "tool_call", name: "Bash", input: { command: "pnpm test" } }),
      item("ada", "lab", { type: "tool_result", name: "Bash", ok: false, output: "1 failed" }),
    ]);
    expect(turns.get("ada/lab")?.steps[0]).toMatchObject({ ok: false, output: "1 failed" });
  });

  it("folds a stored transcript whole, however many steps it has", () => {
    const calls = Array.from({ length: 450 }, (_, index) => [
      {
        ts: "2026-09-29T13:00:00.000Z",
        event: { type: "tool_call" as const, name: "Read", input: { file_path: `f${index}` } },
      },
      {
        ts: "2026-09-29T13:00:01.000Z",
        event: { type: "tool_result" as const, name: "Read", ok: true, output: "x" },
      },
    ]).flat();
    const turn = transcriptTurn(
      [{ ts: "2026-09-29T12:59:59.000Z", event: STARTED }, ...calls],
      "ada",
      "lab",
    );
    expect(turn?.steps).toHaveLength(450);
    expect(turn?.fromStart).toBe(true);
    expect(turn?.steps.every((step) => step.kind === "tool" && step.output === "x")).toBe(true);
  });
});
