import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import {
  AGENT_TOKEN_ENV,
  CliQuotaSchema,
  RUNNER_TOKEN_ENV,
  type CliQuota,
} from "@stellaris/shared";
import { isDict, str } from "./rpc.js";

/**
 * agy's plan quota, from print mode's `/usage` and `/credits`, which answer from the account's
 * usage without starting a turn or a conversation. ACP has no such read: `session/new` names the
 * plan's tier, with no usage. Print mode takes no `--disable-telemetry`, and 1.5.15 reached for
 * `play.googleapis.com` in every read, so each runs behind `startTelemetryGuard`.
 */

/** The host agy sends its telemetry to, which no read of the adapter's may reach. */
const TELEMETRY_HOST = /(^|\.)play\.googleapis\.com$/i;

/**
 * A CONNECT proxy on 127.0.0.1 that refuses the telemetry host and tunnels every other, for a
 * process given it as its HTTPS proxy. It dials each host itself, so a runner that reaches Google
 * only through a proxy of its own gets a failed read, and the quota stays unknown.
 */
export async function startTelemetryGuard(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    client.once("data", (chunk: Buffer) => {
      const line = chunk.toString("latin1").split("\r\n")[0] ?? "";
      const target = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]$/.exec(line);
      if (target === null) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
        return;
      }
      const [, host = "", port = ""] = target;
      // A name with its root's dot is the same host.
      if (TELEMETRY_HOST.test(host.replace(/\.$/, ""))) {
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = net.connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Runs `agy` to its end and hands back what it wrote; injectable for tests. */
export type RunPrint = (
  args: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => Promise<{ stdout: string; exitCode: number | null }>;

export function defaultRunPrint(agyPath: string): RunPrint {
  return async (args, options) => {
    const result = await execa(agyPath, [...args], {
      cwd: options.cwd,
      env: options.env,
      extendEnv: false,
      stdin: "ignore",
      reject: false,
      timeout: 60_000,
    });
    return { stdout: result.stdout, exitCode: result.exitCode ?? null };
  };
}

export interface PrintQuotaOptions {
  readonly agyPath?: string | undefined;
  /** Where agy keeps its sign-in: print mode reads it as `$HOME/.gemini`, so its name is `.gemini`. */
  readonly geminiDir?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly runPrint?: RunPrint | undefined;
  readonly now?: (() => Date) | undefined;
}

/** The proxy variables a process could reach the telemetry host around the guard by, or with. */
const PROXY_KEYS = new Set([
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
]);

function printEnv(options: PrintQuotaOptions, guard: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter(
      ([key]) =>
        key !== RUNNER_TOKEN_ENV &&
        key !== AGENT_TOKEN_ENV &&
        !PROXY_KEYS.has(key) &&
        key !== "CLAUDECODE" &&
        !key.startsWith("CLAUDE_CODE_"),
    ),
  );
  if (options.geminiDir !== undefined) {
    if (path.basename(options.geminiDir) !== ".gemini") {
      throw new Error(`agy reads its quota from $HOME/.gemini, not ${options.geminiDir}`);
    }
    env["HOME"] = path.dirname(options.geminiDir);
  }
  return {
    ...env,
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    HTTPS_PROXY: guard,
    HTTP_PROXY: guard,
    https_proxy: guard,
    http_proxy: guard,
  };
}

/** agy's words when the login has no plan quota to report, as an API key's. */
const NO_PLAN = /not available with a Gemini API key/;

/** A window's length in minutes, from the bucket's `window`. */
const WINDOW_MINUTES: Readonly<Record<string, number>> = {
  hourly: 60,
  daily: 1_440,
  weekly: 10_080,
  monthly: 43_200,
};

/** An ISO time as the schema keeps it, or null for one that isn't. */
function isoOf(raw: unknown): string | null {
  const text = str(raw);
  if (text === undefined) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * A bucket's reset, or null for none known. agy 1.5.15 prints a bucket no window runs in, as those
 * of a group nobody has used lately, with its reset at the Unix epoch, which is no reset at all.
 */
function resetOf(raw: unknown): string | null {
  const reset = isoOf(raw);
  return reset === null || Date.parse(reset) <= 0 ? null : reset;
}

/**
 * How much of a bucket is used, in percent. agy 1.5.15 prints a bucket with a `remaining_fraction`
 * or a `remaining_amount`, one of the two upstream, each left out when unset. A fraction gives the
 * percent. An amount has no total, so it says only whether the bucket is spent: none left is 100,
 * and any left leaves the percent unknown, as does a bucket with neither.
 */
function usedPercentOf(bucket: Record<string, unknown>): number | null {
  const fraction = bucket["remaining_fraction"];
  if (typeof fraction === "number" && Number.isFinite(fraction)) {
    return Math.round((1 - Math.min(1, Math.max(0, fraction))) * 10_000) / 100;
  }
  const amount = bucket["remaining_amount"];
  if (typeof amount === "number" && Number.isFinite(amount)) {
    return amount <= 0 ? 100 : null;
  }
  return null;
}

/** Two resets in time order by their code units, an unknown one after every known one. */
function byReset(a: string | null, b: string | null): number {
  if (a === null || b === null) {
    return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A print-mode result's `command.data`, or the read's failure in agy's words. */
function commandData(raw: unknown, command: string): Record<string, unknown> | string {
  const result = isDict(raw) ? raw : {};
  if (result["status"] !== "SUCCESS") {
    return str(result["error"]) ?? `agy -p /${command} failed`;
  }
  const ran = isDict(result["command"]) ? result["command"] : {};
  return isDict(ran["data"]) ? ran["data"] : `agy -p /${command} answered no data`;
}

/**
 * The quota `/usage` and `/credits` answer, from print mode's JSON results. Each group of models
 * shares its buckets, so a bucket is a window named by its id and labelled with its group, used as
 * `usedPercentOf` reads it; a `disabled` bucket meters nothing and is left out. One bucket spent
 * stops only its group's models, a warning; every bucket spent stops the login until the first of
 * them resets, since the groups are disjoint and that group's models can run again then. An API
 * key's login, which has no plan quota, reads as `none`; any other failure fails the read in agy's
 * words.
 */
export function quotaFromUsage(usage: unknown, credits: unknown, at: Date): CliQuota {
  const observedAt = at.toISOString();
  const data = commandData(usage, "usage");
  if (typeof data === "string") {
    if (NO_PLAN.test(data)) {
      return CliQuotaSchema.parse({ observedAt, source: "read", status: "none" });
    }
    throw new Error(data);
  }
  const windows = (Array.isArray(data["groups"]) ? data["groups"] : []).flatMap((group) => {
    const label = isDict(group) ? str(group["name"]) : undefined;
    const buckets = isDict(group) && Array.isArray(group["buckets"]) ? group["buckets"] : [];
    return buckets.flatMap((bucket) => {
      const key = isDict(bucket) ? str(bucket["id"]) : undefined;
      if (!isDict(bucket) || key === undefined || bucket["disabled"] === true) {
        return [];
      }
      return [
        {
          key,
          ...(label === undefined ? {} : { label: label.slice(0, 80) }),
          minutes: WINDOW_MINUTES[str(bucket["window"]) ?? ""] ?? null,
          usedPercent: usedPercentOf(bucket),
          resetsAt: resetOf(bucket["reset_time"]),
          observedAt,
        },
      ];
    });
  });
  const spent = windows.filter((window) => (window.usedPercent ?? 0) >= 100);
  const limited = windows.length > 0 && spent.length === windows.length;
  // The first reset frees its group's models. Resets are ISO times in one form, so their UTF-16 code
  // units order them, never `localeCompare`, whose collation puts a symbol before a digit; a bucket
  // with no reset known comes last.
  const binding = spent.toSorted((a, b) => byReset(a.resetsAt, b.resetsAt))[0];
  const balance = commandData(credits, "credits");
  const remaining =
    typeof balance === "string" || typeof balance["remaining_credits"] !== "number"
      ? null
      : balance["remaining_credits"];
  const parsed = CliQuotaSchema.safeParse({
    observedAt,
    source: "read",
    status: limited ? "limited" : spent.length > 0 ? "warning" : "allowed",
    limitedUntil: limited ? (binding?.resetsAt ?? null) : null,
    limitedBy: limited ? (binding?.key ?? null) : null,
    windows,
    credits:
      remaining === null
        ? null
        : { hasCredits: remaining > 0, unlimited: false, balance: String(remaining) },
  });
  if (!parsed.success) {
    throw new Error("agy answered /usage in a shape this runner cannot read");
  }
  return parsed.data;
}

/**
 * Reads the quota with `agy -p /usage`, then `agy -p /credits` when it answered, behind the
 * telemetry guard. Neither makes a model call or leaves a conversation. A `/credits` that fails
 * costs only the balance.
 */
export async function readPrintQuota(options: PrintQuotaOptions): Promise<CliQuota> {
  const guard = await startTelemetryGuard();
  try {
    const env = printEnv(options, guard.url);
    const run = options.runPrint ?? defaultRunPrint(options.agyPath ?? "agy");
    const ask = async (command: string): Promise<unknown> => {
      const { stdout } = await run(["-p", `/${command}`, "--output-format", "json"], {
        cwd: os.tmpdir(),
        env,
      });
      try {
        return JSON.parse(stdout);
      } catch {
        return { status: "ERROR", error: `agy -p /${command} answered no JSON` };
      }
    };
    const usage = await ask("usage");
    // A login with no usage to report has no balance to ask for either.
    const credits = typeof commandData(usage, "usage") === "string" ? null : await ask("credits");
    return quotaFromUsage(usage, credits, (options.now ?? (() => new Date()))());
  } finally {
    await guard.close();
  }
}
