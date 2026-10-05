import { describe, expect, it } from "vitest";
import { enrollRunner } from "./enroll.js";

describe("enrollRunner", () => {
  it("waits out a rate limit, asks again when its code expired, and returns the approval", async () => {
    const answers: Array<{ path: string; response: Response }> = [
      {
        path: "/runner/enroll",
        response: new Response('{"error":"RATE_LIMITED"}', {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      },
      {
        path: "/runner/enroll",
        response: Response.json({
          deviceCode: "device-1",
          userCode: "BCDF-GHJK",
          expiresAt: "2026-10-05T10:10:00.000Z",
          intervalMs: 1,
        }),
      },
      { path: "/runner/enroll/poll", response: new Response("{}", { status: 404 }) },
      {
        path: "/runner/enroll",
        response: Response.json({
          deviceCode: "device-2",
          userCode: "LMNP-QRST",
          expiresAt: "2026-10-05T10:20:00.000Z",
          intervalMs: 1,
        }),
      },
      { path: "/runner/enroll/poll", response: Response.json({ status: "pending" }) },
      {
        path: "/runner/enroll/poll",
        response: Response.json({ status: "approved", name: "studio", token: "stl_runner" }),
      },
    ];
    const asked: string[] = [];
    const codes: string[] = [];
    const warnings: string[] = [];
    const result = await enrollRunner({
      serverUrl: "https://board.example/",
      version: "test",
      clis: ["claude"],
      hostname: "studio",
      onCode: (enrollment) => codes.push(enrollment.userCode),
      log: { info() {}, warn: (_details, message) => warnings.push(message), error() {} },
      fetch: (input) => {
        const next = answers.shift();
        const url = input instanceof Request ? input.url : String(input);
        asked.push(url.replace("https://board.example", ""));
        if (next === undefined || !url.endsWith(next.path)) {
          throw new Error(`unexpected request to ${url}`);
        }
        return Promise.resolve(next.response);
      },
    });
    expect(result).toEqual({ name: "studio", token: "stl_runner" });
    expect(codes).toEqual(["BCDF-GHJK", "LMNP-QRST"]);
    expect(warnings).toEqual(["the server limits enrollment requests from this address; waiting"]);
    expect(asked).toHaveLength(6);
  });
});
