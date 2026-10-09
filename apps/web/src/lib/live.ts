import {
  conversationPart,
  LiveTurnEventSchema,
  sessionKey,
  type LiveTurnEvent,
  type TranscriptEntry,
  type TurnExitReason,
} from "@stellaris/shared";
import { createContext, useContext, useSyncExternalStore } from "react";
import { span } from "./format.js";
import { followStream } from "./sse.js";

interface StepBase {
  /** The streamed event's sequence number, unique while the server runs. */
  readonly seq: number;
  readonly at: string;
}

/** One thing a citizen did in a turn: said something, used a tool, or hit an error. */
export type Step =
  | (StepBase & { readonly kind: "say"; readonly text: string })
  | (StepBase & {
      readonly kind: "tool";
      readonly name: string;
      /** What the call was about, on one line: a command, a path, a URL, a query. */
      readonly summary: string;
      /** The call's input in full, up to `DETAIL_LIMIT` characters. */
      readonly detail: string;
      /** Whether it succeeded, or `null` until its result arrives. */
      readonly ok: boolean | null;
      /** What it returned, as the adapter cut it, or `null` until then or when it returned nothing. */
      readonly output: string | null;
    })
  | (StepBase & { readonly kind: "error"; readonly message: string })
  | (StepBase & {
      readonly kind: "steer";
      /** The posts delivered into the turn, as the citizen was handed them. */
      readonly posts: readonly SteerPost[];
      /** Who wrote them, each once. */
      readonly from: readonly string[];
    });

/** A post a steer delivered: who wrote it, where, when, and what it said. */
export interface SteerPost {
  readonly author: string;
  readonly where: string;
  readonly at: string;
  readonly body: string;
}

export interface TurnEnd {
  readonly at: string;
  readonly exitReason: TurnExitReason;
  readonly summary: string | null;
}

/** A citizen's latest turn as the live stream shows it. */
export interface LiveTurn {
  readonly agent: string;
  /** A project slug or `society`. */
  readonly scope: string;
  /** The thread whose conversation the turn is in; absent for the home conversation. */
  readonly thread?: string | undefined;
  /** The channel, never general, whose conversation the turn is in. */
  readonly channel?: string | undefined;
  /** When the turn started, or its first step still held when the start is not. */
  readonly startedAt: string;
  /** False when the server's buffer or the step cap has dropped the turn's first steps. */
  readonly fromStart: boolean;
  readonly model: string | null;
  readonly steps: readonly Step[];
  readonly lastAt: string;
  readonly end: TurnEnd | null;
}

/**
 * The latest turn of every citizen in every conversation the stream has reported, keyed like the
 * scheduler's sessions: a citizen may be in turns in several at once.
 */
export type LiveTurns = ReadonlyMap<string, LiveTurn>;

/** Which conversation of a scope: a thread's, a channel's, or, with neither, the home. */
export interface ConversationIn {
  readonly thread?: string | undefined;
  readonly channel?: string | undefined;
}

export function pairKey(agent: string, scope: string, conversation: ConversationIn = {}): string {
  return sessionKey(agent, scope, conversationPart(conversation));
}

/**
 * A turn's conversation as the citizen view's `scope` search names it: the scope, `scope/thread`,
 * or `scope/#channel`.
 */
export function conversationOf(turn: { scope: string } & ConversationIn): string {
  const part = conversationPart(turn);
  return part === undefined ? turn.scope : `${turn.scope}/${part}`;
}

/** A citizen's turns, the most recently active first. */
export function turnsOf(turns: LiveTurns, agent: string): LiveTurn[] {
  return [...turns.values()]
    .filter((turn) => turn.agent === agent)
    .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt));
}

const MAX_STEPS = 400;
// Rows cut summaries at their own width; this only bounds what is kept.
const SUMMARY_LIMIT = 400;
const DETAIL_LIMIT = 4_000;

// A steer's text is the digest's rendering: a heading and a line for the citizen, then each post
// under a heading of its time, place, and author, as `### [ts] where from @author (message id)`.
const POST_HEADING =
  /^\[([^\]]*)\] (.*?) from @([a-z0-9][a-z0-9-]*)(?:, who .*?)? \(message [0-9A-Z]+\)$/;

/** The posts a steer delivered, read back from the text the citizen was handed. */
export function describeSteer(text: string): { posts: SteerPost[]; from: string[] } {
  const posts = text
    .split(/^### /m)
    .slice(1)
    .flatMap((block) => {
      const [heading = "", ...rest] = block.split("\n");
      const match = POST_HEADING.exec(heading.trim());
      if (match === null) {
        return [];
      }
      return [
        {
          at: match[1] ?? "",
          where: match[2] ?? "",
          author: match[3] ?? "",
          body: rest.join("\n").trim(),
        },
      ];
    });
  return { posts, from: [...new Set(posts.map((post) => post.author))] };
}

/** A tool's name as a reader knows it: board verbs bare, other MCP tools as `server:tool`. */
export function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp === null) {
    return name;
  }
  return mcp[1] === "board" ? (mcp[2] ?? name) : `${mcp[1]}:${mcp[2]}`;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** The whole text on one line, as argus shows a tool's argument: line breaks become spaces. */
