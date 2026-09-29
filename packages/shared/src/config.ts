import { z } from "zod";

export const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const ServerConfigSchema = z.object({
  dataDir: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive().max(65535),
  logLevel: LogLevelSchema,
  /** Turns running at once on this machine, or null for no limit. */
  concurrency: z.number().int().positive().nullable(),
  /** How long one turn may run before it is stopped, or null for no limit. */
  turnTimeoutMs: z.number().int().positive().nullable(),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** A limit from the environment: a number, `unlimited` for none, or the default when unset. */
function limit(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return value.trim().toLowerCase() === "unlimited" ? null : Number(value);
}

/** Environment variable every agent's config home reads its board token from. */
export const AGENT_TOKEN_ENV = "STELLARIS_AGENT_TOKEN";

/** Builds the server configuration from an environment map. Callers pass `process.env`. */
export function loadServerConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  return ServerConfigSchema.parse({
    dataDir: env["STELLARIS_DATA_DIR"] ?? "./data",
    host: env["STELLARIS_HOST"] ?? "127.0.0.1",
    port: Number(env["STELLARIS_PORT"] ?? "4700"),
    logLevel: env["STELLARIS_LOG_LEVEL"] ?? "info",
    concurrency: limit(env["STELLARIS_CONCURRENCY"], 2),
    turnTimeoutMs: limit(env["STELLARIS_TURN_TIMEOUT_MS"], 20 * 60_000),
  });
}
