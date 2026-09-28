import { useQuery } from "@tanstack/react-query";
import { api, type LiveTurnEvent } from "../api/client.js";
import { useLiveTurns } from "../hooks/useLiveTurns.js";
import { clockTime, describeToolInput } from "../lib/format.js";
import { Empty, Pill } from "./ui.js";

function Line({ item }: { item: LiveTurnEvent }) {
  const { event } = item;
  const time = <span className="shrink-0 text-board-muted">{clockTime(item.ts)}</span>;
  switch (event.type) {
    case "turn_started":
      return (
        <li className="flex gap-2 text-emerald-300">
          {time}
          <span>turn started{event.model === undefined ? "" : ` · ${event.model}`}</span>
        </li>
      );
    case "text":
      return (
        <li className="flex gap-2">
          {time}
          <span className="whitespace-pre-wrap text-board-text">{event.delta}</span>
        </li>
      );
    case "tool_call":
      return (
        <li className="flex gap-2">
          {time}
          <span className="text-board-accent">{event.name}</span>
          <span className="truncate text-board-muted">{describeToolInput(event.input)}</span>
        </li>
      );
    case "tool_result":
      return (
        <li className="flex gap-2">
          {time}
          <span className={event.ok ? "text-board-muted" : "text-rose-300"}>
            {event.name} {event.ok ? "ok" : "failed"}
          </span>
        </li>
      );
    case "approval_requested":
      return (
        <li className="flex gap-2 text-amber-300">
          {time}
          <span>approval requested: {event.kind}</span>
        </li>
      );
    case "turn_completed":
      return (
        <li className="flex gap-2 text-emerald-300">
          {time}
          <span>
            turn {event.exitReason}
            {event.costUsd > 0 ? ` · $${event.costUsd.toFixed(3)}` : ""}
            {event.status === null ? "" : ` · ${event.status.summary}`}
          </span>
        </li>
      );
    case "error":
      return (
        <li className="flex gap-2 text-rose-300">
          {time}
          <span>{event.message}</span>
        </li>
      );
    default:
      return null;
  }
}

/** What agents are doing right now, grouped by agent and project, newest group first. */
export function LivePanel({ project }: { project?: string | undefined }) {
  const events = useLiveTurns();
  const scheduler = useQuery({
    queryKey: ["scheduler"],
    queryFn: api.scheduler,
    refetchInterval: 5_000,
  });
  const groups = new Map<string, LiveTurnEvent[]>();
  for (const item of events) {
    if (project !== undefined && item.project !== project) continue;
    const key = `${item.agent}/${item.project}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const ordered = [...groups.entries()].toSorted(
    ([, a], [, b]) => (b[b.length - 1]?.seq ?? 0) - (a[a.length - 1]?.seq ?? 0),
  );
  const running = new Set(scheduler.data?.running ?? []);
  const pending = new Set(scheduler.data?.pending ?? []);

  return (
    <aside className="flex h-full flex-col gap-3 overflow-y-auto text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-board-text">Live turns</span>
        {scheduler.data?.paused ? (
          <Pill className="border-amber-800 text-amber-300">paused</Pill>
        ) : null}
        {[...running].map((pair) => (
          <Pill key={pair} className="border-emerald-800 text-emerald-300">
            {pair} running
          </Pill>
        ))}
        {[...pending].map((pair) => (
          <Pill key={pair} className="border-board-border text-board-muted">
            {pair} queued
          </Pill>
        ))}
      </div>
      {ordered.length === 0 ? <Empty>No agent activity yet.</Empty> : null}
      {ordered.map(([key, items]) => (
        <section key={key} className="rounded border border-board-border bg-board-panel p-2">
          <h3 className="mb-1 font-semibold text-board-text">{key}</h3>
          <ul className="space-y-0.5 font-mono">
            {items.slice(-40).map((item) => (
              <Line key={item.seq} item={item} />
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
