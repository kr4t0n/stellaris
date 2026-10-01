import type { Metrics, MetricsWindow } from "@stellaris/shared";
import { Link, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { EntityLink } from "../components/Entities.js";
import { ApiError } from "../lib/api.js";
import { ago, span } from "../lib/format.js";
import { useMetrics, useNow } from "../lib/session.js";
import { displayName } from "./Avatar.js";
import { Section } from "./Overview.js";
import { PaneHeader, PaneNote } from "./Pane.js";

const WINDOWS: ReadonlyArray<{ readonly window: MetricsWindow; readonly label: string }> = [
  { window: "24h", label: "24 hours" },
  { window: "7d", label: "7 days" },
  { window: "all", label: "All time" },
];

/** What woke a turn, in words. */
const TRIGGERS: Readonly<Record<string, string>> = {
  stage: "a stage to take",
  mention: "a mention",
  user_post: "your post",
  heartbeat: "a heartbeat",
  task_done: "a finished task",
  proposal_decided: "a decided proposal",
  ops_event: "a signal",
  onboarding: "joining",
  manual: "your wake",
};

const DAY = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

function share(part: number, whole: number): string {
  return whole === 0 ? "" : `${Math.round((part / whole) * 100)}%`;
}

/** One decimal, dropped when the number is whole: "5", "5.4". */
function decimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

/**
 * A count with its share of a whole beside it, muted, and none beside a zero. The share keeps its
 * width when empty, so the counts of a column line up.
 */
function Part({ part, whole }: { part: number; whole: number }) {
  return (
    <>
      {part}
      <span className="ml-1.5 inline-block w-9 text-right text-fg-muted">
        {part === 0 ? "" : share(part, whole)}
      </span>
    </>
  );
}

function Headline({ children }: { children: ReactNode }) {
  return <p className="text-sm text-fg-primary">{children}</p>;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-meta">{children}</p>;
}

/**
 * A small table: the labels are field labels, the cells names and counts. The layout is fixed and
 * every number column one width, so the columns of every table in the view line up from the right.
 */
function Table({
  label,
  columns,
  rows,
}: {
  label: string;
  columns: readonly string[];
  rows: ReadonlyArray<readonly ReactNode[]>;
}) {
  return rows.length === 0 ? null : (
    <table aria-label={label} className="mt-3 w-full table-fixed text-sm">
      <colgroup>
        <col />
        {columns.slice(1).map((column) => (
          <col key={column} className="w-24" />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map((column, index) => (
            <th
              key={column}
              scope="col"
              className={`text-caps pb-1 font-normal ${index === 0 ? "text-left" : "text-right"}`}
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className="border-t border-line/50">
            {row.map((cell, column) => (
              <td
                key={column}
                className={`py-1.5 ${column === 0 ? "pr-3 text-fg-primary" : "text-right text-fg-secondary tabular-nums"}`}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Citizen({ name }: { name: string }) {
  return name === "user" ? (
    <span>{displayName(name)}</span>
  ) : (
    <Link to="/citizen/$name" params={{ name }} className="hover:underline">
      {name}
    </Link>
  );
}

/** How many days a window spans, for decisions per day; the whole log counts its days with any. */
function daysIn(metrics: Metrics): number {
  if (metrics.window === "24h") return 1;
  if (metrics.window === "7d") return 7;
  return Math.max(1, metrics.decisions.byDay.length);
}

/**
 * How the society works, counted from its event log over a window: turns that did nothing, work
 * sent back, the talk a task took, how fast a mention wakes its citizen, the user's decisions, and
 * tasks blocked on a capability. The numbers are for judging the charters by.
 */
export function MetricsView() {
  const { window = "7d" } = useSearch({ from: "/metrics" });
  const metrics = useMetrics(window);
  const now = useNow(60_000);

  const switcher = (
    <nav aria-label="Window" className="flex shrink-0 gap-1">
      {WINDOWS.map((each) => (
        <Link
          key={each.window}
          to="/metrics"
          search={{ window: each.window }}
          aria-current={each.window === window ? "page" : undefined}
          className={`rounded-md px-2 py-1 text-xs transition-colors ${
            each.window === window
              ? "bg-surface-2 text-fg-primary"
              : "text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary"
          }`}
        >
          {each.label}
        </Link>
      ))}
    </nav>
  );

  if (metrics.data === undefined) {
    return (
      <>
        <PaneHeader title="Metrics" trailing={switcher} />
        <PaneNote>
          {metrics.error instanceof ApiError ? metrics.error.message : "Counting the event log…"}
        </PaneNote>
      </>
    );
  }
  const { idle, sentBack, messages, latency, decisions, blocked } = metrics.data;
  const days = daysIn(metrics.data);

  return (
    <>
      <PaneHeader
        title="Metrics"
        subtitle="How the society works, counted from its event log"
        trailing={switcher}
      />
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <Section title="Turns that did nothing">
          {idle.turns === 0 ? (
            <Note>No finished turns in this window.</Note>
          ) : (
            <Headline>
              {idle.idle} of {idle.turns} turns changed nothing on the board{" "}
              <span className="text-fg-muted">{share(idle.idle, idle.turns)}</span>
            </Headline>
          )}
          <Note>
            A turn that took no board action: no post, claim, handover, plan, proposal, decision, or
            knowledge. Reflections are left out, since they write memory.
            {idle.unknown > 0
              ? ` ${idle.unknown} ${idle.unknown === 1 ? "turn" : "turns"} kept no transcript and could not be counted.`
              : ""}
          </Note>
          <Table
            label="By what woke them"
            columns={["Woken by", "Turns", "Did nothing"]}
            rows={idle.byTrigger.map((row) => [
              TRIGGERS[row.trigger] ?? row.trigger,
              row.turns,
              <Part key="idle" part={row.idle} whole={row.turns} />,
            ])}
          />
          <Table
            label="By citizen"
            columns={["Citizen", "Turns", "Did nothing"]}
            rows={idle.byAgent.map((row) => [
              <span key="who">
                <Citizen name={row.agent} />
                {row.role === null ? null : <span className="text-meta"> · {row.role}</span>}
              </span>,
              row.turns,
              <Part key="idle" part={row.idle} whole={row.turns} />,
            ])}
          />
        </Section>

        <Section title="Work sent back">
          {sentBack.finished === 0 ? (
            <Note>No task finished in this window.</Note>
          ) : (
            <Headline>
              {sentBack.tasksSentBack} of {sentBack.finished} finished tasks were sent back,{" "}
              {sentBack.sendBacks} {sentBack.sendBacks === 1 ? "time" : "times"} in all
            </Headline>
          )}
          <Table
            label="Where work came back from"
            columns={["Came back from", "Times"]}
            rows={sentBack.byStage.map((row) => [`${row.project} · ${row.stage}`, row.count])}
          />
          <Table
            label="Who sent work back"
            columns={["Sent back by", "Times"]}
            rows={sentBack.bySender.map((row) => [
              <Citizen key="who" name={row.agent} />,
              row.count,
            ])}
          />
        </Section>

        <Section title="Messages per finished task">
          {messages.finished === 0 ? (
            <Note>No task finished in this window.</Note>
          ) : (
            <Headline>
              {decimal(messages.messages / messages.finished)} posts a task, across{" "}
              {messages.finished} finished {messages.finished === 1 ? "task" : "tasks"}
            </Headline>
          )}
          <Note>
            Posts in each finished task's thread, handovers included, the board's own left out.
          </Note>
          <Table
            label="By project"
            columns={["Project", "Tasks", "Posts a task"]}
            rows={messages.byProject.map((row) => [
              row.project,
              row.finished,
              decimal(row.messages / row.finished),
            ])}
          />
          <Table
            label="Most talked-over tasks"
            columns={["Task", "Posts"]}
            rows={messages.busiest.map((row) => [
              <EntityLink key="task" kind="task" id={row.taskId}>
                {row.title}
              </EntityLink>,
              row.messages,
            ])}
          />
        </Section>

        <Section title="Wake latency">
          {latency.medianMs === null || latency.slowestMs === null ? (
            <Note>No mention led to a turn in this window.</Note>
          ) : (
            <Headline>
              {span(latency.medianMs)} from a mention to its turn, at the median; the slowest took{" "}
              {span(latency.slowestMs)}
            </Headline>
          )}
          <Note>
            From a post that mentions a citizen to the start of its turn in the same conversation,
            debounce included.
            {latency.unanswered > 0
              ? ` ${latency.unanswered} ${latency.unanswered === 1 ? "mention has" : "mentions have"} no turn yet.`
              : ""}
          </Note>
          <Table
            label="By citizen"
            columns={["Citizen", "Mentions", "Median", "Slowest"]}
            rows={latency.byAgent.map((row) => [
              <Citizen key="who" name={row.agent} />,
              row.mentions,
              span(row.medianMs),
              span(row.slowestMs),
            ])}
          />
        </Section>

        <Section title="Your decisions">
          {decisions.total === 0 ? (
            <Note>You decided nothing in this window.</Note>
          ) : (
            <Headline>
              {decisions.total} {decisions.total === 1 ? "decision" : "decisions"}, about{" "}
              {decimal(decisions.total / days)} a day
            </Headline>
          )}
          <Note>
            Proposals you decided, questions to you that you answered, and stages you passed or sent
            back.
          </Note>
          <Table
            label="By day"
            columns={["Day", "Proposals", "Answers", "Stages"]}
            rows={decisions.byDay.map((row) => [
              DAY.format(new Date(`${row.day}T00:00:00Z`)),
              row.proposals,
              row.answers,
              row.stages,
            ])}
          />
        </Section>

        <Section title="Blocked on a capability">
          {blocked.length === 0 ? (
            <Note>No task waited for a capability no runner offers.</Note>
          ) : (
            <ul className="space-y-2">
              {blocked.map((row) => (
                <li key={row.taskId}>
                  <p className="text-sm text-fg-primary">
                    <EntityLink kind="task" id={row.taskId}>
                      {row.title ?? row.taskId}
                    </EntityLink>
                    <span className={row.holds ? "text-amber-300" : "text-fg-muted"}>
                      {row.holds ? " · blocked now" : " · cleared"}
                    </span>
                  </p>
                  <p className="text-meta">
                    {row.summary} · since {ago(row.firstAt, now)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
