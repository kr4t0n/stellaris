import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CLI_ENV,
  parseTurnStatus,
  ResumeError,
  ZERO_USAGE,
  type AgentSpec,
  type ResidentSession,
  type ResidentStart,
  type SessionId,
  type TurnControl,
  type TurnResult,
} from "@stellaris/runner-core";
import {
  addUsage,
  AGENT_TOKEN_ENV,
  ANTIGRAVITY_POOLS,
  capOutput,
  CliQuotaSchema,
  ModelOptionSchema,
  RUNNER_TOKEN_ENV,
  type AgentEvent,
  type CliQuota,
  type ModelOption,
  type ResumeFailure,
  type TurnExitReason,
  type TurnStatus,
  type Usage,
} from "@stellaris/shared";
import {
  AcpClient,
  AcpError,
  defaultSpawnAgy,
  isDict,
  num,
  str,
  type AcpProcess,
  type Dict,
  type SpawnAgy,
} from "./rpc.js";
import { BoardRelay } from "./relay.js";

/**
 * An Antigravity session over `agy acp`: the Agent Client Protocol, version 1, as JSON-RPC 2.0
 * over stdio. The process starts once per session, for one cold turn or for a resident session's
 * lifetime; `session/new` or `session/resume` opens the session, with the board's MCP server and
 * the instructions, and every prompt is a `session/prompt` whose steps stream back as
 * `session/update` notifications until its reply.
 */

export interface AcpSessionOptions {
  readonly spawn?: SpawnAgy | undefined;
  readonly agyPath?: string | undefined;
  /** Where agy keeps its settings, sign-in, and conversations, in place of `~/.gemini`. */
  readonly geminiDir?: string | undefined;
  readonly model?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stderr?: ((line: string) => void) | undefined;
  /** Directory to append agy's raw output to, one file per turn, for fixtures. */
  readonly recordDir?: string | undefined;
  readonly clientVersion?: string | undefined;
  /** The clock a refusal of the plan's quota is stamped by; tests inject one. */
  readonly now?: (() => Date) | undefined;
  /** How long each try of the board's handshake, which the relay makes, may take; tests shorten it. */
  readonly handshakeLimitMs?: number | undefined;
}

/** Sessions agy has not named yet start with this prefix; `session/new` gives the real id. */
export const PENDING_SESSION_PREFIX = "pending-";

/** The ACP version this client speaks. */
const PROTOCOL_VERSION = 1;

/** The name the board's MCP server goes by, which agy puts in its tools' names: `mcp_board_<tool>`. */
const BOARD_SERVER = "board";
const BOARD_TOOL_PREFIX = `mcp_${BOARD_SERVER}_`;

/**
 * A field agy adds, required, to every tool's schema, MCP tools' included, and drops before it
 * calls the tool: the model's one-line summary of the call. A step shows what the tool was given.
 */
const TOOL_SUMMARY = "toolSummary";

/**
 * Every process runs one session in a worker of its own, so each session's MCP servers, with the
 * session's relay and its secret, stay its own; skips every permission prompt, since nothing may
 * stop to ask a human; and sends no telemetry, which agy otherwise sends to Google.
 */
const ACP_FLAGS = [
  "--process-per-session",
  "--dangerously-skip-permissions",
  "--disable-telemetry",
];

/** Why a start ended when the turn was stopped before agy opened the session. */
const STOPPED_STARTING = "the turn was stopped before agy opened the session";

/** How long a turn asked to stop may take to say so before it is ended without its report. */
const STOP_GRACE_MS = 15_000;
const STDERR_TAIL = 20;

/** The runner's environment for agy, without the runner's own token or a Claude Code session's markers. */
function inheritedEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key !== RUNNER_TOKEN_ENV && key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_"),
    ),
  );
}

function agyEnv(options: AcpSessionOptions, token?: string): Record<string, string | undefined> {
  return {
    ...inheritedEnv(),
    ...options.env,
    ...CLI_ENV,
    // agy updates its own binary in the background unless told not to; the runner's image pins it.
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    ...(token === undefined ? {} : { [AGENT_TOKEN_ENV]: token }),
  };
}

function acpArgs(options: AcpSessionOptions): string[] {
  return [
    "acp",
    ...ACP_FLAGS,
    ...(options.geminiDir === undefined ? [] : ["--gemini-dir", options.geminiDir]),
  ];
}

