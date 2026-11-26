import {
  poolHolds,
  runnerLimitHold,
  runnerPause,
  runnerSyncing,
  syncedFiles,
  type CliKind,
  type GitIdentityPart,
  type Runner,
} from "@stellaris/shared";
import { ago, span } from "../lib/format.js";
import { until } from "./quota.js";

function normalized(code: string): string {
  return code.toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

/**
 * Whether a runner last registered with another release than the server runs. Unknown on either
 * side is not a difference: a runner that has not registered since versions were kept, or a server
 * that does not say.
 */
export function offVersion(runner: { version?: string | undefined }, server?: string): boolean {
  return server !== undefined && runner.version !== undefined && runner.version !== server;
}

/**
 * What a runner's account lacked of the git identity citizens' own commits carry when it last
 * registered, as the mark shows it, or null for nothing. A runner that has not said, one from
 * before runners checked, is not marked, as `offVersion` does not mark an unknown version.
 */
export function identityGap(runner: {
  gitIdentityMissing?: readonly GitIdentityPart[] | undefined;
}): { label: string; detail: string } | null {
  const missing = runner.gitIdentityMissing ?? [];
  if (missing.length === 0) {
    return null;
  }
  const keys = missing.map((part) => `user.${part}`);
  const effect = missing.includes("name")
    ? "git refuses the commits citizens make themselves on it"
    : "the commits citizens make themselves on it carry an empty address or one git made up";
  return {
    label: missing.length === 1 ? `no git ${keys.join("")}` : "no git identity",
    detail: `Its account has no git ${keys.join(" or ")}, so ${effect}.`,
  };
}

/** A code as the user may type it: case and separators do not matter, as on the board. */
export function sameCode(a: string, b: string): boolean {
  return normalized(a) === normalized(b);
}

/**
 * A runner name from a machine's hostname: its first label, lowercased, with anything a name may
 * not hold turned to hyphens, and a number after it when the society has that name already.
 */
export function suggestRunnerName(hostname: string, taken: readonly string[]): string {
  const base =
    (hostname.split(".")[0] ?? "")
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/g, "-")
      .replaceAll(/-+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "runner";
  if (!taken.includes(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!taken.includes(candidate)) {
      return candidate;
    }
  }
}

/**
 * The CLIs on a runner whose limits hold their turns now, the whole CLI's or one pool's of its
 * models (`pool`, with the CLI's name for it), each with when the hold lifts and whether the user's
 * pause holds it too, which leaves the limit's hold changing nothing.
 */
export function heldClis(
  runner: Runner,
  now: number,
): {
  readonly cli: CliKind;
  readonly pool: string | null;
  readonly label: string | null;
  readonly until: string;
  readonly paused: boolean;
}[] {
  return runner.clis.flatMap((cli) => {
    const paused = runnerPause(runner, cli) !== undefined;
    const hold = runnerLimitHold(runner, cli, new Date(now));
    const quota = runner.quotas?.[cli];
    return [
      ...(hold === null ? [] : [{ cli, pool: null, label: null, until: hold.until, paused }]),
      ...(quota === undefined ? [] : poolHolds(quota, new Date(now))).map((held) => ({
        cli,
        pool: held.pool,
        label: held.label,
        until: held.until,
        paused,
      })),
    ];
  });
}

/**
 * The line under a syncing runner's row: how far its board sync has come, as "Syncing board 6,200 /
 * 15,152 files", the share done for its bar while the total is known, and after a failed try,
 * which try it was, when the next is, and why it failed. Null while no sync holds the runner.
 */
export function syncLine(
  runner: Runner,
  now: number,
): { label: string; fraction: number | null; error: string | null } | null {
  const sync = runnerSyncing(runner);
  if (sync === undefined) {
    return null;
  }
  const count = syncedFiles(sync);
  const label = count === null ? "Syncing board" : `Syncing board ${count}`;
  const fraction =
    count === null || sync.totalFiles === null || sync.totalFiles === 0
      ? null
      : Math.min(1, sync.files / sync.totalFiles);
  if (sync.error === undefined) {
    return { label, fraction, error: null };
  }
  const next =
    sync.nextTryAt === undefined || Date.parse(sync.nextTryAt) <= now
      ? "trying again"
      : `next in ${span(Date.parse(sync.nextTryAt) - now)}`;
  return { label: `${label} · try ${sync.attempt} failed, ${next}`, fraction, error: sync.error };
}

/**
 * What a runner's row says of it: away or connected, what of it the user paused, which of its CLIs
 * their limits hold until they lift, and whether it syncs its board copy. A hold under the user's
 * pause is named in the detail alone, since the pause holds those turns already, and the label
 * stays as short as before.
 */
export function runnerState(
  runner: Runner,
  now: number,
): { label: string; detail: string; tone: string } {
  const pausedClis = runner.clis.filter((cli) => runner.pausedClis?.[cli] !== undefined);
  const paused =
    runner.paused !== undefined
      ? [`paused ${ago(runner.paused.at, now)}`]
      : runner.clis.flatMap((cli) => {
          const pause = runner.pausedClis?.[cli];
          return pause === undefined ? [] : [`${cli} paused ${ago(pause.at, now)}`];
        });
  const holds = heldClis(runner, now);
  const held = holds.map(
    (hold) =>
      `${hold.pool === null ? hold.cli : `${hold.cli}'s ${hold.label ?? hold.pool}`} held by ${
        hold.pool === null ? "its" : "their"
      } limit for ${until(Date.parse(hold.until) - now)}`,
  );
  // A CLI held whole or for one pool is named once in the label; the detail names the pool.
  const unpaused = [...new Set(holds.filter((hold) => !hold.paused).map((hold) => hold.cli))];
  const heldLabel = unpaused.length === 0 ? [] : [`${unpaused.join(", ")} held`];
  if (runner.status !== "connected") {
    const away = `away${runner.lastSeen === undefined ? "" : `, last seen ${ago(runner.lastSeen, now)}`}`;
    return {
      label: runner.paused === undefined ? "away" : "away · paused",
      detail: [away, ...paused, ...held].join("; "),
      tone: "text-amber-300",
    };
  }
  const sync = runnerSyncing(runner);
  if (
    runner.paused === undefined &&
    pausedClis.length === 0 &&
    holds.length === 0 &&
    sync === undefined
  ) {
    return { label: "connected", detail: "connected", tone: "text-fg-muted" };
  }
  return {
    label: [
      ...(runner.paused !== undefined
        ? ["paused"]
        : pausedClis.length === 0
          ? []
          : [`${pausedClis.join(", ")} paused`]),
      ...heldLabel,
      ...(sync === undefined ? [] : ["syncing"]),
    ].join(" · "),
    detail: [
      "connected",
      ...paused,
      ...held,
      ...(sync === undefined ? [] : [`syncing its board copy since ${ago(sync.startedAt, now)}`]),
    ].join("; "),
    // A sync alone is the runner's own work on its way, not a hold to look into until a try fails.
    tone:
      runner.paused === undefined &&
      pausedClis.length === 0 &&
      unpaused.length === 0 &&
      sync?.error === undefined
        ? "text-fg-secondary"
        : "text-amber-300",
  };
}
