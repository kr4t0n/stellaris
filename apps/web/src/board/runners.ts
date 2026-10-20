import type { GitIdentityPart } from "@stellaris/shared";

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