async function initialize(client: AcpClient, options: AcpSessionOptions): Promise<Dict> {
  const answer = await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: {
      name: "stellaris",
      title: "Stellaris runner",
      version: options.clientVersion ?? "0.0.0",
    },
  });
  const result = isDict(answer) ? answer : {};
  if (result["protocolVersion"] !== PROTOCOL_VERSION) {
    throw new Error(`agy acp speaks ACP version ${String(result["protocolVersion"])}, not 1`);
  }
  return result;
}

/** Whether agy offers the system prompt append the instructions travel in. */
function appendsSystemPrompt(initialized: Dict): boolean {
  const capabilities = isDict(initialized["agentCapabilities"])
    ? initialized["agentCapabilities"]
    : {};
  const meta = isDict(capabilities["_meta"]) ? capabilities["_meta"] : {};
  const antigravity = isDict(meta["antigravity"]) ? meta["antigravity"] : {};
  const systemPrompt = isDict(antigravity["systemPrompt"]) ? antigravity["systemPrompt"] : {};
  return systemPrompt["append"] === true;
}

/** A select option's current value and its choices, by the option's id, from `configOptions`. */
export interface ConfigSelect {
  readonly current: string | undefined;
  readonly choices: readonly { readonly value: string; readonly name: string }[];
}

/** The `select` options a session reports, flattening grouped choices. */
export function configSelectsOf(raw: unknown): Map<string, ConfigSelect> {
  const selects = new Map<string, ConfigSelect>();
  for (const option of Array.isArray(raw) ? raw : []) {
    if (!isDict(option) || option["type"] !== "select") continue;
    const id = str(option["id"]);
    if (id === undefined) continue;
    const listed = Array.isArray(option["options"]) ? option["options"] : [];
    const flat = listed.flatMap((each) =>
      isDict(each) && Array.isArray(each["options"]) ? each["options"] : [each],
    );
    const choices = flat.flatMap((each) => {
      const value = isDict(each) ? str(each["value"]) : undefined;
      return value === undefined
        ? []
        : [{ value, name: str(isDict(each) ? each["name"] : "") ?? value }];
    });
    selects.set(id, { current: str(option["currentValue"]), choices });
  }
  return selects;
}

/** The thinking levels in the order agy offers them, low to high; any other comes after. */
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

function levelRank(level: string): number {
  const at = LEVELS.indexOf(level);
  return at === -1 ? LEVELS.length : at;
}

/**
 * The models a session offers. agy's `model` option lists model families, such as
 * `gemini-4-neon`, and its `thought_level` the current family's levels; `models.availableModels`
 * lists every family at every level as one id, `gemini-4-neon-high`. So a family is the board's
 * model, and the levels its ids carry are its efforts, the current family's current level its
 * default. A session with no `model` option offers each id alone.
 */
