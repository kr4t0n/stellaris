import { LiveTurnEventSchema, type LiveTurnEvent, type TurnExitReason } from "@stellaris/shared";
import { createContext, useContext, useSyncExternalStore } from "react";
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
      /** One line saying what the call was about: a command, a path, a URL, a query. */
      readonly summary: string;
      /** The call's input in full, up to `DETAIL_LIMIT` characters. */
      readonly detail: string;
      /** Whether it succeeded, or `null` until its result arrives. */
      readonly ok: boolean | null;
    })
  | (StepBase & { readonly kind: "error"; readonly message: string });

export interface TurnEnd {
  readonly at: string;
  readonly exitReason: TurnExitReason;
  readonly costUsd: number;
  readonly summary: string | null;
}

/** A citizen's latest turn as the live stream shows it. */
export interface LiveTurn {
  readonly agent: string;
  /** A project slug or `society`. */
  readonly scope: string;
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
 * The latest turn of every citizen in every scope the stream has reported, keyed like the
 * scheduler's pairs: a citizen may be in turns in two scopes at once.
 */
export type LiveTurns = ReadonlyMap<string, LiveTurn>;

export function pairKey(agent: string, scope: string): string {
  return `${agent}/${scope}`;
}

/** A citizen's turns, the most recently active first. */
export function turnsOf(turns: LiveTurns, agent: string): LiveTurn[] {
  return [...turns.values()]
    .filter((turn) => turn.agent === agent)
    .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt));
}

const MAX_STEPS = 400;
const SUMMARY_LIMIT = 160;
const DETAIL_LIMIT = 4_000;

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
    return { summary: clip(firstLine(inner), SUMMARY_LIMIT), detail: clip(inner, DETAIL_LIMIT) };
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
  return { summary: clip(firstLine(summary), SUMMARY_LIMIT), detail };
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

function withStep(turn: LiveTurn, step: Step): LiveTurn {
  const steps = [...turn.steps, step];
  const overflow = steps.length - MAX_STEPS;
  return {
    ...turn,
    steps: overflow > 0 ? steps.slice(overflow) : steps,
    fromStart: turn.fromStart && overflow <= 0,
    lastAt: step.at,
  };
}

/** The turns after one more streamed event; the input is not changed. */
export function applyLive(turns: LiveTurns, item: LiveTurnEvent): LiveTurns {
  const { event } = item;
  const key = pairKey(item.agent, item.project);
  const current = turns.get(key);
  const next = new Map(turns);
  if (event.type === "turn_started") {
    next.set(key, {
      agent: item.agent,
      scope: item.project,
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
          agent: item.agent,
          scope: item.project,
          startedAt: item.ts,
          fromStart: false,
          model: null,
          steps: [],
          lastAt: item.ts,
          end: null,
        };
  switch (event.type) {
    case "text":
      next.set(key, withStep(turn, { kind: "say", seq: item.seq, at: item.ts, text: event.delta }));
      break;
    case "tool_call":
      if (event.name === STATUS_TOOL) {
        break;
      }
      next.set(
        key,
        withStep(turn, {
          kind: "tool",
          seq: item.seq,
          at: item.ts,
          name: event.name,
          ...describeCall(event.input),
          ok: null,
        }),
      );
      break;
    case "tool_result": {
      // Results carry no call id; the oldest unanswered call of the same tool is the one.
      const index = turn.steps.findIndex(
        (step) => step.kind === "tool" && step.name === event.name && step.ok === null,
      );
      const step = turn.steps[index];
      if (step?.kind === "tool") {
        const steps = turn.steps.with(index, { ...step, ok: event.ok });
        next.set(key, { ...turn, steps, lastAt: item.ts });
      }
      break;
    }
    case "error":
      next.set(
        key,
        withStep(turn, { kind: "error", seq: item.seq, at: item.ts, message: event.message }),
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
          costUsd: event.costUsd,
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

/** The newest step of a turn in one line, for lists. */
export function lastLine(turn: LiveTurn): string | null {
  const step = turn.steps.at(-1);
  if (step === undefined) {
    return null;
  }
  if (step.kind === "tool") {
    return `${toolLabel(step.name)} · ${step.summary}`;
  }
  return clip(firstLine(step.kind === "say" ? step.text : step.message), SUMMARY_LIMIT);
}

/** "42s", "4m", or "1h 12m" since a moment. */
export function elapsed(since: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The live turns, kept from the server's turn stream. Every connection replays the server's
 * recent buffer from the start, so a reconnect, or a server that restarted and numbers its events
 * anew, rebuilds the picture rather than patching it.
 */
export class LiveStore {
  private turns: LiveTurns = new Map();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = (): LiveTurns => this.turns;

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
