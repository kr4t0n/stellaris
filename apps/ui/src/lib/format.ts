/** Short human time: "just now", "4m ago", "2h ago", or the date for older items. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** The tail of a ULID, enough to tell items apart on screen. */
export function shortId(id: string): string {
  return id.slice(-6).toLowerCase();
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const PREFERRED_KEYS = ["command", "file_path", "task_id", "channel", "query", "pattern"];

/** One line for a tool call, safe to render: a compact view of its input. */
export function describeToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") {
    return String(input);
  }
  if (typeof input === "object") {
    for (const key of PREFERRED_KEYS) {
      const value: unknown = Reflect.get(input, key);
      if (typeof value === "string") return value;
    }
    const text = JSON.stringify(input) ?? "";
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  }
  return "";
}

/** A readable rendering of an unknown value, for charter fields and provisioning summaries. */
export function plainValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(plainValue).join(", ");
  return JSON.stringify(value) ?? "";
}

/** A message for any thrown value, without falling back to "[object Object]". */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error) ?? "unknown error";
}

export function statusTone(status: string): string {
  switch (status) {
    case "done":
      return "text-emerald-300 border-emerald-800 bg-emerald-950/40";
    case "in_review":
      return "text-amber-300 border-amber-800 bg-amber-950/40";
    case "claimed":
      return "text-sky-300 border-sky-800 bg-sky-950/40";
    case "blocked":
      return "text-rose-300 border-rose-800 bg-rose-950/40";
    case "abandoned":
      return "text-board-muted border-board-border";
    default:
      return "text-board-text border-board-border";
  }
}
