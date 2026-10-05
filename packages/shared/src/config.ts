import { z } from "zod";
import { CliKindSchema } from "./board.js";

export const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * A GitHub OAuth app the board signs the user in with, and the GitHub logins it lets in, every one
 * of them as the board's one user. The app's callback is `<board address>/auth/github/callback`.
 */
export const GithubSignInSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  /** Logins, lowercased; GitHub logins are case-insensitive. */
  users: z.array(z.string().min(1)).min(1),
});
export type GithubSignIn = z.infer<typeof GithubSignInSchema>;

export const ServerConfigSchema = z.object({
  dataDir: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive().max(65535),
  /**
   * An address every runner's agents reach this server at, for example https://board.example, or
   * null for each runner to use the address it reaches the server at itself.
   */
  publicUrl: z.string().min(1).nullable(),
  logLevel: LogLevelSchema,
  /** Turns running at once across every runner, or null for no limit beyond each runner's own. */
  concurrency: z.number().int().positive().nullable(),
  /** How long one turn may run before it is stopped, or null for no limit. */
  turnTimeoutMs: z.number().int().positive().nullable(),
  /** Rounds of tool calls one Claude turn may take, or null for no limit. */
  toolRounds: z.number().int().positive().nullable(),
  /** How long a resident session stays warm after its last turn. */
  residentIdleMs: z.number().int().positive(),
  /** Signing in to the board with GitHub, or null when only a token lets anyone in. */
  github: GithubSignInSchema.nullable(),
  /**
   * Reverse proxies in front of the server whose X-Forwarded-For entries name the client, for the
   * rate limits on what anyone may ask without a token: 0 when clients connect directly.
   */
  trustedProxies: z.number().int().min(0).max(16),
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
/** GitHub sign-in from the environment: all three variables, or none of them. */
function githubSignIn(env: Readonly<Record<string, string | undefined>>): GithubSignIn | null {
  const clientId = env["STELLARIS_GITHUB_CLIENT_ID"] ?? "";
  const clientSecret = env["STELLARIS_GITHUB_CLIENT_SECRET"] ?? "";
  // Logins, or numeric user ids, which survive a rename.
  const users = list(env["STELLARIS_GITHUB_USERS"]).map((login) => login.toLowerCase());
  if (clientId === "" && clientSecret === "" && users.length === 0) {
    return null;
  }
  if (clientId === "" || clientSecret === "" || users.length === 0) {
    throw new Error(
      "GitHub sign-in needs STELLARIS_GITHUB_CLIENT_ID, STELLARIS_GITHUB_CLIENT_SECRET, and STELLARIS_GITHUB_USERS together",
    );
  }
  return GithubSignInSchema.parse({ clientId, clientSecret, users });
}

export function loadServerConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  return ServerConfigSchema.parse({
    dataDir: env["STELLARIS_DATA_DIR"] ?? "./data",
    host: env["STELLARIS_HOST"] ?? "127.0.0.1",
    port: Number(env["STELLARIS_PORT"] ?? "4700"),
    publicUrl: env["STELLARIS_PUBLIC_URL"]?.replace(/\/+$/, "") ?? null,
    logLevel: env["STELLARIS_LOG_LEVEL"] ?? "info",
    concurrency: limit(env["STELLARIS_CONCURRENCY"], null),
    turnTimeoutMs: limit(env["STELLARIS_TURN_TIMEOUT_MS"], 20 * 60_000),
    toolRounds: limit(env["STELLARIS_TOOL_ROUNDS"], 60),
    residentIdleMs: Number(env["STELLARIS_RESIDENT_IDLE_MS"] ?? String(10 * 60_000)),
    github: githubSignIn(env),
    trustedProxies: Number(env["STELLARIS_TRUSTED_PROXIES"] ?? "0"),
  });
}

export const RunnerConfigSchema = z.object({
  /** The board server, for example http://127.0.0.1:4700. */
  serverUrl: z.string().url(),
  /**
   * The runner's token, from `runner add`, or null for the one it saved when it was enrolled, or
   * to enroll it.
   */
  token: z.string().min(1).nullable(),
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
    token: env["STELLARIS_RUNNER_TOKEN"]?.trim() || null,
    dataDir: env["STELLARIS_RUNNER_DIR"] ?? "./runner-data",
    logLevel: env["STELLARIS_LOG_LEVEL"] ?? "info",
    slots: limit(env["STELLARIS_CONCURRENCY"], 2),
    clis: clis.length === 0 ? ["claude", "codex"] : clis,
    capabilities: list(env["STELLARIS_CAPABILITIES"]),
  });
}
