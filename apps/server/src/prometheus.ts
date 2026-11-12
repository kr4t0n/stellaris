import {
  FAILURE_REASONS,
  WAKE_LATENCY_BUCKETS,
  type TurnCounters,
  type TurnCounts,
  type WakeLatencySeries,
} from "@stellaris/board-core";
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

/** One citizen's wake-latency histogram: its buckets, then its sum and count, in seconds. */
function histogram(name: string, { agent, buckets, count, sumMs }: WakeLatencySeries): string[] {
  return [
    ...WAKE_LATENCY_BUCKETS.map((bound, at) =>
      sample(`${name}_bucket`, { agent, le: String(bound) }, buckets[at] ?? 0),
    ),
    sample(`${name}_bucket`, { agent, le: "+Inf" }, count),
    sample(`${name}_sum`, { agent }, sumMs / 1000),
    sample(`${name}_count`, { agent }, count),
  ];
}

/** The counters in Prometheus's text format: each counter's help, type, and series. */
export function prometheusText(counts: TurnCounts): string {
  return [
    "# HELP stellaris_turn_tokens_total Tokens finished turns used, by project (the turn's scope: a project, or society), citizen, CLI, model, and kind: input, output, cache_read, or cache_write.",
    "# TYPE stellaris_turn_tokens_total counter",
    ...counts.tokens.map(({ project, agent, cli, model, kind, tokens }) =>
      sample("stellaris_turn_tokens_total", { project, agent, cli, model, kind }, tokens),
    ),
    "# HELP stellaris_turns_total Finished turns, by citizen, outcome (completed or failed), and the trigger that woke them.",
    "# TYPE stellaris_turns_total counter",
    ...counts.turns.map(({ agent, outcome, trigger, turns }) =>
      sample("stellaris_turns_total", { agent, outcome, trigger }, turns),
    ),
    "# HELP stellaris_turns_running Turns running now, begun and not yet ended, by project (the turn's scope: a project, or society) and citizen; 0 for each that has run a turn.",
    "# TYPE stellaris_turns_running gauge",
    ...counts.running.map(({ project, agent, turns }) =>
      sample("stellaris_turns_running", { project, agent }, turns),
    ),
    "# HELP stellaris_turns_idle_total Completed turns that took no board action, by citizen and trigger; reflections and turns without a transcript are left out.",
    "# TYPE stellaris_turns_idle_total counter",
    ...counts.idle.map(({ agent, trigger, turns }) =>
      sample("stellaris_turns_idle_total", { agent, trigger }, turns),
    ),
    `# HELP stellaris_turns_failed_total Failed turns, by citizen, CLI, and reason: ${FAILURE_REASONS.join(", ")}.`,
    "# TYPE stellaris_turns_failed_total counter",
    ...counts.failed.map(({ agent, cli, reason, turns }) =>
      sample("stellaris_turns_failed_total", { agent, cli, reason }, turns),
    ),
    "# HELP stellaris_task_sendbacks_total Task stages sent back to an earlier stage, by project and who sent them back.",
    "# TYPE stellaris_task_sendbacks_total counter",
    ...counts.sendBacks.map(({ project, by, sendBacks }) =>
      sample("stellaris_task_sendbacks_total", { project, by }, sendBacks),
    ),
    "# HELP stellaris_wake_latency_seconds Seconds from a post naming a citizen to the turn that answered it, its start or the steer that handed it the post, by citizen.",
    "# TYPE stellaris_wake_latency_seconds histogram",
    ...counts.wakeLatency.flatMap((series) => histogram("stellaris_wake_latency_seconds", series)),
    "# HELP stellaris_wake_mentions_waiting Mentions of a citizen no turn has answered yet, by citizen; each waits a week at most.",
    "# TYPE stellaris_wake_mentions_waiting gauge",
    ...counts.mentions.map(({ agent, waiting }) =>
      sample("stellaris_wake_mentions_waiting", { agent }, waiting),
    ),
    "# HELP stellaris_wake_mentions_unanswered_total Mentions of a citizen no turn answered within a week, by citizen.",
    "# TYPE stellaris_wake_mentions_unanswered_total counter",
    ...counts.mentions.map(({ agent, unanswered }) =>
      sample("stellaris_wake_mentions_unanswered_total", { agent }, unanswered),
    ),
    "",
  ].join("\n");
}

/**
 * What the metrics port serves: `GET /metrics`, read from the counters alone, the turns in flight
 * they read included, and nothing else.
 * It asks for no token, so it carries counts and names, never a message or a secret. Given a
 * function, it answers 503 while that gives no counters, as while the server seeds them.
 */
export function createMetricsApp(counters: TurnCounters | (() => TurnCounters | null)): Hono {
  const current = typeof counters === "function" ? counters : () => counters;
  const app = new Hono();
  app.get("/metrics", (c) => {
    const counted = current();
    return counted === null
      ? c.text("the counters are not seeded yet", 503)
      : c.body(prometheusText(counted.read()), 200, { "content-type": PROMETHEUS_CONTENT_TYPE });
  });
  app.notFound((c) => c.text("not found", 404));
  return app;
}
