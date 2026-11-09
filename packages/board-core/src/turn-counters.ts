import { CliKindSchema, type BoardEvent, type CliKind, type Usage } from "@stellaris/shared";
import { TurnHistoryPayloadSchema } from "./turn-history.js";

/** The kinds of token a turn's usage holds, as the token counter labels them. */
export const TOKEN_KINDS = ["input", "output", "cache_read", "cache_write"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

const USAGE_FIELD: Record<TokenKind, keyof Usage> = {
  input: "inputTokens",
  output: "outputTokens",
  cache_read: "cacheReadTokens",
  cache_write: "cacheWriteTokens",
};

/** A label's value when neither the turn's end nor its citizen's record names it. */
export const UNKNOWN_LABEL = "unknown";

/** The tokens of one kind that one citizen's turns used on one CLI and model. */
export interface TurnTokenSeries {
  readonly agent: string;
  readonly cli: string;
  readonly model: string;
  readonly kind: TokenKind;
  readonly tokens: number;
}

/** One citizen's finished turns of one outcome and trigger. */
export interface TurnSeries {
  readonly agent: string;
  readonly outcome: "completed" | "failed";
  readonly trigger: string;
  readonly turns: number;
}

export interface TurnCounts {
  readonly tokens: readonly TurnTokenSeries[];
  readonly turns: readonly TurnSeries[];
}

/** Orders by UTF-16 code units, as the board sorts names, never by the host's locale. */
function byKey<T>(entries: ReadonlyMap<string, T>): T[] {
  return [...entries]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, series]) => series);
}

/**
 * Every finished turn counted as it ends, for Prometheus: the turns `tokenUse` counts over all
 * time, by the same schema, so the two agree, and the tokens of those that counted them. Labels
 * name a citizen, a CLI, a model, a kind of token, an outcome, and a trigger, never a thread, a
 * task, or a turn. Adding is the only change, so every series only grows.
 */
export class TurnCounters {
  private readonly tokens = new Map<string, TurnTokenSeries>();
  private readonly turns = new Map<string, TurnSeries>();

  /**
   * `cliOf` names a citizen's CLI for an end logged before ends named theirs: a turn runs on the
   * CLI its citizen's record names, which nothing changes after the citizen is added.
   */
  constructor(private readonly cliOf: (agent: string) => CliKind | null) {}

  /** Counts a turn's end, `turn.completed` or `turn.failed`, and passes over any other event. */
  add(event: BoardEvent): void {
    if (event.type !== "turn.completed" && event.type !== "turn.failed") {
      return;
    }
    const turn = TurnHistoryPayloadSchema.safeParse(event.payload);
    if (!turn.success) {
      return;
    }
    const agent = event.actor;
    const outcome = event.type === "turn.failed" ? "failed" : "completed";
    const trigger = turn.data.trigger;
    const counted = JSON.stringify([agent, outcome, trigger]);
    this.turns.set(counted, {
      agent,
      outcome,
      trigger,
      turns: (this.turns.get(counted)?.turns ?? 0) + 1,
    });
    const usage = turn.data.usage;
    if (usage === undefined) {
      return;
    }
    const named = CliKindSchema.safeParse(event.payload["cli"]);
    const cli = (named.success ? named.data : this.cliOf(agent)) ?? UNKNOWN_LABEL;
    const model = turn.data.model ?? UNKNOWN_LABEL;
    for (const kind of TOKEN_KINDS) {
      const key = JSON.stringify([agent, cli, model, kind]);
      this.tokens.set(key, {
        agent,
        cli,
        model,
        kind,
        tokens: (this.tokens.get(key)?.tokens ?? 0) + usage[USAGE_FIELD[kind]],
      });
    }
  }

  /** The counts so far, in an order that holds from one read to the next. */
  read(): TurnCounts {
    return { tokens: byKey(this.tokens), turns: byKey(this.turns) };
  }
}
