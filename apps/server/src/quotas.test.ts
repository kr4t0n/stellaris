import { CliQuotaSchema, type CliKind, type CliQuota, type Name } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { QuotaReads } from "./quotas.js";

const QUOTA = CliQuotaSchema.parse({
  observedAt: "2026-10-13T12:00:00.000Z",
  source: "read",
  status: "allowed",
});

describe("QuotaReads", () => {
  it("shares a read under way, answers it again for a minute, and retries one that failed", async () => {
    let clock = 0;
    const asked: string[] = [];
    let fail = true;
    const reads = new QuotaReads(
      {
        quota: (runner: Name, cli: CliKind): Promise<CliQuota> => {
          asked.push(`${runner}/${cli}`);
          return fail
            ? Promise.reject(new Error("the CLI could not read"))
            : Promise.resolve(QUOTA);
        },
      },
      60_000,
      () => clock,
    );

    await expect(reads.read("pod", "codex")).rejects.toThrow("could not read");
    fail = false;
    // A failed read is not kept, so the next ask goes to the runner again.
    const [first, second] = await Promise.all([
      reads.read("pod", "codex"),
      reads.read("pod", "codex"),
    ]);
    expect(first).toBe(QUOTA);
    expect(second).toBe(QUOTA);
    expect(asked).toEqual(["pod/codex", "pod/codex"]);

    clock = 59_999;
    await reads.read("pod", "codex");
    expect(asked).toHaveLength(2);
    // Another CLI or runner is its own read.
    await reads.read("pod", "claude");
    await reads.read("merlin", "codex");
    expect(asked).toEqual(["pod/codex", "pod/codex", "pod/claude", "merlin/codex"]);

    clock = 60_000;
    await reads.read("pod", "codex");
    expect(asked.at(-1)).toBe("pod/codex");
    expect(asked).toHaveLength(5);
  });
});
