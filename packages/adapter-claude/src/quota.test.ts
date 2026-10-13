import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnRequest } from "@stellaris/runner-core";
import { describe, expect, it } from "vitest";
import {
  ClaudeAgentBackend,
  quotaFromRateLimit,
  quotaFromUsage,
  type QueryFn,
  type QueryStream,
} from "./index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const AT = new Date("2026-10-13T12:00:00.000Z");

async function recorded(file: string): Promise<SDKMessage[]> {
  const raw = await readFile(path.join(fixtures, file), "utf8");
  return (
    raw
      .trim()
      .split("\n")
      // Recorded SDK frames are trusted fixtures; the union is far too large to validate here.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      .map((line) => JSON.parse(line) as SDKMessage)
  );
}

function replay(messages: readonly SDKMessage[]): QueryFn {
  return () =>
    (async function* () {
      for (const message of messages) {
        yield message;
      }
    })();
}

const request: TurnRequest = {
  spec: {
    agent: "cc",
    project: "demo",
    cli: "claude",
    runner: "pod",
    cwd: "/tmp/wt",
    repoDir: "/tmp/repo",
    configHome: "/tmp/home",
    boardDir: "/tmp/board",
  },
  session: "recorded",
  newSession: false,
  prompt: "Digest.",
  instructions: "# cc",
  mcp: { url: "http://127.0.0.1:4791/mcp", token: "t" },
  limits: { timeoutMs: 60_000 },
  statusSchema: { type: "object" },
};

function backend(queryFn: QueryFn): ClaudeAgentBackend {
  return new ClaudeAgentBackend({
    queryFn,
    sessionExists: () => Promise.resolve(true),
    now: () => AT,
  });
}

describe("a turn's rate-limit events", () => {
  /**
   * The review turn recorded on 2026-09-28 streams one `rate_limit_event` after the first model
   * reply, with the 5-hour and 7-day windows under `unifiedWindows` as fractions of one.
   */
  it("report the recorded turn's windows in percent, with their resets", async () => {
    const result = await backend(replay(await recorded("sdk-review-recorded.jsonl"))).runTurn(
      request,
    );
    expect(result.exitReason).toBe("completed");
    expect(result.quota).toEqual({
      observedAt: AT.toISOString(),
      source: "turn",
      status: "allowed",
      limitedUntil: null,
      limitedBy: null,
      plan: null,
      windows: [
        {
          key: "five_hour",
          minutes: 300,
          usedPercent: 13,
          resetsAt: "2026-09-28T16:30:00.000Z",
          observedAt: AT.toISOString(),
        },
        {
          key: "seven_day",
          minutes: 10_080,
          usedPercent: 41,
          resetsAt: "2026-09-29T05:00:00.000Z",
          observedAt: AT.toISOString(),
        },
      ],
      credits: null,
      extraUsage: null,
    });
  });

  it("read the steered turn's recorded event the same way", async () => {
    const event = (await recorded("sdk-steered-recorded.jsonl")).find(
      (message) => message.type === "rate_limit_event",
    );
    if (event?.type !== "rate_limit_event") {
      throw new Error("the recording has a rate-limit event");
    }
    const quota = quotaFromRateLimit(event.rate_limit_info, AT);
    expect(quota?.status).toBe("allowed");
    expect(quota?.windows.map((window) => [window.key, window.usedPercent])).toEqual([
      ["five_hour", 35],
      ["seven_day", 2],
    ]);
    // Nothing about the account or its overage settings is kept.
    expect(JSON.stringify(quota)).not.toMatch(/overage|org_level/);
  });

  it("read a warning, a refusal, and a binding window the event names but does not list", () => {
    expect(quotaFromRateLimit({ status: "allowed_warning" }, AT)?.status).toBe("warning");
    const refused = quotaFromRateLimit(
      { status: "rejected", resetsAt: 1_791_802_800, rateLimitType: "five_hour" },
      AT,
    );
    expect(refused).toMatchObject({
      status: "limited",
      limitedUntil: "2026-10-12T11:00:00.000Z",
      limitedBy: "five_hour",
      windows: [{ key: "five_hour", usedPercent: 100, resetsAt: "2026-10-12T11:00:00.000Z" }],
    });
    expect(quotaFromRateLimit({ status: "unknown" }, AT)).toBeNull();
    expect(quotaFromRateLimit(null, AT)).toBeNull();
  });
});

/**
 * A turn the plan's limit refused, shaped as pod's Claude Code 2.1.283 ended thirteen turns on
 * 2026-10-12: a synthetic assistant message marked `rate_limit` whose text says when the limit
 * lifts, then a result with no status object. The `rejected` event before it is what the SDK's
 * `SDKRateLimitInfo` describes; the turns' transcripts kept the same fields as `quotaLimits`.
 */
