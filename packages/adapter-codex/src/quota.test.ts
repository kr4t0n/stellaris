import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { TurnRequest } from "@stellaris/runner-core";
import { CliQuotaSchema, turnStatusJsonSchema } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import type { SpawnAppServer } from "./app-server.js";
import { CodexBackend } from "./backend.js";
import { mergeSnapshot, quotaFromRead, quotaFromSnapshot } from "./quota.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const AT = new Date("2026-10-13T12:00:00.000Z");

function isResponse(line: string): boolean {
  return /^\{"id":\d+,"result"/.test(line);
}

async function lines(fixture: string): Promise<string[]> {
  return (await readFile(path.join(fixtures, fixture), "utf8")).trim().split("\n");
}

/**
 * Replays what a real server wrote, as the recorded-turn tests do: each request is answered by the
 * recorded response with its id, followed by the notifications recorded after it.
 */
function replay(recorded: readonly string[]): { spawn: SpawnAppServer; methods: string[] } {
  const methods: string[] = [];
  const spawn: SpawnAppServer = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const { promise: exited, resolve: exit } = Promise.withResolvers<number | null>();
    let at = 0;
    stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const message: unknown = JSON.parse(line);
        if (typeof message !== "object" || message === null) continue;
        if ("method" in message && typeof message.method === "string") methods.push(message.method);
        if (!("id" in message)) continue;
        const answer = recorded.findIndex((each, index) => index >= at && isResponse(each));
        let end = answer + 1;
        while (end < recorded.length && !isResponse(recorded[end] ?? "")) end += 1;
        stdout.write(`${recorded.slice(at, end).join("\n")}\n`);
        at = end;
      }
    });
    return { stdin, stdout, stderr: new PassThrough(), exited, kill: () => exit(null) };
  };
  return { spawn, methods };
}

const request: TurnRequest = {
  spec: {
    agent: "probe",
    project: "probe",
    cli: "codex",
    runner: "pod",
    cwd: "/tmp/codex-probe/wt",
    repoDir: "/tmp/codex-probe/wt",
    configHome: "/tmp/codex-probe",
    boardDir: "/tmp/codex-probe",
  },
  session: "pending-1",
  newSession: true,
  prompt: "",
  instructions: "You are a probe for an adapter test.",
  mcp: { url: "http://127.0.0.1:9/mcp", token: "probe" },
  limits: { timeoutMs: 60_000 },
  statusSchema: turnStatusJsonSchema(),
};

const WEEKLY = {
  key: "primary",
  minutes: 10_080,
  usedPercent: 2,
  resetsAt: "2026-10-20T05:11:58.000Z",
  observedAt: AT.toISOString(),
};

/**
 * A turn recorded through this adapter from `codex app-server` 0.162 on pod on 2026-10-13, on the
 * runner's own login: the server sends `account/rateLimits/updated` once the turn's request is
 * answered. The credit balance is replaced by a placeholder, and the machine's ids by `redacted`.
 */
describe("a recorded Codex turn's rate limits", () => {
  it("report the plan's weekly window, plan, and credits", async () => {
    const { spawn } = replay(await lines("app-server-quota-recorded.jsonl"));
    const result = await new CodexBackend({ spawn, now: () => AT }).runTurn(request);
    expect(result.exitReason).toBe("completed");
    expect(result.quota).toEqual({
      observedAt: AT.toISOString(),
      source: "turn",
      status: "allowed",
      limitedUntil: null,
      limitedBy: null,
      plan: "pro",
      windows: [WEEKLY],
      credits: { hasCredits: true, unlimited: false, balance: "100.0000000000" },
      extraUsage: null,
    });
  });

  it("are absent from a turn whose server sent none, as on the 0.156 recordings", async () => {
    const { spawn } = replay(await lines("app-server-start-recorded.jsonl"));
    const result = await new CodexBackend({ spawn }).runTurn(request);
    expect(result.exitReason).toBe("completed");
    expect(result.quota).toBeUndefined();
  });
});

