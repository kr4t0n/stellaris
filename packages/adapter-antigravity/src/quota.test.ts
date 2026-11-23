import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AntigravityBackend } from "./backend.js";
import { quotaFromUsage, startTelemetryGuard, type RunPrint } from "./quota.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixtures, name), "utf8"));
}

const AT = new Date("2026-11-23T15:00:00.000Z");

/** A `/usage` answer of agy's print mode, with one bucket per group at what each leaves. */
function usageOf(remaining: Record<string, number>): unknown {
  return {
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: Object.entries(remaining).map(([id, fraction], index) => ({
          name: `Group ${index}`,
          buckets: [
            {
              id,
              window: "weekly",
              remaining_fraction: fraction,
              reset_time: `2026-11-${29 + index}T00:00:00Z`,
            },
          ],
        })),
      },
    },
  };
}

/**
 * Print mode's `/usage` and `/credits`, recorded from agy 1.5.15 on 2026-11-23 with a signed-in
 * consumer account: a group of Gemini models and a group of third-party models, each with a weekly
 * bucket, and no credits.
 */
describe("agy's quota from print mode", () => {
  it("reads each group's bucket as a window, and the credit balance", async () => {
    const quota = quotaFromUsage(
      await fixture("print-usage-recorded.json"),
      await fixture("print-credits-recorded.json"),
      AT,
    );
    expect(quota).toEqual({
      observedAt: "2026-11-23T15:00:00.000Z",
      source: "read",
      status: "allowed",
      limitedUntil: null,
      limitedBy: null,
      plan: null,
      windows: [
        {
          key: "gemini-weekly",
          label: "Gemini Models",
          minutes: 10_080,
          usedPercent: 0.8,
          resetsAt: "2026-11-30T03:55:58.000Z",
          observedAt: "2026-11-23T15:00:00.000Z",
        },
        {
          key: "3p-weekly",
          label: "Claude and GPT models",
          minutes: 10_080,
          usedPercent: 0,
          resetsAt: "2026-11-30T14:54:52.000Z",
          observedAt: "2026-11-23T15:00:00.000Z",
        },
      ],
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      extraUsage: null,
    });
  });

  it("warns when one group is spent, and is limited until the first reset when all are", () => {
    expect(quotaFromUsage(usageOf({ a: 0, b: 0.5 }), null, AT)).toMatchObject({
      status: "warning",
      limitedUntil: null,
    });
    // The groups meter disjoint models, so the first reset lets its group's models run again.
    expect(quotaFromUsage(usageOf({ a: 0, b: 0 }), null, AT)).toMatchObject({
      status: "limited",
      limitedBy: "a",
      limitedUntil: "2026-11-29T00:00:00.000Z",
    });
  });

  /**
   * The bucket shapes agy 1.5.15 can print beside the recorded one: its print-mode bucket holds an
   * optional `remaining_fraction` or `remaining_amount` and a `disabled` flag, each left out when
   * unset. Built from the recorded answer with those fields, since no account has printed them yet.
   */
  it("reads a bucket by its amount, leaves a disabled one out, and keeps an unmeasured one", async () => {
    const quota = quotaFromUsage(await fixture("print-usage-bucket-shapes.json"), null, AT);
    expect(quota.windows.map((window) => [window.key, window.usedPercent, window.minutes])).toEqual(
      [
        ["amount-spent", 100, 10_080],
        ["amount-left", null, 1_440],
        ["unmeasured", null, 10_080],
      ],
    );
    // One group spent by its amount, the others not, stops only that group's models.
    expect(quota).toMatchObject({ status: "warning", limitedUntil: null, limitedBy: null });
  });

  it("is limited when every bucket is spent by its amount, a disabled one aside", () => {
    const usage = {
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "A",
              buckets: [{ id: "a", remaining_amount: 0, reset_time: "2026-11-25T00:00:00Z" }],
            },
            {
              name: "B",
              buckets: [{ id: "b", remaining_fraction: 0, reset_time: "2026-11-26T00:00:00Z" }],
            },
            { name: "C", buckets: [{ id: "c", disabled: true, remaining_fraction: 1 }] },
          ],
        },
      },
    };
    expect(quotaFromUsage(usage, null, AT)).toMatchObject({
      status: "limited",
      limitedBy: "a",
      limitedUntil: "2026-11-25T00:00:00.000Z",
    });
  });

  it("reads an API key's login as one with no plan quota", async () => {
    expect(quotaFromUsage(await fixture("print-usage-api-key-recorded.json"), null, AT)).toEqual({
      observedAt: "2026-11-23T15:00:00.000Z",
      source: "read",
      status: "none",
      limitedUntil: null,
      limitedBy: null,
      plan: null,
      windows: [],
      credits: null,
      extraUsage: null,
    });
  });

  it("fails a read agy refused, in agy's words", async () => {
    const refused = await fixture("print-usage-refused-recorded.json");
    expect(() => quotaFromUsage(refused, null, AT)).toThrow(
      "Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.",
    );
    expect(() => quotaFromUsage({ status: "SUCCESS" }, null, AT)).toThrow(
      "agy -p /usage answered no data",
    );
  });

  it("keeps the windows when /credits fails, with no balance", () => {
    const quota = quotaFromUsage(usageOf({ a: 0.25 }), { status: "ERROR", error: "x" }, AT);
    expect(quota.windows).toEqual([expect.objectContaining({ key: "a", usedPercent: 75 })]);
    expect(quota.credits).toBeNull();
  });
});