export function modelsOf(response: unknown): ModelOption[] {
  const answer = isDict(response) ? response : {};
  const models = isDict(answer["models"]) ? answer["models"] : {};
  const ids = (Array.isArray(models["availableModels"]) ? models["availableModels"] : []).flatMap(
    (raw) => {
      const id = isDict(raw) ? str(raw["modelId"]) : undefined;
      return id === undefined ? [] : [{ id, name: str(isDict(raw) ? raw["name"] : "") ?? id }];
    },
  );
  const selects = configSelectsOf(answer["configOptions"]);
  const families = selects.get("model");
  const level = selects.get("thought_level")?.current;
  const options =
    families === undefined
      ? ids.map(({ id, name }) => ({ id, name, efforts: [] as string[] }))
      : families.choices.map(({ value, name }) => ({
          id: value,
          name,
          efforts: ids
            .map(({ id }) => (id.startsWith(`${value}-`) ? id.slice(value.length + 1) : ""))
            .filter((each) => /^[a-z]+$/.test(each))
            .toSorted((x, y) => levelRank(x) - levelRank(y)),
        }));
  const current = families?.current ?? str(models["currentModelId"]);
  return options.flatMap(({ id, name, efforts }) => {
    const isDefault = id === current;
    const parsed = ModelOptionSchema.safeParse({
      id,
      name,
      description: "",
      isDefault,
      efforts: efforts.map((effort) => ({ id: effort, description: "" })),
      ...(isDefault && level !== undefined && efforts.includes(level)
        ? { defaultEffort: level }
        : {}),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The models agy offers, from a session opened only to ask in a folder of the temp directory and
 * closed at once: it takes no prompt, so it makes no model call, and `session/list` never lists it.
 */
export async function listAcpModels(options: AcpSessionOptions): Promise<ModelOption[]> {
  const spawn = options.spawn ?? defaultSpawnAgy(options.agyPath ?? "agy");
  const child = spawn(acpArgs(options), { cwd: os.tmpdir(), env: agyEnv(options) });
  const client = new AcpClient(child, {
    notification: () => undefined,
    stderr: (line) => options.stderr?.(line),
    line: () => undefined,
    exit: () => undefined,
  });
  try {
    await initialize(client, options);
    const opened = await client.request("session/new", { cwd: os.tmpdir(), mcpServers: [] });
    const session = isDict(opened) ? str(opened["sessionId"]) : undefined;
    if (session !== undefined) {
      await client.request("session/close", { sessionId: session }).catch(() => undefined);
    }
    return modelsOf(opened);
  } finally {
    client.close();
  }
}

/** A prompt reply's `usage`, ACP's unstable `Usage`: input outside the cache, as `Usage` counts it. */
export function usageOf(raw: unknown): Usage {
  const usage = isDict(raw) ? raw : {};
  return {
    inputTokens: num(usage["inputTokens"]),
    // agy counts the model's thinking within its output, as `thoughtTokens` apart says.
    outputTokens: num(usage["outputTokens"]),
    cacheReadTokens: num(usage["cachedReadTokens"]),
    cacheWriteTokens: num(usage["cachedWriteTokens"]),
  };
}

/**
 * How agy reports a turn the model service failed, once its own retries ran out: not as an error
 * reply but as a message chunk of its own, a warning on one line between newlines, after which
 * the prompt ends as `end_turn` with no usage. 1.5.15 says `agent executor error: …` with the
 * service's status for a refusal or a stream it could not read, and `There was a network issue
 * connecting to the server, please try again.` for a request that got no answer.
 */
const WARNING = /^\n\u26a0 ([^\n]+)\n$/;

/** The failure a message chunk reports, in agy's words, or undefined for the model's own text. */
export function warningOf(text: string): string | undefined {
  return WARNING.exec(text)?.[1];
}

/**
 * Whether agy's words for a failed turn say the model service turned it away for now, once agy's
 * own retries ran out: a 429, a 5xx, a stream cut off on its way, or a request that got no
 * answer. A sign-in, a bad key, any other 4xx, or a refusal is not.
 */
export function isTransient(failure: string): boolean {
  return TRANSIENT_WORDS.some((words) => words.test(failure));
}

/** agy's words for the failures `isTransient` names, as the failure matrix in the docs measured them. */
const TRANSIENT_WORDS: readonly RegExp[] = [
  /\bError (?:429|5\d\d), /,
  /\biterateResponseStream: /,
  /\bnetwork issue connecting to the server\b/,
];

/**
 * The service's sentence for a turn the plan's quota refused, which agy passes on: it names the
 * pool the model draws from and when that pool starts afresh. A signed-in account met
 * `Individual quota reached. Please upgrade your subscription to increase your limits. Resets in
 * 1h42m21s.` on its Gemini models and `Third-party quota reached. Please switch to Gemini models or
 * upgrade your subscription to increase your limits. Resets in 3h49m54s.` on Claude, on 2026-11-26;
 * against a stub, agy 1.5.15 put the same sentence in its executor's words, after `Error 429,
 * Message: `, so it is read wherever it stands.
 */
const QUOTA_REACHED = /\b([A-Za-z][A-Za-z-]*) quota reached\b/;

/** The countdown to the pool's reset in the service's sentence, in days, hours, minutes, and seconds. */
const RESETS_IN = /\bResets in ((?:\d+[dhms])+)(?![A-Za-z0-9])/;

const UNIT_MS: Readonly<Record<string, number>> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
};

/** The pool each of the service's words names, as `quotaPool` keys a model's. */
const POOL_WORDS: Readonly<Record<string, string>> = {
  Individual: ANTIGRAVITY_POOLS.gemini,
  "Third-party": ANTIGRAVITY_POOLS.thirdParty,
};

/** How long a countdown such as `1h42m21s` runs, or null for one that doesn't read. */
function countdownMs(countdown: string): number | null {
  let total = 0;
  for (const [, amount = "", unit = ""] of countdown.matchAll(/(\d+)([dhms])/g)) {
    const ms = UNIT_MS[unit];
    if (ms === undefined) {
      return null;
    }
    total += Number(amount) * ms;
  }
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/**
 * The quota a refusal of the plan's quota reports, from agy's words for the failed turn and when
 * they came, or undefined for any other failure. The pool the words name is limited until the
 * countdown's end, or with no reset when the countdown doesn't read, so the board holds that pool's
 * models alone; words naming a pool `quotaPool` doesn't know limit the whole login the same way.
 */
export function quotaRefusalOf(words: string, at: Date): CliQuota | undefined {
  const reached = QUOTA_REACHED.exec(words);
  if (reached === null) {
    return undefined;
  }
  const countdown = RESETS_IN.exec(words.slice(reached.index))?.[1];
  const ms = countdown === undefined ? null : countdownMs(countdown);
  const observedAt = at.toISOString();
  const limitedUntil = ms === null ? null : new Date(at.getTime() + ms).toISOString();
  const pool = POOL_WORDS[reached[1] ?? ""];
  return CliQuotaSchema.parse(
    pool === undefined
      ? { observedAt, source: "turn", status: "limited", limitedUntil }
      : {
          observedAt,
          source: "turn",
          status: "warning",
          pools: [{ key: pool, limited: true, limitedUntil, observedAt }],
        },
  );
}

/** A tool call's name as the board's steps show it: a board verb as Claude names it, a command as `Bash`. */
function toolNameOf(update: Dict): string {
  const name = str(update["name"]) ?? "";
  if (name.startsWith(BOARD_TOOL_PREFIX)) {
    return `mcp__${BOARD_SERVER}__${name.slice(BOARD_TOOL_PREFIX.length)}`;
  }
  if (update["kind"] === "execute") {
    return "Bash";
  }
  return name !== "" ? name : (str(update["title"]) ?? "tool");
}

/** What the tool was given: agy's arguments without the summary it drops before the call. */
function toolInputOf(update: Dict, name: string): unknown {
  const raw = update["rawInput"] ?? update["args"];
  if (!isDict(raw)) {
    return raw;
  }
  if (name === "Bash" && typeof raw["CommandLine"] === "string") {
    return { command: raw["CommandLine"] };
  }
  return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== TOOL_SUMMARY));
}

/** What a finished tool call returned, as text, from its content blocks or else its raw output. */
function toolOutputOf(update: Dict): string {
  const content = Array.isArray(update["content"]) ? update["content"] : [];
  const texts = content.flatMap((each) => {
    if (!isDict(each)) {
      return [];
    }
    if (each["type"] === "content" && isDict(each["content"])) {
      const block = each["content"];
      return [block["type"] === "text" ? (str(block["text"]) ?? "") : `[${str(block["type"])}]`];
    }
    if (each["type"] === "diff") {
      return [`[diff ${str(each["path"]) ?? ""}]`];
    }
    return [];
  });
  if (texts.length > 0) {
    return texts.join("\n");
  }
  const raw = update["rawOutput"];
  if (typeof raw === "string") {
    return raw;
  }
  return raw === undefined || raw === null ? "" : JSON.stringify(raw);
}

/** The instructions as the system prompt's append, with how the turn must end. */
export function systemAppend(instructions: string, statusSchema: Record<string, unknown>): string {
  return [
    instructions.trimEnd(),
    "",
    "## The status object",
    "",
    "Your turn's last message is the status object alone, as JSON in a ```json fence, matching this JSON Schema:",
    "",
    "```json",
    JSON.stringify(statusSchema),
    "```",
  ].join("\n");
}

/** What a turn whose last message held no valid status object is asked once more. */
export function statusReask(statusSchema: Record<string, unknown>): string {
  return [
    "Your last message held no valid status object. Reply with only the status object, as JSON in a ```json fence, matching this JSON Schema:",
    "",
    "```json",
    JSON.stringify(statusSchema),
    "```",
  ].join("\n");
}

interface TurnRun {
  /** The prompts sent in this turn, the first, a steer's, or the status's: the latest decides its end. */
  seq: number;
  /** The steer each prompt after the first carried, by its sequence number. */
  readonly steers: Map<number, string>;
  /** The reply of the latest prompt, once it came. */
  stopReason: string | null;
  error: Error | undefined;
  /** The failure agy reported in the turn's messages, in its words. */
  failure: string | undefined;
  /** When agy answered with the error or reported the failure. */
  failedAt: Date | undefined;
  usage: Usage;
  /** The text of the message being said, gathered from its chunks until a step or the reply ends it. */
  message: string;
  messageId: string | undefined;
  /** The last message said in full. */
  finalText: string;
  readonly started: Set<string>;
  readonly finished: Set<string>;
  readonly emit: (event: AgentEvent) => void;
  settled: boolean;
  settle: () => void;
  stopped: boolean;
  /** The context the session holds as agy last reported it in this turn. */
  contextTokens: number | undefined;
}

export class AntigravityAcpSession implements ResidentSession {
  session: SessionId;
  /** The model the session runs, as agy reported it when the session opened. */
  model: string | undefined;
  private readonly client: AcpClient;
  private readonly relay: BoardRelay;
  private active: TurnRun | null = null;
  private closed = false;
  private readonly stderrTail: string[] = [];
  private readonly recorded: string[] = [];

  private constructor(
    private readonly options: AcpSessionOptions,
    private readonly spec: AgentSpec,
    private readonly start: ResidentStart,
    process: AcpProcess,
    relay: BoardRelay,
  ) {
    this.session = start.session;
    this.relay = relay;
    this.client = new AcpClient(process, {
      notification: (method, params) => this.onNotification(method, params),
      stderr: (line) => {
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
        options.stderr?.(line);
      },
      line: (line) => {
        if (options.recordDir !== undefined) this.recorded.push(line);
      },
      exit: () => this.onExit(),
    });
  }

  /**
   * Starts the session's relay to the board, which does the board's handshake while agy starts
   * and initializes, then opens or resumes the session once the handshake is done, so a board out
   * of reach fails the turn before the session opens. The relay lives and closes with the session.
   * A stop until then ends the start at once, closing the relay and agy; one that comes once the
   * session is opening lets the open finish, so the session it opened is the turn's, and goes to
   * the turn, which then sends no prompt.
   */
  static async start(
    options: AcpSessionOptions,
    spec: AgentSpec,
    start: ResidentStart,
    control?: TurnControl,
  ): Promise<AntigravityAcpSession> {
    const relay = await BoardRelay.open({
      url: start.mcp.url,
      token: start.mcp.token,
      limitMs: options.handshakeLimitMs,
      clientVersion: options.clientVersion,
    });
    let session: AntigravityAcpSession | undefined;
    let stopped = false;
    const detach = control?.attach({
      stop: () => {
        stopped = true;
        session?.client.close();
        void relay.close();
      },
    });
    try {
      const prefetched = relay.prefetch();
      // A start that fails before it waits for the handshake closes the relay, which ends it.
      prefetched.catch(() => undefined);
      if (stopped) {
        throw new Error(STOPPED_STARTING);
      }
      const spawn = options.spawn ?? defaultSpawnAgy(options.agyPath ?? "agy");
      const child = spawn(acpArgs(options), {
        cwd: spec.cwd,
        env: agyEnv(options, start.mcp.token),
      });
      session = new AntigravityAcpSession(options, spec, start, child, relay);
      const initialized = await initialize(session.client, options);
      if (!appendsSystemPrompt(initialized)) {
        throw new Error("agy acp offers no system prompt append for the instructions");
      }
      await prefetched;
      detach?.();
      if (stopped) {
        throw new Error(STOPPED_STARTING);
      }
      await session.open();
      // agy opens a session whose MCP servers did not connect in time without them, saying
      // nothing, so a session opened without the board's tools listed fails its turn.
      if (!relay.listed) {
        throw new Error("agy opened the session without listing the board's tools from the relay");
      }
    } catch (error) {
      detach?.();
      session?.client.close();
      await relay.close();
      throw stopped ? new Error(STOPPED_STARTING) : error;
    }
    return session;
  }

  private sessionParams(): Dict {
    return {
      cwd: this.spec.cwd,
      // agy reaches the board through the session's relay with the relay's secret, which agy keeps
      // with the conversation; the turn's own token stays with the relay and agy's environment.
      mcpServers: [
        {
          type: "http",
          name: BOARD_SERVER,
          url: this.relay.url,
          headers: [{ name: "Authorization", value: `Bearer ${this.relay.secret}` }],
        },
      ],
      // agy keeps no append with the session, so every open and resume sends the current one.
      _meta: {
        antigravity: {
          systemPrompt: { append: systemAppend(this.start.instructions, this.start.statusSchema) },
        },
      },
    };
  }

  /**
   * Starts a new conversation's session, or resumes a saved one. A saved session is resumed or
   * the turn fails before any model call, never replaced: `session/load`, which takes an id agy
   * has no conversation for and opens an empty one, is never called.
   */
  private async open(): Promise<void> {
    let opened: unknown;
    if (this.start.newSession) {
      opened = await this.client.request("session/new", this.sessionParams());
      const id = isDict(opened) ? str(opened["sessionId"]) : undefined;
      if (id === undefined) {
        throw new Error("agy acp returned no session id");
      }
      this.session = id;
    } else {
      try {
        opened = await this.client.request("session/resume", {
          sessionId: this.start.session,
          ...this.sessionParams(),
        });
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        throw new ResumeError(await this.resumeFailureOf(error), said);
      }
    }
    let selects = configSelectsOf(isDict(opened) ? opened["configOptions"] : undefined);
    // The citizen's model is a family and its effort the family's thinking level, each a select
    // the session reports; one already chosen is left as it is.
    const choose = async (configId: string, value: string | undefined): Promise<void> => {
      if (value === undefined || selects.get(configId)?.current === value) {
        return;
      }
      const answer = await this.client.request("session/set_config_option", {
        sessionId: this.session,
        configId,
        value,
      });
      selects = configSelectsOf(isDict(answer) ? answer["configOptions"] : undefined);
    };
    await choose("model", this.spec.model ?? this.options.model);
    await choose("thought_level", this.spec.effort);
    this.model = selects.get("model")?.current;
  }

  /**
   * Why agy could not resume the session. 1.5.14 and 1.5.15 answer every failure with -32603,
   * "Failed to read session <id>; retry, or load it with session/load", for an id they have no
   * conversation for too, so a session `session/list` doesn't list is lost, and one it lists, or
   * a list that fails, is tried again. A resume that never answers, or a process that ends during
   * it, is tried again.
   */
  private async resumeFailureOf(error: unknown): Promise<ResumeFailure> {
    if (!(error instanceof AcpError)) {
      return "retry";
    }
    try {
      let cursor: string | undefined;
      do {
        const page = await this.client.request(
          "session/list",
          cursor === undefined ? {} : { cursor },
        );
        const sessions = isDict(page) && Array.isArray(page["sessions"]) ? page["sessions"] : [];
        if (sessions.some((each) => isDict(each) && each["sessionId"] === this.start.session)) {
          return "retry";
        }
        cursor = isDict(page) ? str(page["nextCursor"]) : undefined;
      } while (cursor !== undefined);
      return "lost";
    } catch {
      return "retry";
    }
  }

  /** A process that dies mid-turn never replies to the prompt; the turn ends with what it said last. */
  private onExit(): void {
    const turn = this.active;
    if (turn === null) {
      return;
    }
    const said = this.stderrTail.join("\n").trim();
    turn.error ??= new Error(said.length > 0 ? `agy acp exited: ${said}` : "agy acp exited");
    turn.settle();
  }

  private async flushRecording(): Promise<void> {
    if (this.options.recordDir === undefined || this.recorded.length === 0) {
      return;
    }
    const lines = this.recorded.splice(0);
    await mkdir(this.options.recordDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await appendFile(
      path.join(this.options.recordDir, `antigravity-${this.spec.agent}-${stamp}.jsonl`),
      `${lines.join("\n")}\n`,
      "utf8",
    );
  }

  /** Ends the message being said: one `text` step for it, its chunks joined. */
  private endMessage(turn: TurnRun): void {
    if (turn.message.length > 0) {
      turn.emit({ type: "text", delta: turn.message });
      turn.finalText = turn.message;
    }
    turn.message = "";
    turn.messageId = undefined;
  }

  private onNotification(method: string, params: unknown): void {
    const turn = this.active;
    if (turn === null || method !== "session/update" || !isDict(params)) {
      return;
    }
    if (params["sessionId"] !== this.session || !isDict(params["update"])) {
      return;
    }
    const update = params["update"];
    switch (update["sessionUpdate"]) {
      case "agent_message_chunk": {
        const content = update["content"];
        const text =
          isDict(content) && content["type"] === "text" ? str(content["text"]) : undefined;
        const failure = text === undefined ? undefined : warningOf(text);
        if (failure !== undefined) {
          this.endMessage(turn);
          turn.failure = failure;
          turn.failedAt = this.now();
          return;
        }
        // The model said more after a warning, so the warning did not end the turn.
        turn.failure = undefined;
        const id = str(update["messageId"]);
        if (id !== undefined && turn.messageId !== undefined && id !== turn.messageId) {
          this.endMessage(turn);
        }
        turn.messageId = id ?? turn.messageId;
        turn.message += text ?? "";
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        this.endMessage(turn);
        turn.failure = undefined;
        const id = str(update["toolCallId"]) ?? "";
        const name = toolNameOf(update);
        if (!turn.started.has(id)) {
          turn.started.add(id);
          turn.emit({ type: "tool_call", name, input: toolInputOf(update, name) });
        }
        const status = update["status"];
        if ((status === "completed" || status === "failed") && !turn.finished.has(id)) {
          turn.finished.add(id);
          const output = toolOutputOf(update);
          turn.emit({
            type: "tool_result",
            name,
            ok: status === "completed",
            ...(output === "" ? {} : { output: capOutput(output) }),
          });
        }
        return;
      }
      case "usage_update": {
        const used = num(update["used"]);
        if (used > 0) {
          turn.contextTokens = used;
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Sends one prompt of the turn. Its reply counts its usage; the latest prompt's reply ends the
   * turn, and an earlier one's, which agy ends at once when a steer's prompt arrives, says agy took
   * that steer.
   */
  private prompt(turn: TurnRun, text: string): void {
    void this.sendPrompt(turn, ++turn.seq, text);
  }

  private async sendPrompt(turn: TurnRun, seq: number, text: string): Promise<void> {
    let reply: unknown;
    try {
      reply = await this.client.request(
        "session/prompt",
        { sessionId: this.session, prompt: [{ type: "text", text }] },
        null,
      );
    } catch (error) {
      if (seq === turn.seq) {
        turn.error = error instanceof Error ? error : new Error(String(error));
        turn.failedAt = this.now();
        turn.settle();
      }
      return;
    }
    const answer = isDict(reply) ? reply : {};
    turn.usage = addUsage(turn.usage, usageOf(answer["usage"]));
    if (seq === turn.seq) {
      turn.stopReason = str(answer["stopReason"]) ?? "end_turn";
      turn.settle();
      return;
    }
    const steer = turn.steers.get(seq + 1);
    if (steer !== undefined) {
      turn.steers.delete(seq + 1);
      turn.emit({ type: "steered", steer });
    }
  }

  async runTurn(
    prompt: string,
    onEvent?: (event: AgentEvent) => void,
    control?: TurnControl,
  ): Promise<TurnResult> {
    if (this.closed) {
      throw new Error("the resident session has ended");
    }
    if (this.active !== null) {
      throw new Error("a turn is already running on this resident session");
    }
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    let done = Promise.withResolvers<void>();
    const turn: TurnRun = {
      seq: 0,
      steers: new Map(),
      stopReason: null,
      error: undefined,
      failure: undefined,
      failedAt: undefined,
      usage: ZERO_USAGE,
      message: "",
      messageId: undefined,
      finalText: "",
      started: new Set(),
      finished: new Set(),
      emit,
      settled: false,
      settle: () => {
        if (!turn.settled) {
          turn.settled = true;
          done.resolve();
        }
      },
      stopped: false,
      contextTokens: undefined,
    };
    this.active = turn;
    emit({
      type: "turn_started",
      agent: this.spec.agent,
      session: this.session,
      runner: this.spec.runner,
      ...(this.model === undefined ? {} : { model: this.model }),
    });

    let timedOut = false;
    const limit = this.start.limits.timeoutMs;
    const timer =
      limit === null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            this.client.notify("session/cancel", { sessionId: this.session });
            setTimeout(() => turn.settle(), STOP_GRACE_MS).unref?.();
          }, limit);
    const detach = control?.attach({
      steer: (steer) => Promise.resolve(this.steer(turn, steer.id, steer.text)),
      stop: () => this.stop(turn),
    });
    let status: TurnStatus | null = null;
    try {
      // A stop handed over as the turn attached, as one that came while the session opened, has
      // ended it already, so the model gets no request.
      if (!turn.stopped) {
        this.prompt(turn, prompt);
      }
      await done.promise;
      this.endMessage(turn);
      status = parseTurnStatus(null, turn.finalText);
      // ACP takes no output schema, so a turn that ended without the status is asked once more.
      if (
        status === null &&
        turn.stopReason === "end_turn" &&
        turn.error === undefined &&
        turn.failure === undefined &&
        !turn.stopped &&
        !timedOut
      ) {
        done = Promise.withResolvers<void>();
        turn.settled = false;
        turn.stopReason = null;
        this.prompt(turn, statusReask(this.start.statusSchema));
        await done.promise;
        this.endMessage(turn);
        status = parseTurnStatus(null, turn.finalText);
      }
    } finally {
      detach?.();
      clearTimeout(timer);
      this.active = null;
    }
    await this.flushRecording();

    let exitReason: TurnExitReason;
    let error: string | undefined = turn.error?.message ?? turn.failure;
    if (turn.stopped) {
      exitReason = "stopped";
      error = undefined;
    } else if (timedOut) {
      exitReason = "timeout";
      error = `turn exceeded ${limit} ms`;
    } else if (error !== undefined) {
      exitReason = "error";
    } else if (turn.stopReason === "end_turn") {
      exitReason = "completed";
    } else if (turn.stopReason === "cancelled") {
      exitReason = "interrupted";
      error = "turn interrupted";
    } else {
      exitReason = "error";
      error = `agy ended the turn: ${turn.stopReason ?? "no reply"}`;
    }
    if (exitReason === "completed" && status === null) {
      error = "the turn ended without a parsable status object";
    }
    // A refusal of the plan's quota, whichever way agy said it, holds the pool it names until its
    // reset, and reads as the plan's limit, as Claude's and Codex's do.
    const quota =
      exitReason === "error" && error !== undefined
        ? quotaRefusalOf(error, turn.failedAt ?? this.now())
        : undefined;
    if (quota !== undefined) {
      error = `usage limit reached: ${error}`;
    }
    if (error !== undefined) {
      emit({ type: "error", message: error });
    }
    // A failure agy reports in a message is the model service's; one it answers a prompt with,
    // such as a sign-in it lacks, is the client's or the account's, and never transient. Nor is
    // the plan's quota, though agy may say it with a 429's words.
    const transient =
      exitReason === "error" &&
      quota === undefined &&
      turn.error === undefined &&
      turn.failure !== undefined &&
      isTransient(turn.failure);
    emit({ type: "turn_completed", usage: turn.usage, costUsd: 0, status, exitReason });
    return {
      events,
      finalText: turn.finalText,
      usage: turn.usage,
      costUsd: 0,
      status,
      exitReason,
      ...(error === undefined ? {} : { error }),
      session: this.session,
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(turn.contextTokens === undefined ? {} : { contextTokens: turn.contextTokens }),
      ...(quota === undefined ? {} : { quota }),
      ...(transient ? { transient: true } : {}),
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Input into the running turn: a second `session/prompt`, which agy adds to the conversation once
   * the model's request in flight is answered, ending the first prompt with no usage. The steer's
   * reply then carries the rest of the turn and every request's usage since.
   */
  private steer(turn: TurnRun, id: string, text: string): boolean {
    if (this.active !== turn || turn.stopped || turn.settled) {
      return false;
    }
    turn.steers.set(turn.seq + 1, id);
    this.prompt(turn, text);
    return true;
  }

  /**
   * Cancels the running turn, whose prompt agy then ends as cancelled; the turn is `stopped`. A turn
   * that has sent no prompt yet ends at once, with nothing sent to agy.
   */
  private stop(turn: TurnRun): void {
    if (this.active !== turn || turn.stopped) {
      return;
    }
    turn.stopped = true;
    if (turn.seq === 0) {
      turn.settle();
      return;
    }
    this.client.notify("session/cancel", { sessionId: this.session });
    setTimeout(() => turn.settle(), STOP_GRACE_MS).unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.client.close();
    await this.relay.close();
  }
}
