import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { addressKey, clientAddress, RateLimiter, rateLimit } from "./rate-limit.js";

describe("RateLimiter", () => {
  it("allows a limit per window, says when to come back, and logs a flood once", () => {
    let clock = 0;
    const limiter = new RateLimiter({ limit: 2, windowMs: 1_000, now: () => clock });
    expect(limiter.take("a")).toEqual({ ok: true });
    clock = 400;
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("b")).toEqual({ ok: true });
    clock = 500;
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterMs: 500, first: true });
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterMs: 500, first: false });
    // The first request leaves the window, and its place opens.
    clock = 1_000;
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toMatchObject({ ok: false, first: true });
  });

  it("keeps a bounded number of addresses, dropping the stalest", () => {
    let clock = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, now: () => clock });
    expect(limiter.take("first")).toEqual({ ok: true });
    for (let n = 0; n < 10_000; n += 1) {
      clock += 1;
      limiter.take(`flood-${n}`);
    }
    // Forgotten to make room, so it starts again.
    expect(limiter.take("first")).toEqual({ ok: true });
  });
});

describe("addressKey", () => {
  it("keys IPv4 by address and IPv6 by its /64", () => {
    expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(addressKey("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(addressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(addressKey("2001:db8:aa:bb:1:2:3:4")).toBe("2001:db8:aa:bb::/64");
    expect(addressKey("2001:db8:aa:bb::ffff")).toBe("2001:db8:aa:bb::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("[2001:DB8:00aa:bb::1]:443")).toBe("2001:db8:aa:bb::/64");
    expect(addressKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("unknown")).toBe("unknown");
  });
});

async function seen(trustedProxies: number, forwarded?: string): Promise<string> {
  const app = new Hono();
  app.get("/", (c) => c.text(clientAddress(c, trustedProxies)));
  const headers: Record<string, string> =
    forwarded === undefined ? {} : { "x-forwarded-for": forwarded };
  return (await app.request("/", { headers })).text();
}

describe("clientAddress", () => {
  it("trusts only the entries the trusted proxies appended", async () => {
    // Without a socket, as here, the peer is unknown.
    expect(await seen(0, "198.51.100.1")).toBe("unknown");
    // One proxy appends the client it saw; what the client sent before it is not believed.
    expect(await seen(1, "6.6.6.6, 198.51.100.1")).toBe("198.51.100.1");
    expect(await seen(2, "6.6.6.6, 198.51.100.1, 192.0.2.10")).toBe("198.51.100.1");
    // A request that skipped the proxies has fewer entries; the furthest one stands.
    expect(await seen(2, "198.51.100.1")).toBe("198.51.100.1");
    expect(await seen(1)).toBe("unknown");
  });

  it("refuses an address over its limit with 429 and Retry-After, and leaves the others alone", async () => {
    const app = new Hono();
    const warnings: string[] = [];
    app.post(
      "/enroll",
      rateLimit({
        limiter: new RateLimiter({ limit: 1, windowMs: 60_000 }),
        trustedProxies: 1,
        what: "enrollment requests",
        log: { warn: (_details, message) => warnings.push(message) },
      }),
      (c) => c.json({ ok: true }),
    );
    const from = (address: string) =>
      app.request("/enroll", { method: "POST", headers: { "x-forwarded-for": address } });
    expect((await from("198.51.100.1")).status).toBe(200);
    const refused = await from("198.51.100.1");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toMatchObject({ error: "RATE_LIMITED" });
    expect((await from("198.51.100.1")).status).toBe(429);
    expect((await from("198.51.100.2")).status).toBe(200);
    expect(warnings).toEqual(["rate limited enrollment requests"]);
  });
});
