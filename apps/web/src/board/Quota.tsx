import type { CliKind, CliQuota, Member, Runner } from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { CliIcon } from "../components/CliIcon.js";
import { ago } from "../lib/format.js";
import { useSession } from "../lib/session.js";
import { turnRunners } from "./citizen.js";
import {
  quotaLine,
  quotaRows,
  quotaStale,
  quotaWords,
  windowReading,
  type QuotaRow,
} from "./quota.js";

const FILL: Record<CliKind, string> = { claude: "bg-claude", codex: "bg-codex" };

/** Codex's credits, or Claude's extra usage in its currency's minor units, when the plan has them. */
function balance(quota: CliQuota): string | null {
  if (quota.credits !== null) {
    if (quota.credits.unlimited) {
      return "unlimited credits";
    }
    const amount = Number(quota.credits.balance);
    return quota.credits.balance === null || Number.isNaN(amount)
      ? null
      : `credits ${amount.toLocaleString("en")}`;
  }
  const extra = quota.extraUsage;
  if (extra === null || !extra.enabled || extra.usedCredits === null) {
    return null;
  }
  const money = (minor: number): string =>
    `${(minor / 100).toFixed(2)}${extra.currency === null ? "" : ` ${extra.currency}`}`;
  return `extra usage ${money(extra.usedCredits)}${extra.monthlyLimit === null ? "" : ` of ${money(extra.monthlyLimit)}`}`;
}

/**
 * Each window of a CLI's quota as a meter: how full, and when it starts afresh. A window used up,
 * or the one a limit names while it holds, is red; one near full is amber.
 */
