import { z } from "zod";
import { CliKindSchema } from "./board.js";

export const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const ServerConfigSchema = z.object({
  dataDir: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive().max(65535),
  /** Where runners and their agents reach this server, for example https://board.example; the MCP endpoint is under it. */
  publicUrl: z.string().min(1),
  logLevel: LogLevelSchema,
  /** Turns running at once across every runner, or null for no limit beyond each runner's own. */
  concurrency: z.number().int().positive().nullable(),
  /** How long one turn may run before it is stopped, or null for no limit. */
  turnTimeoutMs: z.number().int().positive().nullable(),
  /** Rounds of tool calls one Claude turn may take, or null for no limit. */
  toolRounds: z.number().int().positive().nullable(),
  /** How long a resident session stays warm after its last turn. */
  residentIdleMs: z.number().int().positive(),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** A limit from the environment: a number, `unlimited` for none, or the default when unset. */
function limit(value: string | undefined, fallback: number | null): number | null {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return value.trim().toLowerCase() === "unlimited" ? null : Number(value);
}

/** A comma-separated list from the environment, empty entries dropped. */
function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Environment variable every agent's config home reads its board token from. */
export const AGENT_TOKEN_ENV = "STELLARIS_AGENT_TOKEN";

/** Builds the server configuration from an environment map. Callers pass `process.env`. */
export function loadServerConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  const host = env["STELLARIS_HOST"] ?? "127.0.0.1";
  const port = Number(env["STELLARIS_PORT"] ?? "4700");
  return ServerConfigSchema.parse({
    dataDir: env["STELLARIS_DATA_DIR"] ?? "./data",
    host,
    port,
    publicUrl: (env["STELLARIS_PUBLIC_URL"] ?? `http://${host}:${port}`).replace(/\/+$/, ""),
    logLevel: env["STELLARIS_LOG_LEVEL"] ?? "info",
    concurrency: limit(env["STELLARIS_CONCURRENCY"], null),
    turnTimeoutMs: limit(env["STELLARIS_TURN_TIMEOUT_MS"], 20 * 60_000),
    toolRounds: limit(env["STELLARIS_TOOL_ROUNDS"], 60),
    residentIdleMs: Number(env["STELLARIS_RESIDENT_IDLE_MS"] ?? String(10 * 60_000)),
  });
}

export const RunnerConfigSchema = z.object({
  /** The board server, for example http://127.0.0.1:4700. */
  serverUrl: z.string().url(),
  /** The runner's token, minted by `runner add`. */
  token: z.string().min(1),
  /** The runner's own data directory: the board mirror, agent homes, repositories, worktrees. */
  dataDir: z.string().min(1),
  logLevel: LogLevelSchema,
  /** Turns this machine runs at once, or null for no limit. */
  slots: z.number().int().positive().nullable(),
  clis: z.array(CliKindSchema).min(1),
  capabilities: z.array(z.string()),
});
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

/** Builds a runner's configuration from an environment map. Callers pass `process.env`. */
export function loadRunnerConfig(env: Readonly<Record<string, string | undefined>>): RunnerConfig {
  const clis = list(env["STELLARIS_CLIS"]);
  return RunnerConfigSchema.parse({
    serverUrl: (env["STELLARIS_SERVER_URL"] ?? "http://127.0.0.1:4700").replace(/\/+$/, ""),
    token: env["STELLARIS_RUNNER_TOKEN"] ?? "",
    dataDir: env["STELLARIS_RUNNER_DIR"] ?? "./runner-data",
    logLevel: env["STELLARIS_LOG_LEVEL"] ?? "info",
    slots: limit(env["STELLARIS_CONCURRENCY"], 2),
    clis: clis.length === 0 ? ["claude", "codex"] : clis,
    capabilities: list(env["STELLARIS_CAPABILITIES"]),
  });
}
