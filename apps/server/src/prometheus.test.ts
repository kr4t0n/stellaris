import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board, FAILURE_REASONS } from "@stellaris/board-core";
import type { TranscriptEntry, TurnRecord } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMetricsApp, PROMETHEUS_CONTENT_TYPE, prometheusText } from "./prometheus.js";
import { addWorkRoles } from "./testing/scripted-backend.js";
import { serveBoard } from "./serve.js";

const USER = { name: "user", role: "user" } as const;

interface Sample {
  readonly labels: Record<string, string>;
  readonly value: number;
}

interface Family {
  help?: string;
  type?: string;
  readonly samples: Sample[];
}

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const TYPES = new Set(["counter", "gauge", "histogram", "summary", "untyped"]);

/** Throws `message` unless `condition` holds: what the reader below refuses. */
function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** Orders by UTF-16 code units, whatever the host's locale. */
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A label set's values, read as Prometheus's text format quotes them. */
function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let at = 0;
  while (at < text.length) {
    const equals = text.indexOf("=", at);
    const name = text.slice(at, equals);
    check(equals > at && LABEL_NAME.test(name), `a label name at ${at} of ${text}`);
    check(!(name in labels), `label ${name} twice`);
    check(text[equals + 1] === '"', `${name}'s value is quoted`);
    let value = "";
    let cursor = equals + 2;
    for (let char = text[cursor]; char !== '"'; char = text[cursor]) {
      check(char !== undefined && char !== "\n", `${name}'s value ends with a quote`);
      if (char === "\\") {
        const escaped = text[cursor + 1];
        const meant = { n: "\n", "\\": "\\", '"': '"' }[escaped ?? ""];
        check(meant !== undefined, `escape \\${escaped ?? ""} in ${name}'s value`);
        value += meant;
        cursor += 2;
      } else {
        value += char;
        cursor += 1;
      }
    }
    labels[name] = value;
    at = cursor + 1;
    if (at < text.length) {
      check(text[at] === ",", `a comma after ${name}'s value`);
      at += 1;
    }
  }
  return labels;
}

/**
 * Prometheus's text format, version 0.0.4, read strictly: help and type before a metric's samples,
 * each at most once, one group per metric, valid names, quoted and escaped label values, a float
 * value, no series twice, and a newline at the end.
 */
