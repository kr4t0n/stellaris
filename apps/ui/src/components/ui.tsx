import { Fragment, type ReactNode } from "react";
import { errorMessage, plainValue } from "../lib/format.js";

/** Key-value rows for a charter or a provisioning summary. */
export function CharterRows({ charter }: { charter: Record<string, unknown> }) {
  return (
    <dl className="my-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {Object.entries(charter).map(([key, value]) => (
        <Fragment key={key}>
          <dt className="text-board-muted">{key}</dt>
          <dd className="break-words">{plainValue(value)}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function Panel({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-board-border bg-board-panel">
      <header className="flex items-center justify-between border-b border-board-border px-4 py-2">
        <h2 className="text-sm font-semibold text-board-text">{title}</h2>
        {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  tone = "default",
  disabled = false,
  type = "button",
}: {
  children: ReactNode;
  onClick?: (() => void) | undefined;
  tone?: "default" | "primary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const tones = {
    default: "border-board-border bg-board-bg text-board-text hover:border-board-accent",
    primary: "border-board-accent bg-board-accent/20 text-board-accent hover:bg-board-accent/30",
    danger: "border-rose-800 bg-rose-950/40 text-rose-300 hover:bg-rose-950/70",
  } as const;
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`rounded border px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function Pill({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`}
    >
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-board-muted">{children}</p>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const message = errorMessage(error);
  return (
    <p className="rounded border border-rose-800 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
      {message}
    </p>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-board-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "rounded border border-board-border bg-board-bg px-2 py-1 text-sm text-board-text outline-none focus:border-board-accent";
