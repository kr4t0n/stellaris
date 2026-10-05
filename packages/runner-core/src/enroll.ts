import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import {
  NameSchema,
  RUNNER_PROTOCOL,
  RunnerEnrollmentSchema,
  RunnerEnrollStatusSchema,
  type CliKind,
  type Name,
  type RunnerEnrollment,
  type RunnerEnrollRequestInput,
} from "@stellaris/shared";
import { z } from "zod";
import { RunnerHttpError } from "./client.js";
import type { RunnerLog } from "./executor.js";
import type { RunnerLayout } from "./layout.js";

const RunnerCredentialsSchema = z.object({
  serverUrl: z.string().min(1),
  name: NameSchema,
  token: z.string().min(1),
});
export type RunnerCredentials = z.infer<typeof RunnerCredentialsSchema>;

const MAX_RETRY_MS = 30_000;

/** The machine's operating system, as the runner protocol names it. */
export function runnerOs(): "linux" | "windows" | "darwin" {
  const platform = os.platform();
  return platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
}

function trimmed(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The credentials an enrollment saved for `serverUrl`, or null when there are none for it. */
export async function readCredentials(
  layout: RunnerLayout,
  serverUrl: string,
): Promise<RunnerCredentials | null> {
  let text: string;
  try {
    text = await readFile(layout.credentials, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const saved = RunnerCredentialsSchema.parse(JSON.parse(text));
  return trimmed(saved.serverUrl) === trimmed(serverUrl) ? saved : null;
}

/** Saves what an enrollment returned, readable by this user alone. */
export async function saveCredentials(
  layout: RunnerLayout,
  credentials: RunnerCredentials,
): Promise<void> {
  await mkdir(layout.root, { recursive: true });
  const partial = `${layout.credentials}.partial`;
  // The mode applies only to a file writeFile creates, so a leftover is removed first.
  await rm(partial, { force: true });
  await writeFile(partial, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await rename(partial, layout.credentials);
}

export async function forgetCredentials(layout: RunnerLayout): Promise<void> {
  await rm(layout.credentials, { force: true });
}

export class EnrollmentDeniedError extends Error {
  constructor() {
    super("the user denied this runner's enrollment on the board");
  }
}

export interface EnrollRunnerOptions {
  readonly serverUrl: string;
  readonly version: string;
  readonly clis: readonly CliKind[];
  readonly capabilities?: readonly string[] | undefined;
  readonly hostname?: string | undefined;
  /** Told each code the user should approve, and the board page that approves it. */
  readonly onCode: (enrollment: RunnerEnrollment, approveUrl: string) => void;
  readonly fetch?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly log?: RunnerLog | undefined;
}

/**
 * Asks the board server to enroll this runner and polls until the user approves or denies it on
 * the board. An enrollment that expires, or that a server restart forgot, is asked for again with a
 * new code; an unreachable server or a full desk is waited out. Approval returns the runner's name
 * and token, which the server hands over once.
 */
export async function enrollRunner(
  options: EnrollRunnerOptions,
): Promise<{ name: Name; token: string }> {
  const base = trimmed(options.serverUrl);
  const fetchImpl = options.fetch ?? fetch;
  const { signal } = options;
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    const text = await response.text();
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN);
      throw new RunnerHttpError(
        response.status,
        `POST ${path} answered ${response.status}: ${text.slice(0, 500)}`,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    }
    return JSON.parse(text);
  };
  const request: RunnerEnrollRequestInput = {
    protocol: RUNNER_PROTOCOL,
    version: options.version,
    hostname: (options.hostname ?? os.hostname()).slice(0, 253) || "runner",
    os: runnerOs(),
    clis: [...options.clis],
    capabilities: [...(options.capabilities ?? [])],
  };

  let enrollment: RunnerEnrollment | null = null;
  let delay = 1_000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      if (enrollment === null) {
        enrollment = RunnerEnrollmentSchema.parse(await post("/runner/enroll", request));
        options.onCode(
          enrollment,
          `${base}/runners?code=${encodeURIComponent(enrollment.userCode)}`,
        );
      }
      const status = RunnerEnrollStatusSchema.parse(
        await post("/runner/enroll/poll", { deviceCode: enrollment.deviceCode }),
      );
      if (status.status === "approved") {
        return { name: status.name, token: status.token };
      }
      if (status.status === "denied") {
        throw new EnrollmentDeniedError();
      }
      delay = enrollment.intervalMs;
    } catch (error) {
      if (error instanceof EnrollmentDeniedError || signal?.aborted === true) {
        throw error;
      }
      if (error instanceof RunnerHttpError) {
        if (error.status === 404 && enrollment !== null) {
          enrollment = null;
          continue;
        }
        // A server that does not enroll answers the request as any unauthenticated runner call.
        if (error.status === 401 || error.status === 404) {
          throw new Error(
            "the server does not enroll runners; register this runner on the board and set STELLARIS_RUNNER_TOKEN",
            { cause: error },
          );
        }
        if (error.status === 429 && error.retryAfterMs !== undefined) {
          options.log?.warn(
            { retryAfterMs: error.retryAfterMs },
            "the server limits enrollment requests from this address; waiting",
          );
          await wait(error.retryAfterMs, undefined, signal === undefined ? {} : { signal });
          continue;
        }
      }
      options.log?.warn({ error: String(error) }, "could not reach the server to enroll");
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
    await wait(delay, undefined, signal === undefined ? {} : { signal });
  }
}