function parseExposition(text: string): Map<string, Family> {
  check(text.endsWith("\n"), "the text ends with a newline");
  const families = new Map<string, Family>();
  const family = (name: string) => {
    const found = families.get(name) ?? { samples: [] };
    families.set(name, found);
    return found;
  };
  const series = new Set<string>();
  let current: string | null = null;
  for (const line of text.slice(0, -1).split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const meta = /^# (HELP|TYPE) (\S+) (.*)$/.exec(line);
    if (meta !== null) {
      const [, kind, name = "", rest = ""] = meta;
      check(METRIC_NAME.test(name), `a metric name: ${name}`);
      const described = family(name);
      check(described.samples.length === 0, `${kind} after ${name}'s samples`);
      if (kind === "HELP") {
        check(described.help === undefined, `${name}'s HELP twice`);
        described.help = rest.replaceAll("\\n", "\n").replaceAll("\\\\", "\\");
      } else {
        check(described.type === undefined, `${name}'s TYPE twice`);
        check(TYPES.has(rest), `a type: ${rest}`);
        described.type = rest;
      }
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    const parsed = /^([^\s{]+)(?:\{(.*)\})? (\S+)(?: (-?\d+))?$/.exec(line);
    check(parsed !== null, `a sample: ${line}`);
    const [, name = "", labelText = "", value = ""] = parsed;
    check(METRIC_NAME.test(name), `a metric name: ${name}`);
    check(current === name || !families.get(name)?.samples.length, `${name} in one group`);
    current = name;
    check(
      /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|NaN|[+-]Inf)$/.test(value),
      `a value: ${value}`,
    );
    const labels = parseLabels(labelText);
    const key = JSON.stringify([
      name,
      Object.entries(labels).toSorted(([a], [b]) => byCodeUnits(a, b)),
    ]);
    check(!series.has(key), `${key} twice`);
    series.add(key);
    family(name).samples.push({ labels, value: Number(value) });
  }
  return families;
}

describe("the text format's reader in these tests", () => {
  it("refuses what Prometheus refuses", () => {
    const good = '# HELP x_total X.\n# TYPE x_total counter\nx_total{a="1"} 2\n';
    expect(parseExposition(good).get("x_total")?.samples).toEqual([
      { labels: { a: "1" }, value: 2 },
    ]);
    const refusals: [string, RegExp][] = [
      [good.slice(0, -1), /ends with a newline/],
      ['x_total{a="1"} 2\n# TYPE x_total counter\n', /TYPE after x_total's samples/],
      ["# TYPE x_total counter\n# TYPE x_total counter\n", /TYPE twice/],
      ["# TYPE x_total total\n", /a type: total/],
      ['x_total{a="1"} 2\nx_total{a="1"} 3\n', /twice/],
      ['x_total{a="1"} 2\ny 1\nx_total{a="2"} 3\n', /x_total in one group/],
      ['x_total{a="say "hi""} 2\n', /a comma after a's value/],
      ['x_total{a="\\q"} 2\n', /escape \\q/],
      ['x_total{a="1",a="2"} 2\n', /label a twice/],
      ['x_total{1a="1"} 2\n', /a label name/],
      ["x-total 2\n", /a metric name: x-total/],
      ["x_total two\n", /a value: two/],
    ];
    for (const [bad, message] of refusals) {
      expect(() => parseExposition(bad)).toThrow(message);
    }
  });
});

describe("Prometheus's turn counters", () => {
  let dir: string;
  let board: Board;
  let clock: Date;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-prom-"));
    clock = new Date("2026-10-13T09:00:00.000Z");
    board = (await Board.init(dir, { name: "prom" }, { now: () => clock })).board;
    await board.addProject(USER, { slug: "demo", channels: ["general"] });
    await addWorkRoles(board);
    await board.addAgent(USER, {
      name: "eng-1",
      role: "engineer",
      cli: "claude",
      memberships: ["demo"],
    });
    await board.addAgent(USER, {
      name: "eng-2",
      role: "engineer",
      cli: "codex",
      memberships: ["demo"],
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function turn(
    agent: "eng-1" | "eng-2",
    end: Partial<TurnRecord>,
    transcript: readonly TranscriptEntry[] = [],
  ): Promise<void> {
    clock = new Date(clock.getTime() + 60_000);
    const started = await board.beginTurn({
      agent,
      project: "demo",
      runner: "server",
      cli: agent === "eng-1" ? "claude" : "codex",
      session: null,
      trigger: { kind: "stage", fromUser: false, reason: "" },
      startedAt: clock.toISOString(),
      endedAt: null,
      exitReason: null,
      status: null,
      error: null,
      usage: null,
      costUsd: 0,
      toolCalls: 0,
      model: agent === "eng-1" ? "claude-opus-5-5" : "gpt-6",
    });
    await board.finishTurn(
      { ...started, endedAt: clock.toISOString(), exitReason: "completed", ...end },
      transcript,
    );
  }

  /** A tool's result as a turn's transcript keeps it. */
  function result(name: string): TranscriptEntry {
    return { ts: clock.toISOString(), event: { type: "tool_result", name, ok: true } };
  }

  /** Sends a two-stage task back from its second stage, as the user. */
  async function sendBack(): Promise<void> {
    const task = await board.createTask(USER, {
      project: "demo",
      title: "report",
      stages: [{ name: "draft" }, { name: "check" }],
    });
    await board.advanceTask(USER, { task_id: task.id });
    await board.updateTask(USER, { task_id: task.id, stage: "s1" });
  }

  /** Serves the counters as the server does, on a port of their own, and scrapes it. */
  async function serve(): Promise<{
    scrape: (route?: string) => Promise<Response>;
    close: () => void;
  }> {
    const app = createMetricsApp(await board.countTurns());
    return new Promise((resolve) => {
      const server = serveBoard({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
        resolve({
          scrape: (route = "/metrics") => fetch(`http://127.0.0.1:${info.port}${route}`),
          close: () => server.close(),
        }),
      );
    });
  }

  it("serves every counter in Prometheus's text format, with their help, type, and labels", async () => {
    await turn(
      "eng-1",
      {
        usage: {
          inputTokens: 12,
          outputTokens: 340,
          cacheReadTokens: 56_000,
          cacheWriteTokens: 780,
        },
      },
      [result("mcp__board__get_task")],
    );
    await turn("eng-2", {
      exitReason: "error",
      error: "Prompt is too long",
      usage: { inputTokens: 900, outputTokens: 80, cacheReadTokens: 7_000, cacheWriteTokens: 0 },
    });
    await turn("eng-2", {}, [result("mcp__board__post_message")]);
    await sendBack();
    const metrics = await serve();
    try {
      const answer = await metrics.scrape();
      expect(answer.status).toBe(200);
      expect(answer.headers.get("content-type")).toBe(PROMETHEUS_CONTENT_TYPE);
      const families = parseExposition(await answer.text());
      expect([...families.keys()]).toEqual([
        "stellaris_turn_tokens_total",
        "stellaris_turns_total",
        "stellaris_turns_idle_total",
        "stellaris_turns_failed_total",
        "stellaris_task_sendbacks_total",
      ]);
      for (const family of families.values()) {
        expect(family.type).toBe("counter");
      }
      const tokens = families.get("stellaris_turn_tokens_total");
      const turns = families.get("stellaris_turns_total");
      expect(tokens?.type).toBe("counter");
      expect(turns?.type).toBe("counter");
      expect(tokens?.help).toMatch(/^Tokens finished turns used/);
      expect(turns?.help).toMatch(/^Finished turns/);
      expect(tokens?.samples).toContainEqual({
        labels: { agent: "eng-1", cli: "claude", model: "claude-opus-5-5", kind: "cache_read" },
        value: 56_000,
      });
      expect(tokens?.samples).toContainEqual({
        labels: { agent: "eng-2", cli: "codex", model: "gpt-6", kind: "input" },
        value: 900,
      });
      expect(tokens?.samples).toHaveLength(8);
      expect(turns?.samples).toEqual([
        { labels: { agent: "eng-1", outcome: "completed", trigger: "stage" }, value: 1 },
        { labels: { agent: "eng-2", outcome: "completed", trigger: "stage" }, value: 1 },
        { labels: { agent: "eng-2", outcome: "failed", trigger: "stage" }, value: 1 },
      ]);
      expect(families.get("stellaris_turns_idle_total")?.samples).toEqual([
        { labels: { agent: "eng-1", trigger: "stage" }, value: 1 },
      ]);
      const failed = families.get("stellaris_turns_failed_total");
      expect(failed?.samples).toEqual([
        { labels: { agent: "eng-2", cli: "codex", reason: "context" }, value: 1 },
      ]);
      // The help names every reason, so a dashboard can list them.
      for (const reason of FAILURE_REASONS) {
        expect(failed?.help).toContain(reason);
      }
      expect(families.get("stellaris_task_sendbacks_total")?.samples).toEqual([
        { labels: { project: "demo", by: "user" }, value: 1 },
      ]);
      // The port serves the counters and nothing else.
      for (const route of ["/", "/health", "/api/tokens", "/metrics/x"]) {
        expect((await metrics.scrape(route)).status).toBe(404);
      }
    } finally {
      metrics.close();
    }
  });

  it("answers a scrape from the counters, never the event log, and moves with each turn's end", async () => {
    await turn("eng-1", {
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    });
    const metrics = await serve();
    try {
      const first = await (await metrics.scrape()).text();
      // A scrape that read the log would find it gone and count nothing.
      await rm(path.join(dir, "events", "log.jsonl"));
      expect(await (await metrics.scrape()).text()).toBe(first);
      await turn("eng-1", {
        usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
      const families = parseExposition(await (await metrics.scrape()).text());
      expect(families.get("stellaris_turns_total")?.samples).toEqual([
        { labels: { agent: "eng-1", outcome: "completed", trigger: "stage" }, value: 2 },
      ]);
      expect(families.get("stellaris_turn_tokens_total")?.samples).toContainEqual({
        labels: { agent: "eng-1", cli: "claude", model: "claude-opus-5-5", kind: "input" },
        value: 11,
      });
    } finally {
      metrics.close();
    }
  });

  it("escapes what a label's value holds, and serves every counter before any turn", () => {
    const awkward = 'a "quoted" model\\with\na newline';
    const text = prometheusText({
      tokens: [{ agent: "eng-1", cli: "claude", model: awkward, kind: "input", tokens: 5 }],
      turns: [{ agent: "eng-1", outcome: "completed", trigger: awkward, turns: 1 }],
      idle: [{ agent: "eng-1", trigger: awkward, turns: 1 }],
      failed: [{ agent: "eng-1", cli: "claude", reason: "other", turns: 1 }],
      sendBacks: [{ project: "demo", by: awkward, sendBacks: 1 }],
    });
    const families = parseExposition(text);
    expect(families.get("stellaris_turn_tokens_total")?.samples[0]?.labels["model"]).toBe(awkward);
    expect(families.get("stellaris_turns_total")?.samples[0]?.labels["trigger"]).toBe(awkward);
    expect(families.get("stellaris_turns_idle_total")?.samples[0]?.labels["trigger"]).toBe(awkward);
    expect(families.get("stellaris_task_sendbacks_total")?.samples[0]?.labels["by"]).toBe(awkward);

    const empty = parseExposition(
      prometheusText({ tokens: [], turns: [], idle: [], failed: [], sendBacks: [] }),
    );
    expect([...empty.entries()]).toEqual(
      [
        "stellaris_turn_tokens_total",
        "stellaris_turns_total",
        "stellaris_turns_idle_total",
        "stellaris_turns_failed_total",
        "stellaris_task_sendbacks_total",
      ].map((name) => [name, expect.objectContaining({ type: "counter", samples: [] })]),
    );
  });
});
