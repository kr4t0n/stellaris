function normalized(code: string): string {
  return code.toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
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
