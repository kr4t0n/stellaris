import {
  poolHolds,
  runnerLimitHold,
  runnerSyncing,
  syncedFiles,
  type Runner,
} from "@stellaris/shared";

/** A connected runner's board sync while it holds its turns, with its last failure. */
function syncState(runner: Runner): string {
  const sync = runnerSyncing(runner);
  if (sync === undefined) {
    return "";
  }
  const count = syncedFiles(sync);
  const failed =
    sync.error === undefined
      ? ""
      : ` (try ${sync.attempt} failed: ${sync.error}${sync.nextTryAt === undefined ? "" : `; next at ${sync.nextTryAt}`})`;
  return `  syncing board${count === null ? "" : ` ${count}`}${failed}`;
}

/**
 * One runner as `runner list` prints it: its name, whether it is connected, paused, or syncing its
 * board copy, its OS and version, what it offers, and the CLIs paused or held by their limits, a
 * pool's limit naming the pool.
 */
export function runnerListLine(runner: Runner, now: Date): string {
  return `${runner.name}  ${runner.status}${runner.paused === undefined ? "" : "  paused"}${syncState(runner)}  ${runner.os}${
    runner.version === undefined ? "" : `  v${runner.version}`
  }  ${runner.clis.join(",") || "no CLIs yet"}${
    runner.capabilities.length === 0 ? "" : `  ${runner.capabilities.join(",")}`
  }${Object.keys(runner.pausedClis ?? {})
    .map((cli) => `  ${cli} paused`)
    .join("")}${runner.clis
    .map((cli) => {
      const hold = runnerLimitHold(runner, cli, now);
      const quota = runner.quotas?.[cli];
      return `${hold === null ? "" : `  ${cli} held until ${hold.until}`}${(quota === undefined
        ? []
        : poolHolds(quota, now)
      )
        .map((held) => `  ${cli} ${held.pool} held until ${held.until}`)
        .join("")}`;
    })
    .join("")}`;
}