/**
 * The recorded turn with its end replaced as `codex app-server` describes one: an `error` whose
 * `codexErrorInfo` is `usageLimitExceeded`, a rolling update with the window used up, and the
 * turn completed as failed.
 */
async function limitTurn(): Promise<string[]> {
  const recorded = await lines("app-server-quota-recorded.jsonl");
  const started = recorded.findIndex((line) => line.includes('"method":"turn/started"'));
  const thread = "01a13547-73c0-70b3-8272-6815eabfc6f5";
  const turn = "01a13547-76f2-75d2-9f90-e1f870435451";
  const error = {
    message: "You've hit your usage limit. Try again later.",
    codexErrorInfo: "usageLimitExceeded",
    additionalDetails: null,
  };
  return [
    ...recorded.slice(0, started + 1),
    JSON.stringify({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1_792_473_118 },
          secondary: null,
          credits: null,
          planType: null,
          rateLimitReachedType: "rate_limit_reached",
        },
      },
    }),
    JSON.stringify({
      method: "error",
      params: { error, willRetry: false, threadId: thread, turnId: turn },
    }),
    JSON.stringify({
      method: "turn/completed",
      params: { threadId: thread, turn: { id: turn, status: "failed", error } },
    }),
  ];
}

describe("a turn the plan's usage limit ended", () => {
  it("fails with Codex's words and reports the limit until the window resets", async () => {
    const { spawn } = replay(await limitTurn());
    const result = await new CodexBackend({ spawn, now: () => AT }).runTurn(request);
    expect(result.exitReason).toBe("error");
    expect(result.error).toBe("usage limit reached: You've hit your usage limit. Try again later.");
    expect(result.quota).toMatchObject({
      status: "limited",
      limitedUntil: "2026-10-20T05:11:58.000Z",
      limitedBy: "primary",
      windows: [{ key: "primary", usedPercent: 100 }],
    });
  });
});

/**
 * `account/rateLimits/read` recorded from `codex app-server` 0.162 on pod on 2026-10-13. The answer
 * names the account; the fixture keeps a placeholder there to show it goes no further.
 */
describe("the Codex usage read", () => {
  it("asks a server that opens no thread, and keeps nothing about the account", async () => {
    const { spawn, methods } = replay(await lines("app-server-quota-read-recorded.jsonl"));
    const quota = await new CodexBackend({ spawn, now: () => AT }).readQuota();
    expect(methods).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    expect(quota).toEqual({
      observedAt: AT.toISOString(),
      source: "read",
      status: "allowed",
      limitedUntil: null,
      limitedBy: null,
      plan: "pro",
      windows: [WEEKLY],
      credits: { hasCredits: true, unlimited: false, balance: "100.0000000000" },
      extraUsage: null,
    });
    expect(JSON.stringify(quota)).not.toContain("acct");
  });

  it("reads a refusal of ordinary usage as limited, and no snapshot as no plan limits", () => {
    const snapshot = {
      primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
      planType: "plus",
    };
    expect(
      quotaFromRead({ ordinaryUsageAllowed: false, rateLimits: snapshot, accountId: "a" }, AT)
        .status,
    ).toBe("limited");
    expect(quotaFromRead({ rateLimits: null }, AT)).toMatchObject({ status: "none", windows: [] });
    expect(quotaFromRead(null, AT).status).toBe("none");
  });
});

