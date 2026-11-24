import path from "node:path";
import { AntigravityBackend, type AntigravityOptions } from "@stellaris/adapter-antigravity";
import { ClaudeAgentBackend } from "@stellaris/adapter-claude";
import { CodexBackend, CodexSandboxSchema } from "@stellaris/adapter-codex";
import type { AgentBackend } from "@stellaris/runner-core";
import type { CliKind } from "@stellaris/shared";

/** What every CLI's backend is built from: the runner's environment and where a CLI's stderr goes. */
export interface BackendSettings {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stderr: (cli: CliKind, line: string) => void;
}

/**
 * agy's options from the runner's environment. `STELLARIS_GEMINI_DIR` names the folder agy keeps
 * its sign-in, settings, and conversations in, in place of `~/.gemini`; it must be called `.gemini`,
 * since print mode, which reads the quota, takes no `--gemini-dir` and reads `$HOME/.gemini`.
 */
export function antigravityOptions(
  env: Readonly<Record<string, string | undefined>>,
): Pick<AntigravityOptions, "geminiDir"> {
  const dir = env["STELLARIS_GEMINI_DIR"]?.trim() ?? "";
  if (dir === "") {
    return {};
  }
  const geminiDir = path.resolve(dir);
  if (path.basename(geminiDir) !== ".gemini") {
    throw new Error(`STELLARIS_GEMINI_DIR must name a folder called .gemini, not ${geminiDir}`);
  }
  return { geminiDir };
}

/**
 * One builder for every CLI kind, so a kind added to `CliKindSchema` fails the build until a runner
 * can run it, and a runner never offers a CLI it has no backend for.
 */
const BUILDERS: { readonly [K in CliKind]: (settings: BackendSettings) => AgentBackend } = {
  claude: ({ env, stderr }) =>
    new ClaudeAgentBackend({
      stderr: (line) => stderr("claude", line),
      recordDir: env["STELLARIS_RECORD_DIR"],
    }),
  codex: ({ env, stderr }) =>
    new CodexBackend({
      stderr: (line) => stderr("codex", line),
      recordDir: env["STELLARIS_RECORD_DIR"],
      // Full access by default: no sandbox, no approvals. A runner that wants Codex's own
      // sandbox back sets STELLARIS_CODEX_SANDBOX; on Linux that needs user namespaces.
      sandbox: CodexSandboxSchema.parse(env["STELLARIS_CODEX_SANDBOX"] ?? "danger-full-access"),
    }),
  // agy on the PATH, as the runner's image has it.
  antigravity: ({ env, stderr }) =>
    new AntigravityBackend({
      ...antigravityOptions(env),
      stderr: (line) => stderr("antigravity", line),
      recordDir: env["STELLARIS_RECORD_DIR"],
    }),
};

/** A backend for each CLI the runner is configured with, and for no other. */
export function buildBackends(
  clis: readonly CliKind[],
  settings: BackendSettings,
): Partial<Record<CliKind, AgentBackend>> {
  return Object.fromEntries(clis.map((cli) => [cli, BUILDERS[cli](settings)]));
}
