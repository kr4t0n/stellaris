import { CliQuotaSchema, RunnerSchema } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { runnerListLine } from "./runner-list.js";

const NOW = new Date("2026-10-13T12:00:00.000Z");

describe("runnerListLine", () => {
  const studio = RunnerSchema.parse({
    name: "studio",
    os: "darwin",
    clis: ["claude"],
    capabilities: ["gpu"],
    version: "0.5.0",
    status: "connected",
  });
  const sync = {
    phase: "copying",
    files: 6_200,
    totalFiles: 15_152,
    bytes: 11_000_000,
    totalBytes: 27_000_000,
    attempt: 1,
    startedAt: "2026-10-13T11:58:00.000Z",
    updatedAt: "2026-10-13T11:59:59.000Z",
  };

  it("names a pool of a CLI's models its limit holds, and until when", () => {
    const pod = RunnerSchema.parse({
      name: "pod",
      os: "linux",
      clis: ["antigravity"],
      capabilities: [],
      status: "connected",
      quotas: {
        antigravity: CliQuotaSchema.parse({
          observedAt: "2026-10-13T11:50:00.000Z",
          source: "turn",
          status: "warning",
          pools: [
            {
              key: "3p",
              limited: true,
              limitedUntil: "2026-10-13T15:40:00.000Z",
              observedAt: "2026-10-13T11:50:00.000Z",
            },
          ],
        }),
      },
    });
    expect(runnerListLine(pod, NOW)).toBe(
      "pod  connected  linux  antigravity  antigravity 3p held until 2026-10-13T15:40:00.000Z",
    );
  });

  it("says a runner syncs its board copy, how far it has come, and after a failed try why and when the next is", () => {
    expect(runnerListLine(studio, NOW)).toBe("studio  connected  darwin  v0.5.0  claude  gpu");
    expect(runnerListLine(RunnerSchema.parse({ ...studio, sync }), NOW)).toBe(
      "studio  connected  syncing board 6,200 / 15,152 files  darwin  v0.5.0  claude  gpu",
    );
    expect(
      runnerListLine(
        RunnerSchema.parse({
          ...studio,
          sync: { ...sync, phase: "starting", files: 0, totalFiles: null },
        }),
        NOW,
      ),
    ).toBe("studio  connected  syncing board  darwin  v0.5.0  claude  gpu");
    expect(
      runnerListLine(
        RunnerSchema.parse({
          ...studio,
          sync: {
            ...sync,
            attempt: 3,
            error: "fetch failed, caused by SocketError: other side closed",
            nextTryAt: "2026-10-13T12:00:20.000Z",
          },
        }),
        NOW,
      ),
    ).toBe(
      "studio  connected  syncing board 6,200 / 15,152 files (try 3 failed: fetch failed, caused by SocketError: other side closed; next at 2026-10-13T12:00:20.000Z)  darwin  v0.5.0  claude  gpu",
    );
    // Done, or away, it holds nothing and says nothing of it.
    expect(
      runnerListLine(
        RunnerSchema.parse({
          ...studio,
          sync: { ...sync, phase: "done", finishedAt: sync.updatedAt },
        }),
        NOW,
      ),
    ).toBe("studio  connected  darwin  v0.5.0  claude  gpu");
    expect(
      runnerListLine(RunnerSchema.parse({ ...studio, status: "disconnected", sync }), NOW),
    ).toBe("studio  disconnected  darwin  v0.5.0  claude  gpu");
  });
});