function flatten(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** Codex runs every command through a login shell; the command is what is inside the quotes. */
function unwrapShell(command: string): string {
  const wrapped = /^\/bin\/(?:ba)?sh -lc (["'])([\s\S]*)\1$/.exec(command.trim());
  return wrapped?.[2] ?? command;
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input))
    : {};
}

const SUMMARY_FIELDS = ["file_path", "path", "url", "query", "pattern", "description", "prompt"];

/** What a tool call was about in one line, and its input in full. */
export function describeCall(input: unknown): { summary: string; detail: string } {
  const fields = record(input);
  const command = fields["command"];
  if (typeof command === "string") {
    const inner = unwrapShell(command);
    return { summary: clip(flatten(inner), SUMMARY_LIMIT), detail: clip(inner, DETAIL_LIMIT) };
  }
  const detail = clip(JSON.stringify(input ?? null, null, 2), DETAIL_LIMIT);
  const changes = fields["changes"];
  if (Array.isArray(changes)) {
    const paths = changes
      .map((change) => record(change)["path"])
      .filter((path): path is string => typeof path === "string");
    return { summary: clip(paths.join(", "), SUMMARY_LIMIT), detail };
  }
  const named = SUMMARY_FIELDS.map((key) => fields[key]).find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  const scalars = Object.values(fields).filter(
    (value) => typeof value === "string" || typeof value === "number",
  );
  const summary = named ?? scalars.slice(0, 3).join(" · ");
  return { summary: clip(flatten(summary), SUMMARY_LIMIT), detail };
}

// The status every turn ends with reaches the footer through `turn_completed`; Claude files it
// with this tool and Codex says it as its last message, and neither is a step worth showing.
const STATUS_TOOL = "StructuredOutput";

function isStatusText(text: string, summary: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return record(parsed)["summary"] === summary;
  } catch {
    return false;
  }
}

function withStep(turn: LiveTurn, step: Step, maxSteps: number): LiveTurn {
  const steps = [...turn.steps, step];
  const overflow = steps.length - maxSteps;
  return {
    ...turn,
    steps: overflow > 0 ? steps.slice(overflow) : steps,
    fromStart: turn.fromStart && overflow <= 0,
    lastAt: step.at,
  };
}

/**
 * The turns after one more streamed event; the input is not changed. The live store keeps at most
 * `maxSteps` steps of a turn, the newest; a stored transcript is folded whole.
 */
export function applyLive(
  turns: LiveTurns,
  item: LiveTurnEvent,
  { maxSteps }: { maxSteps: number } = { maxSteps: MAX_STEPS },
): LiveTurns {
  const { event } = item;
  const key = pairKey(item.agent, item.project, item);
  const current = turns.get(key);
  const next = new Map(turns);
  const where = {
    agent: item.agent,
    scope: item.project,
    ...(item.thread === undefined ? {} : { thread: item.thread }),
    ...(item.channel === undefined ? {} : { channel: item.channel }),
  };
  if (event.type === "turn_started") {
    next.set(key, {
      ...where,
      startedAt: item.ts,
      fromStart: true,
      model: event.model ?? null,
      steps: [],
      lastAt: item.ts,
      end: null,
    });
    return next;
  }
  // An event without a turn open in its scope belongs to a turn whose start is out of the buffer.
  const turn: LiveTurn =
    current !== undefined && current.end === null
      ? current
      : {
          ...where,
          startedAt: item.ts,
          fromStart: false,
          model: null,
          steps: [],
          lastAt: item.ts,
          end: null,
        };
  switch (event.type) {
    case "text":
      next.set(
        key,
        withStep(turn, { kind: "say", seq: item.seq, at: item.ts, text: event.delta }, maxSteps),
      );
      break;
    case "tool_call":
      if (event.name === STATUS_TOOL) {
        break;
      }
      next.set(
        key,
        withStep(
          turn,
          {
            kind: "tool",
            seq: item.seq,
            at: item.ts,
            name: event.name,
            ...describeCall(event.input),
            ok: null,
            output: null,
          },
          maxSteps,
        ),
      );
      break;
    case "tool_result": {
      // Results carry no call id; the oldest unanswered call of the same tool is the one.
      const index = turn.steps.findIndex(
        (step) => step.kind === "tool" && step.name === event.name && step.ok === null,
      );
      const step = turn.steps[index];
      if (step?.kind === "tool") {
        const steps = turn.steps.with(index, {
          ...step,
          ok: event.ok,
          output: event.output ?? null,
        });
        next.set(key, { ...turn, steps, lastAt: item.ts });
      }
      break;
    }
    case "error":
      next.set(
        key,
        withStep(
          turn,
          { kind: "error", seq: item.seq, at: item.ts, message: event.message },
          maxSteps,
        ),
      );
      break;
    case "steered":
      next.set(
        key,
        withStep(
          turn,
          { kind: "steer", seq: item.seq, at: item.ts, ...describeSteer(event.text ?? "") },
          maxSteps,
        ),
      );
      break;
    case "turn_completed": {
      const summary = event.status?.summary ?? null;
      const last = turn.steps.at(-1);
      const said = last?.kind === "say" && summary !== null && isStatusText(last.text, summary);
      next.set(key, {
        ...turn,
        steps: said ? turn.steps.slice(0, -1) : turn.steps,
        lastAt: item.ts,
        end: {
          at: item.ts,
          exitReason: event.exitReason,
          summary,
        },
      });
      break;
    }
    case "approval_requested":
      break;
  }
  return next;
}

