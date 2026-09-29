import type { TurnExitReason } from "@stellaris/shared";
import { useState, type ReactNode } from "react";
import { Markdown } from "../components/Markdown.js";
import { ago } from "../lib/format.js";
import { elapsed, toolLabel, type LiveTurn, type Step } from "../lib/live.js";

const OUTCOME: Record<TurnExitReason, string> = {
  completed: "completed",
  timeout: "timed out",
  error: "failed",
  interrupted: "was interrupted",
  blocked: "was blocked",
};

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function Block({ label, tone, children }: { label: string; tone: string; children: ReactNode }) {
  return (
    <div>
      <p className="px-0.5 pb-0.5 text-[10px] tracking-wider text-fg-muted uppercase">{label}</p>
      <pre
        className={`max-h-72 overflow-auto rounded-md bg-surface-0/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words ${tone}`}
      >
        {children}
      </pre>
    </div>
  );
}

/**
 * One step: prose as markdown, an error in red, or a tool call as one line that opens to its input
 * and what it returned. `open` sets every call open or shut at once; a click still toggles one.
 */
export function StepItem({ step, open }: { step: Step; open: boolean }) {
  if (step.kind === "say") {
    return (
      <li className="py-1.5 text-sm" title={time(step.at)}>
        <Markdown text={step.text} />
      </li>
    );
  }
  if (step.kind === "error") {
    return (
      <li className="py-1 font-mono text-xs break-words text-red-400" title={time(step.at)}>
        {step.message}
      </li>
    );
  }
  const status =
    step.ok === null ? (
      <span aria-label="running" className="size-1.5 animate-pulse rounded-full bg-amber-300" />
    ) : step.ok ? (
      <span aria-label="succeeded" className="text-[11px] text-emerald-400">
        ✓
      </span>
    ) : (
      <span aria-label="failed" className="text-[11px] text-red-400">
        ✕
      </span>
    );
  return (
    <li>
      <details open={open} className="group rounded-md open:bg-surface-2/30">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-surface-2/40">
          <span className="grid w-3 shrink-0 place-items-center">{status}</span>
          <span className="shrink-0 font-mono text-fg-tertiary">{toolLabel(step.name)}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-fg-secondary">
            {step.summary}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-fg-muted">{time(step.at)}</span>
        </summary>
        <div className="space-y-1.5 px-1.5 pb-1.5">
          <Block label="Input" tone="text-fg-secondary">
            {step.detail}
          </Block>
          {step.output === null ? null : (
            <Block
              label={step.ok === false ? "Returned an error" : "Returned"}
              tone={step.ok === false ? "text-red-300" : "text-fg-tertiary"}
            >
              {step.output}
            </Block>
          )}
        </div>
      </details>
    </li>
  );
}

/** A turn's steps, with a switch that opens or shuts every tool call at once. */
export function TranscriptSteps({ steps }: { steps: readonly Step[] }) {
  const [open, setOpen] = useState(false);
  const calls = steps.filter((step) => step.kind === "tool").length;
  if (steps.length === 0) {
    return <p className="mt-2 text-meta">No steps yet.</p>;
  }
  return (
    <>
      {calls === 0 ? null : (
        <p className="mt-2 flex items-center gap-2 text-meta">
          {calls === 1 ? "1 tool call" : `${calls} tool calls`}
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="rounded-md px-1.5 py-0.5 text-fg-tertiary transition-colors hover:bg-surface-2/60 hover:text-fg-primary"
          >
            {open ? "Collapse all" : "Expand all"}
          </button>
        </p>
      )}
      <ol className="mt-1 space-y-0.5">
        {steps.map((step) => (
          <StepItem key={step.seq} step={step} open={open} />
        ))}
      </ol>
    </>
  );
}

/** How the turn stands at the end of its transcript. */
export function TurnFooter({
  turn,
  running,
  now,
}: {
  turn: LiveTurn;
  running: boolean;
  now: number;
}) {
  if (turn.end !== null) {
    const cost = turn.end.costUsd > 0 ? ` · $${turn.end.costUsd.toFixed(2)}` : "";
    return (
      <section className="mt-3 rounded-xl bg-surface-2/40 px-3.5 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
        <p className="text-caps">
          The turn {OUTCOME[turn.end.exitReason]} {ago(turn.end.at, now)}
          {cost}
          {turn.fromStart ? ` · ${elapsed(turn.startedAt, Date.parse(turn.end.at))}` : ""}
        </p>
        {turn.end.summary === null ? null : (
          <p className="mt-1 text-sm text-fg-secondary">{turn.end.summary}</p>
        )}
      </section>
    );
  }
  if (!running) {
    return <p className="mt-3 text-meta">The turn ended without a report.</p>;
  }
  return (
    <p className="mt-3 flex items-center gap-2 text-meta" aria-live="polite">
      <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
      Working · last step {ago(turn.lastAt, now)}
    </p>
  );
}
