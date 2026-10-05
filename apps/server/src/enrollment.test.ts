import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { RUNNER_PROTOCOL } from "@stellaris/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENROLLMENT_TTL_MS, EnrollmentDesk } from "./enrollment.js";

const USER = { name: "user", role: "user" } as const;
const request = {
  protocol: RUNNER_PROTOCOL,
  version: "test",
  hostname: "studio",
  os: "linux" as const,
  clis: ["claude" as const],
  capabilities: [],
};

describe("EnrollmentDesk", () => {
  let dir: string;
  let board: Board;
  let clock: number;
  let desk: EnrollmentDesk;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-enroll-"));
    ({ board } = await Board.init(dir, { name: "enroll" }));
    clock = Date.parse("2026-10-05T10:00:00.000Z");
    desk = new EnrollmentDesk(board, { now: () => clock });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("tells an approval once and forgets it", async () => {
    const { deviceCode, userCode } = desk.open(request);
    expect(userCode).toMatch(/^[B-Z2-9]{4}-[B-Z2-9]{4}$/);
    expect(desk.poll(deviceCode)).toEqual({ status: "pending" });
    await desk.approve(USER, userCode, "studio");
    expect(desk.poll(deviceCode)).toMatchObject({ status: "approved", name: "studio" });
    expect(desk.poll(deviceCode)).toBeNull();
    await expect(desk.approve(USER, userCode, "studio-2")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lets enrollments expire, and holds no more than a hundred at once", () => {
    const first = desk.open(request);
    for (let n = 1; n < 100; n += 1) {
      desk.open(request);
    }
    expect(desk.waiting()).toHaveLength(100);
    expect(() => desk.open(request)).toThrow(/100 runners already wait/);
    clock += ENROLLMENT_TTL_MS;
    expect(desk.poll(first.deviceCode)).toBeNull();
    expect(desk.waiting()).toEqual([]);
    expect(() => desk.deny(first.userCode)).toThrow(/no runner waits/);
    desk.open(request);
  });
});