/** A finished turn from its stored transcript, folded exactly as the live stream would be. */
export function transcriptTurn(
  entries: readonly TranscriptEntry[],
  agent: string,
  scope: string,
  conversation: ConversationIn = {},
): LiveTurn | undefined {
  let turns: LiveTurns = new Map();
  for (const [index, entry] of entries.entries()) {
    turns = applyLive(
      turns,
      {
        seq: index + 1,
        ts: entry.ts,
        agent,
        project: scope,
        ...(conversation.thread === undefined ? {} : { thread: conversation.thread }),
        ...(conversation.channel === undefined ? {} : { channel: conversation.channel }),
        event: entry.event,
      },
      { maxSteps: Number.POSITIVE_INFINITY },
    );
  }
  return turns.get(pairKey(agent, scope, conversation));
}

/** The first line a `post_message` call posts, for the bubble that rises from its star. */
export function postedLine(name: string, input: unknown): string | null {
  if (toolLabel(name) !== "post_message") {
    return null;
  }
  const body = record(input)["body"];
  const line = typeof body === "string" ? firstLine(body).replace(/^[#>*\-\s]+/, "") : "";
  return line === "" ? null : clip(line, SUMMARY_LIMIT);
}

/** The newest step of a turn in one line, for lists. */
export function lastLine(turn: LiveTurn): string | null {
  const step = turn.steps.at(-1);
  if (step === undefined) {
    return null;
  }
  if (step.kind === "tool") {
    return `${toolLabel(step.name)} · ${step.summary}`;
  }
  if (step.kind === "steer") {
    return `took ${postCount(step.posts.length)}${step.from.length === 0 ? "" : ` from ${step.from.join(", ")}`}`;
  }
  return clip(firstLine(step.kind === "say" ? step.text : step.message), SUMMARY_LIMIT);
}

export function postCount(posts: number): string {
  return posts === 1 ? "1 post" : `${posts} posts`;
}

/** "42s", "4m", or "1h 12m" since a moment. */
export function elapsed(since: string, now: number): string {
  return span(now - Date.parse(since));
}

/**
 * The live turns, kept from the server's turn stream. Every connection replays the server's
 * recent buffer from the start, so a reconnect, or a server that restarted and numbers its events
 * anew, rebuilds the picture rather than patching it.
 */
export class LiveStore {
  private turns: LiveTurns = new Map();
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(item: LiveTurnEvent) => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = (): LiveTurns => this.turns;

  /**
   * Every event as it arrives, for motion in the sky. A connection replays the server's buffer
   * first, so a listener that only wants what is happening now checks the event's time.
   */
  readonly listen = (listener: (item: LiveTurnEvent) => void): (() => void) => {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  };

  follow(token: string): () => void {
    return followStream({
      token,
      url: () => "/api/turns/stream?since=0",
      onOpen: () => {
        this.turns = new Map();
        this.emit();
      },
      onData: (data) => {
        const parsed = LiveTurnEventSchema.safeParse(JSON.parse(data));
        if (parsed.success) {
          this.turns = applyLive(this.turns, parsed.data);
          for (const listener of this.eventListeners) {
            listener(parsed.data);
          }
        }
      },
      onBatch: () => this.emit(),
    });
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const LiveContext = createContext<LiveStore | null>(null);

export function useLiveTurns(): LiveTurns {
  const store = useContext(LiveContext);
  if (store === null) {
    throw new Error("useLiveTurns needs a LiveContext");
  }
  return useSyncExternalStore(store.subscribe, store.snapshot);
}