/** Sends a CONNECT through the guard and reads its answer's status line. */
async function connect(guard: string, target: string, hello?: string): Promise<string> {
  const { port } = new URL(guard);
  const socket = net.connect(Number(port), "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  let seen = "";
  return new Promise((resolve) => {
    socket.on("data", (chunk: Buffer) => {
      seen += chunk.toString("latin1");
      if (
        hello !== undefined &&
        seen.includes("200 Connection Established") &&
        !seen.includes(hello)
      ) {
        socket.write(hello);
        return;
      }
      if (hello === undefined || seen.includes(`echo:${hello}`)) {
        socket.destroy();
        resolve(seen);
      }
    });
    socket.on("close", () => resolve(seen));
  });
}

describe("the telemetry guard", () => {
  it("refuses the telemetry host and tunnels every other", async () => {
    const echo = net.createServer((socket) =>
      socket.on("data", (data) => socket.write(`echo:${data.toString()}`)),
    );
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
    const address = echo.address();
    const echoPort = typeof address === "object" && address !== null ? address.port : 0;
    const guard = await startTelemetryGuard();
    try {
      expect(await connect(guard.url, "play.googleapis.com:443")).toMatch(/^HTTP\/1\.1 403 /);
      expect(await connect(guard.url, "PLAY.googleapis.com:443")).toMatch(/^HTTP\/1\.1 403 /);
      expect(await connect(guard.url, "play.googleapis.com.:443")).toMatch(/^HTTP\/1\.1 403 /);
      const tunnelled = await connect(guard.url, `127.0.0.1:${echoPort}`, "ping");
      expect(tunnelled).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
      expect(tunnelled).toContain("echo:ping");
    } finally {
      await guard.close();
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  });
});

describe("AntigravityBackend.readQuota", () => {
  it("asks print mode behind the guard, with the sign-in's home and no way around it", async () => {
    const calls: { args: readonly string[]; env: Record<string, string | undefined> }[] = [];
    const usage = await fixture("print-usage-recorded.json");
    const credits = await fixture("print-credits-recorded.json");
    const runPrint: RunPrint = (args, options) => {
      calls.push({ args, env: options.env });
      return Promise.resolve({
        stdout: JSON.stringify(args[1] === "/usage" ? usage : credits),
        exitCode: 0,
      });
    };
    const quota = await new AntigravityBackend({
      runPrint,
      geminiDir: "/srv/agy/.gemini",
      env: { NO_PROXY: "googleapis.com", STELLARIS_RUNNER_TOKEN: "runner-secret" },
      now: () => AT,
    }).readQuota();
    expect(quota.windows.map((window) => window.key)).toEqual(["gemini-weekly", "3p-weekly"]);
    expect(calls.map((call) => call.args)).toEqual([
      ["-p", "/usage", "--output-format", "json"],
      ["-p", "/credits", "--output-format", "json"],
    ]);
    const env = calls[0]?.env ?? {};
    expect(env["HOME"]).toBe("/srv/agy");
    expect(env["AGY_CLI_DISABLE_AUTO_UPDATE"]).toBe("true");
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
      expect(env[key]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    }
    expect(env).not.toHaveProperty("NO_PROXY");
    expect(env).not.toHaveProperty("STELLARIS_RUNNER_TOKEN");
  });

  it("asks no balance of a login with no usage to report, and refuses a gemini dir by another name", async () => {
    const asked: string[] = [];
    const keyUsage = await fixture("print-usage-api-key-recorded.json");
    const runPrint: RunPrint = (args) => {
      asked.push(args[1] ?? "");
      return Promise.resolve({ stdout: JSON.stringify(keyUsage), exitCode: 2 });
    };
    expect(await new AntigravityBackend({ runPrint }).readQuota()).toMatchObject({
      status: "none",
    });
    expect(asked).toEqual(["/usage"]);
    await expect(
      new AntigravityBackend({ runPrint, geminiDir: "/srv/agy/state" }).readQuota(),
    ).rejects.toThrow("agy reads its quota from $HOME/.gemini, not /srv/agy/state");
  });
});
