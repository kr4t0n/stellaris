import type { TurnCounters, TurnCounts } from "@stellaris/board-core";
import { Hono } from "hono";

/** Prometheus's text exposition format, version 0.0.4, which every Prometheus scrapes. */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** A label's value as the text format quotes it: backslash, double quote, and newline escaped. */
function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

function sample(name: string, labels: Record<string, string>, value: number): string {
  const pairs = Object.entries(labels).map(([label, text]) => `${label}=${quoted(text)}`);
  return `${name}{${pairs.join(",")}} ${value}`;
}

/** The turn counters in Prometheus's text format: each counter's help, type, and series. */
export function prometheusText(counts: TurnCounts): string {
  return [
    "# HELP stellaris_turn_tokens_total Tokens finished turns used, by citizen, CLI, model, and kind: input, output, cache_read, or cache_write.",
    "# TYPE stellaris_turn_tokens_total counter",
    ...counts.tokens.map(({ agent, cli, model, kind, tokens }) =>
      sample("stellaris_turn_tokens_total", { agent, cli, model, kind }, tokens),
    ),
    "# HELP stellaris_turns_total Finished turns, by citizen, outcome (completed or failed), and the trigger that woke them.",
    "# TYPE stellaris_turns_total counter",
    ...counts.turns.map(({ agent, outcome, trigger, turns }) =>
      sample("stellaris_turns_total", { agent, outcome, trigger }, turns),
    ),
    "",
  ].join("\n");
}

/**
 * What the metrics port serves: `GET /metrics`, read from the counters alone, and nothing else.
 * It asks for no token, so it carries counts and names, never a message or a secret.
 */
export function createMetricsApp(counters: TurnCounters): Hono {
  const app = new Hono();
  app.get("/metrics", (c) =>
    c.body(prometheusText(counters.read()), 200, { "content-type": PROMETHEUS_CONTENT_TYPE }),
  );
  app.notFound((c) => c.text("not found", 404));
  return app;
}