function Windows({ cli, quota, now }: { cli: CliKind; quota: CliQuota; now: number }) {
  const binding = quotaWords(quota, now).level === "limited" ? quota.limitedBy : null;
  return (
    <ul className="mt-1 grid grid-cols-[auto_minmax(3rem,7rem)_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 pl-6">
      {quota.windows.map((window) => {
        const reading = windowReading(window, now);
        const fill =
          window.key === binding || (reading.percent ?? 0) >= 100
            ? "bg-red-400"
            : reading.high
              ? "bg-amber-400"
              : FILL[cli];
        return (
          <li
            key={window.key}
            className="col-span-full grid grid-cols-subgrid items-center text-xs"
          >
            <span className="text-fg-secondary">{reading.name}</span>
            {/* The bar draws the percent the next cell says in words. */}
            <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <span
                className={`block h-full rounded-full ${fill}`}
                style={{ width: `${reading.percent ?? 0}%` }}
              />
            </span>
            <span className="text-right text-fg-secondary tabular-nums">{reading.label}</span>
            <span
              className="truncate text-fg-muted"
              title={window.resetsAt === null ? undefined : window.resetsAt}
            >
              {reading.reset}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Why a row says what it says on the right: a read under way or failed, a limit, or its age. */
function rowState(
  row: QuotaRow,
  now: number,
  reading: boolean,
  failure: string | undefined,
): { words: string; detail: string; tone: string } {
  if (reading) {
    return { words: "reading…", detail: "asking the CLI on the runner", tone: "text-fg-muted" };
  }
  const quota = row.quota;
  if (failure !== undefined && quota === undefined) {
    return {
      words: failure.includes("upgrade it") ? "runner too old to read" : "read failed",
      detail: failure,
      tone: "text-amber-300",
    };
  }
  if (quota === undefined) {
    return row.connected
      ? { words: "unknown", detail: "nothing reported yet", tone: "text-fg-muted" }
      : {
          words: "unknown",
          detail: "nothing reported yet, and the runner is away",
          tone: "text-fg-muted",
        };
  }
  const { words, tone } = quotaWords(quota, now);
  const age = `as of ${ago(quota.observedAt, now)}`;
  const from = quota.source === "read" ? "read on request" : "reported by a turn";
  return {
    words: words === "" ? age : `${words} · ${age}`,
    detail: `${from} at ${quota.observedAt}${failure === undefined ? "" : `; the last read failed: ${failure}`}`,
    tone: quotaStale(quota, now) && words === "" ? "text-fg-muted" : tone,
  };
}

/**
 * Each runner's CLI logins and what they last reported of their plans: a meter per window, the
 * plan, any balance, and how old the numbers are. Runners reporting the same numbers share a row.
 * Numbers never reported, or older than a quarter of an hour, are read once when the view opens,
 * from connected runners; Read again reads them all. A read asks the CLI without a turn.
 */
export function PlanQuota({ runners, now }: { runners: readonly Runner[]; now: number }) {
  const { api } = useSession();
  const client = useQueryClient();
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map());
  const asked = useRef(new Set<string>());

  // One mutation for every read: its callbacks run for each, so each runner's CLI keeps its own
  // state, and its `mutate` stays the same function from render to render.
  const { mutate: read } = useMutation({
    mutationFn: ({ runner, cli }: { runner: string; cli: CliKind }) => api.readQuota(runner, cli),
    onMutate: ({ runner, cli }) => {
      setReading((previous) => new Set(previous).add(`${runner}/${cli}`));
    },
    onSuccess: (_quota, { runner, cli }) => {
      setFailed((previous) => {
        const next = new Map(previous);
        next.delete(`${runner}/${cli}`);
        return next;
      });
    },
    onError: (error, { runner, cli }) => {
      setFailed((previous) => new Map(previous).set(`${runner}/${cli}`, error.message));
    },
    onSettled: (_quota, _error, { runner, cli }) => {
      setReading((previous) => {
        const next = new Set(previous);
        next.delete(`${runner}/${cli}`);
        return next;
      });
      void client.invalidateQueries({ queryKey: ["runners"] });
    },
  });

  // Each runner's CLIs are asked once per visit, when the numbers are missing or old.
  useEffect(() => {
    for (const runner of runners) {
      if (runner.status !== "connected") {
        continue;
      }
      for (const cli of runner.clis) {
        const key = `${runner.name}/${cli}`;
        if (asked.current.has(key) || !quotaStale(runner.quotas?.[cli], Date.now())) {
          continue;
        }
        asked.current.add(key);
        read({ runner: runner.name, cli });
      }
    }
  }, [runners, read]);

  const connected = runners.filter((runner) => runner.status === "connected");
  const rows = quotaRows(runners);
  if (rows.length === 0) {
    return null;
  }
  return (
    <section aria-label="Plan quota" className="mt-3 border-t border-line pt-3">
      <div className="flex items-center gap-2 px-2">
        <h2 className="flex-1 text-section text-fg-primary">Plan quota</h2>
        <Button
          disabled={connected.length === 0 || reading.size > 0}
          onClick={() => {
            for (const runner of connected) {
              for (const cli of runner.clis) {
                read({ runner: runner.name, cli });
              }
            }
          }}
        >
          {reading.size > 0 ? "Reading…" : "Read again"}
        </Button>
      </div>
      <p className="px-2 pt-0.5 text-meta">
        What each runner's CLI logins last reported of their plans, from a turn or a read.
      </p>
      <ul aria-label="Quota by runner" className="mt-1.5 space-y-1">
        {rows.map((row) => {
          const first = row.runners[0] ?? "";
          const key = `${first}/${row.cli}`;
          const state = rowState(row, now, reading.has(key), failed.get(key));
          const plan = row.quota?.plan;
          const money = row.quota === undefined ? null : balance(row.quota);
          return (
            <li key={`${row.cli}/${first}`} className="rounded-lg px-2 py-1.5">
              <div className="flex items-center gap-2 text-sm">
                <CliIcon cli={row.cli} size={13} />
                <span className="text-fg-primary">{row.runners.join(" · ")}</span>
                <span className="text-xs text-fg-muted">
                  {row.cli}
                  {plan === null || plan === undefined ? "" : ` · ${plan}`}
                  {money === null ? "" : ` · ${money}`}
                </span>
                <span className={`ml-auto text-right text-xs ${state.tone}`} title={state.detail}>
                  {state.words}
                </span>
              </div>
              {row.quota === undefined || row.quota.windows.length === 0 ? null : (
                <Windows cli={row.cli} quota={row.quota} now={now} />
              )}
              {row.runners.length > 1 ? (
                <p className="pt-0.5 pl-6 text-meta">
                  Same numbers on {row.runners.join(" and ")}, so most likely one login.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A citizen's CLI quota on each runner its turns run on, in one line under its header. */
export function CitizenQuota({
  member,
  runners,
  placed,
  now,
}: {
  member: Member;
  runners: readonly Runner[];
  placed: ReadonlyMap<string, string>;
  now: number;
}) {
  const cli = member.cli;
  const names = turnRunners(member, placed);
  if (cli === null || names.length === 0) {
    return null;
  }
  return (
    <p className="border-b border-line px-4 py-1.5 text-meta">
      <Link to="/runners" className="hover:text-fg-primary">
        {cli} quota
      </Link>
      {names.map((name) => {
        const quota = runners.find((runner) => runner.name === name)?.quotas?.[cli];
        const tone = quota === undefined ? "" : quotaWords(quota, now).tone;
        return (
          <span key={name}>
            {" · "}
            {name}{" "}
            <span
              className={tone}
              title={quota === undefined ? "nothing reported yet" : `as of ${quota.observedAt}`}
            >
              {quotaLine(quota, now)}
            </span>
          </span>
        );
      })}
    </p>
  );
}

/** A mark beside a citizen's CLI when its quota is near or at its limit on a runner its turns use. */
export function QuotaMark({
  member,
  runners,
  placed,
  now,
}: {
  member: Member;
  runners: readonly Runner[];
  placed: ReadonlyMap<string, string>;
  now: number;
}) {
  const cli = member.cli;
  if (cli === null) {
    return null;
  }
  const marks = turnRunners(member, placed).flatMap((name) => {
    const quota = runners.find((runner) => runner.name === name)?.quotas?.[cli];
    if (quota === undefined) {
      return [];
    }
    const { level, words } = quotaWords(quota, now);
    return level === "limited" || level === "warning" ? [{ name, level, words }] : [];
  });
  if (marks.length === 0) {
    return null;
  }
  const limited = marks.some((mark) => mark.level === "limited");
  const said = marks.map((mark) => `${cli} ${mark.words} on ${mark.name}`).join("; ");
  return (
    <span
      title={said}
      className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ${limited ? "bg-red-400" : "bg-amber-400"}`}
    >
      <span className="sr-only">, {said}</span>
    </span>
  );
}