describe("rolling updates", () => {
  it("keep what a sparse update leaves out, the limit included", () => {
    const limited = CliQuotaSchema.parse({
      observedAt: AT.toISOString(),
      source: "turn",
      status: "limited",
      limitedUntil: "2026-10-20T05:11:58.000Z",
      limitedBy: "primary",
      plan: "pro",
      windows: [{ ...WEEKLY, usedPercent: 100 }],
    });
    const later = new Date("2026-10-13T12:05:00.000Z");
    const merged = mergeSnapshot(
      limited,
      { credits: { hasCredits: true, unlimited: false, balance: "5" } },
      later,
      "turn",
    );
    expect(merged).toMatchObject({
      status: "limited",
      limitedUntil: "2026-10-20T05:11:58.000Z",
      plan: "pro",
      credits: { balance: "5" },
      observedAt: later.toISOString(),
    });
    expect(merged?.windows).toEqual([{ ...WEEKLY, usedPercent: 100 }]);
    expect(mergeSnapshot(limited, "not a snapshot", later, "turn")).toBe(limited);
  });

  it("name a second window by its length and leave a missing reset unknown", () => {
    const quota = quotaFromSnapshot(
      {
        primary: { usedPercent: 81.5, windowDurationMins: 300 },
        secondary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: 1_792_473_118 },
      },
      AT,
      "turn",
    );
    expect(quota?.windows.map((window) => [window.key, window.minutes, window.resetsAt])).toEqual([
      ["primary", 300, null],
      ["secondary", 10_080, "2026-10-20T05:11:58.000Z"],
    ]);
    expect(quota?.status).toBe("allowed");
  });
});

/** The recorded turn with its rate-limit update's text rewritten. */
async function withUpdate(rewrite: (line: string) => string): Promise<string[]> {
  return (await lines("app-server-quota-recorded.jsonl")).map((line) =>
    line.includes('"method":"account/rateLimits/updated"') ? rewrite(line) : line,
  );
}

describe("a rate-limit update outside what a quota may hold", () => {
  it.each([
    ["a reset in milliseconds", (line: string) => line.replace("1792473118", "1792473118000")],
    [
      "a percent past any number",
      (line: string) => line.replace('"usedPercent":2', '"usedPercent":1e400'),
    ],
    [
      "a plan name too long",
      (line: string) => line.replace('"planType":"pro"', `"planType":"${"p".repeat(41)}"`),
    ],
  ])("with %s ends the turn as the recording does", async (_name, rewrite) => {
    const { spawn } = replay(await withUpdate(rewrite));
    const result = await new CodexBackend({ spawn, now: () => AT }).runTurn({
      ...request,
      limits: { timeoutMs: 10_000 },
    });
    expect(result.exitReason).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBeNull();
    expect(result.quota === undefined || CliQuotaSchema.safeParse(result.quota).success).toBe(true);
  });

  it("keeps the window whose reset it cannot read, with no reset", async () => {
    const { spawn } = replay(
      await withUpdate((line) => line.replace("1792473118", "1792473118000")),
    );
    const result = await new CodexBackend({ spawn, now: () => AT }).runTurn(request);
    expect(result.quota?.windows).toEqual([{ ...WEEKLY, resetsAt: null }]);
  });

  it("fails a read whose snapshot it cannot read, rather than calling it no plan limits", () => {
    expect(() => quotaFromRead({ rateLimits: { primary: { usedPercent: Infinity } } }, AT)).toThrow(
      "cannot read",
    );
  });
});

describe("a bucket other than the main one", () => {
  const main = quotaFromSnapshot(
    {
      limitId: "codex",
      primary: { usedPercent: 2, windowDurationMins: 10_080, resetsAt: 1_792_473_118 },
      planType: "pro",
    },
    AT,
    "turn",
  );

  it("names its windows by the bucket, and its spent window warns without limiting", () => {
    const other = quotaFromSnapshot(
      {
        limitId: "codex_other",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_792_473_118 },
        rateLimitReachedType: "rate_limit_reached",
      },
      AT,
      "turn",
    );
    expect(other).toMatchObject({ status: "warning", limitedUntil: null, limitedBy: null });
    expect(other?.windows.map((window) => window.key)).toEqual(["codex_other:primary"]);
  });

  it("leaves the main bucket's windows and the login's status as they were", () => {
    const merged = mergeSnapshot(
      main ?? undefined,
      { limitId: "codex_other", primary: { usedPercent: 100, windowDurationMins: 300 } },
      AT,
      "turn",
    );
    expect(merged?.status).toBe("allowed");
    expect(merged?.windows.map((window) => [window.key, window.usedPercent])).toEqual([
      ["primary", 2],
      ["codex_other:primary", 100],
    ]);
  });
});