function limitTurn(withEvent: boolean): SDKMessage[] {
  const text = "You've hit your session limit · resets 11am (UTC)";
  const frames: unknown[] = [
    ...(withEvent
      ? [
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              resetsAt: 1_791_802_800,
              rateLimitType: "five_hour",
              overageStatus: "rejected",
              overageDisabledReason: "org_level_disabled",
              isUsingOverage: false,
            },
            uuid: "00000000-0000-4000-8000-000000000001",
            session_id: "recorded",
          },
        ]
      : []),
    {
      type: "assistant",
      message: {
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: "<synthetic>",
        stop_reason: "stop_sequence",
        stop_sequence: "",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: "text", text }],
      },
      parent_tool_use_id: null,
      error: "rate_limit",
      uuid: "00000000-0000-4000-8000-000000000002",
      session_id: "recorded",
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      result: text,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      duration_ms: 1,
      duration_api_ms: 0,
      num_turns: 1,
      session_id: "recorded",
      uuid: "00000000-0000-4000-8000-000000000003",
    },
  ];
  // Hand-built frames in the SDK's shapes, as above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return frames as SDKMessage[];
}

describe("a turn the plan's limit refused", () => {
  it("fails with the CLI's words and reports the limit until its reset", async () => {
    const result = await backend(replay(limitTurn(true))).runTurn(request);
    expect(result.exitReason).toBe("error");
    expect(result.error).toBe(
      "usage limit reached: You've hit your session limit · resets 11am (UTC)",
    );
    expect(result.quota).toMatchObject({
      status: "limited",
      limitedUntil: "2026-10-12T11:00:00.000Z",
      limitedBy: "five_hour",
    });
  });

  it("reports a limit with no known end when no refusal event came first", async () => {
    const result = await backend(replay(limitTurn(false))).runTurn(request);
    expect(result.exitReason).toBe("error");
    expect(result.error).toMatch(/^usage limit reached: /);
    expect(result.quota).toMatchObject({ status: "limited", limitedUntil: null, windows: [] });
  });
});

/** The usage read's answer as `SDKControlGetUsageResponse` documents it, with a model's window. */
const USAGE = {
  session: {
    total_cost_usd: 0,
    total_api_duration_ms: 0,
    total_duration_ms: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: {},
  },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 35, resets_at: "2026-10-13T15:00:00Z" },
    seven_day: { utilization: 100, resets_at: "2026-10-15T05:00:00Z" },
    seven_day_oauth_apps: null,
    seven_day_opus: { utilization: 12.5, resets_at: null },
    model_scoped: [{ display_name: "Fable", utilization: 40, resets_at: "2026-10-15T05:00:00Z" }],
    extra_usage: {
      is_enabled: false,
      monthly_limit: null,
      used_credits: null,
      utilization: null,
      currency: "USD",
    },
  },
  behaviors: null,
};

describe("the usage read", () => {
  it("asks a query that takes no turn, skipping the transcript scan, and closes it", async () => {
    const asked: unknown[] = [];
    let closed = false;
    const queryFn: QueryFn = (params) => {
      expect(typeof params.prompt).not.toBe("string");
      const stream: QueryStream = {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<SDKMessage>>(() => undefined),
        }),
        close: () => {
          closed = true;
        },
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (opts) => {
          asked.push(opts);
          // The documented answer, typed loosely here as the adapter reads it.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          return Promise.resolve(USAGE as never);
        },
      };
      return stream;
    };
    const quota = await backend(queryFn).readQuota();
    expect(asked).toEqual([{ skipBehaviors: true }]);
    expect(closed).toBe(true);
    expect(quota).toMatchObject({
      source: "read",
      // The 7-day window is used up, so the plan is limited until it resets.
      status: "limited",
      limitedUntil: "2026-10-15T05:00:00.000Z",
      limitedBy: "seven_day",
      plan: "max",
      extraUsage: { enabled: false, monthlyLimit: null, usedCredits: null, currency: "USD" },
    });
    expect(quota.windows.map((window) => [window.key, window.usedPercent, window.resetsAt])).toEqual(
      [
        ["five_hour", 35, "2026-10-13T15:00:00.000Z"],
        ["seven_day", 100, "2026-10-15T05:00:00.000Z"],
        ["seven_day_opus", 12.5, null],
        ["model:Fable", 40, "2026-10-15T05:00:00.000Z"],
      ],
    );
    expect(quota.windows[3]?.label).toBe("Fable");
  });

  it("reads a login without plan limits as none", () => {
    const quota = quotaFromUsage(
      { ...USAGE, subscription_type: null, rate_limits_available: false, rate_limits: null },
      AT,
    );
    expect(quota).toMatchObject({ status: "none", windows: [], plan: null });
  });

  it("rejects when this Claude Code has no usage read", async () => {
    let closed = false;
    const queryFn: QueryFn = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<SDKMessage>>(() => undefined),
      }),
      close: () => {
        closed = true;
      },
    });
    await expect(backend(queryFn).readQuota()).rejects.toThrow("cannot read its usage");
    expect(closed).toBe(true);
  });
});
