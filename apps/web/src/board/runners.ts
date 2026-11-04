import {
  runnerLimitHold,
  type CliKind,
  type GitIdentityPart,
  type Runner,
} from "@stellaris/shared";
import { ago } from "../lib/format.js";
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

/** The CLIs on a runner whose limits hold their turns now, each with when the hold lifts. */
export function heldClis(
  runner: Runner,
  now: number,
): { readonly cli: CliKind; readonly until: string }[] {
  return runner.clis.flatMap((cli) => {
    const hold = runnerLimitHold(runner, cli, new Date(now));
    return hold === null ? [] : [{ cli, until: hold.until }];
  });
}

/**
 * What a runner's row says of it: away or connected, what of it the user paused, and which of its
 * CLIs their limits hold until they lift.
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
    (hold) => `${hold.cli} held by its limit for ${until(Date.parse(hold.until) - now)}`,
  );
  const heldLabel = holds.length === 0 ? [] : [`${holds.map((hold) => hold.cli).join(", ")} held`];
  if (runner.status !== "connected") {
    const away = `away${runner.lastSeen === undefined ? "" : `, last seen ${ago(runner.lastSeen, now)}`}`;
    return {
      label: runner.paused === undefined ? "away" : "away · paused",
      detail: [away, ...paused, ...held].join("; "),
      tone: "text-amber-300",
    };
  }
  if (runner.paused === undefined && pausedClis.length === 0 && holds.length === 0) {
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
    ].join(" · "),
    detail: ["connected", ...paused, ...held].join("; "),
    tone: "text-amber-300",
  };
}
