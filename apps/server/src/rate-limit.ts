import { isIPv4, isIPv6 } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";

/** Runners asking to enroll, per address: enough for a few machines behind one NAT restarting. */
export const ENROLL_LIMIT = { limit: 5, windowMs: 10 * 60_000 } as const;
/** Sign-ins started with GitHub, per address: room for retries, not for churning every state. */
export const SIGN_IN_LIMIT = { limit: 20, windowMs: 10 * 60_000 } as const;

/** Addresses tracked at once; past it the stalest goes first, so a flood cannot grow the map. */
const MAX_ADDRESSES = 10_000;

interface Hits {
  times: number[];
  /** Whether a refusal was logged since the last allowed request, so a flood logs once. */
  warned: boolean;
}

export type Verdict = { ok: true } | { ok: false; retryAfterMs: number; first: boolean };

/** At most `limit` requests per key in any `windowMs`, counted in memory. */
export class RateLimiter {
  private readonly hits = new Map<string, Hits>();

  constructor(
    private readonly options: {
      readonly limit: number;
      readonly windowMs: number;
      readonly now?: (() => number) | undefined;
    },
  ) {}

  take(key: string): Verdict {
    const now = (this.options.now ?? Date.now)();
    const since = now - this.options.windowMs;
    let entry = this.hits.get(key);
    if (entry === undefined) {
      this.makeRoom(since);
      entry = { times: [], warned: false };
    }
    // Re-inserted on every request, so the map's order runs from stalest to freshest.
    this.hits.delete(key);
    this.hits.set(key, entry);
    entry.times = entry.times.filter((time) => time > since);
    const oldest = entry.times[0];
    if (oldest !== undefined && entry.times.length >= this.options.limit) {
      const first = !entry.warned;
      entry.warned = true;
      return { ok: false, retryAfterMs: oldest + this.options.windowMs - now, first };
    }
    entry.times.push(now);
    entry.warned = false;
    return { ok: true };
  }

  private makeRoom(since: number): void {
    if (this.hits.size < MAX_ADDRESSES) {
      return;
    }
    for (const [key, entry] of this.hits) {
      if (entry.times.every((time) => time <= since)) {
        this.hits.delete(key);
      }
    }
    for (const key of this.hits.keys()) {
      if (this.hits.size < MAX_ADDRESSES) {
        break;
      }
      this.hits.delete(key);
    }
  }
}

/**
 * The address a request came from. With no trusted proxy it is the socket's peer; behind
 * `trustedProxies` reverse proxies, each of which appends the address it saw to X-Forwarded-For, it
 * is the entry the outermost of them wrote. Entries further left are whatever the client sent.
 */
export function clientAddress(c: Context, trustedProxies: number): string {
  let socket = "unknown";
  try {
    socket = getConnInfo(c).remote.address ?? socket;
  } catch {
    // A request handed to the app directly, as in tests, has no socket.
  }
  const forwarded = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const chain = [socket, ...forwarded.toReversed()];
  return chain[Math.min(trustedProxies, chain.length - 1)] ?? socket;
}

function groups(part: string): string[] {
  return part === "" ? [] : part.split(":");
}

/** How many 16-bit groups parts of an IPv6 address hold; an IPv4 address at the end is two. */
function width(parts: string[]): number {
  return parts.reduce((sum, part) => sum + (part.includes(".") ? 2 : 1), 0);
}

/**
 * The key an address is limited under: an IPv4 address as it is, and an IPv6 address by its /64,
 * the block one host or one customer is usually given, so walking through it gains nothing.
 */
export function addressKey(address: string): string {
  const unwrapped =
    /^\[(.+)\](?::\d+)?$/.exec(address)?.[1] ??
    /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(address)?.[1] ??
    address;
  const bare = unwrapped.split("%")[0] ?? unwrapped;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare)?.[1];
  if (mapped !== undefined) {
    return mapped;
  }
  if (isIPv4(bare) || !isIPv6(bare)) {
    return bare.slice(0, 64);
  }
  const [head = "", tail] = bare.split("::");
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const filled =
    tail === undefined
      ? front
      : [...front, ...Array.from({ length: 8 - width(front) - width(back) }, () => "0"), ...back];
  const prefix = filled.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16));
  return `${prefix.join(":")}::/64`;
}

/** Refuses a request over its address's limit with 429 and how long to wait, before anything else runs. */
export function rateLimit(options: {
  readonly limiter: RateLimiter;
  readonly trustedProxies: number;
  /** What is limited, for the refusal and the log: "enrollment requests". */
  readonly what: string;
  readonly log?: { warn(details: object, message: string): void } | undefined;
}): MiddlewareHandler {
  return async (c, next) => {
    const address = clientAddress(c, options.trustedProxies);
    const verdict = options.limiter.take(addressKey(address));
    if (!verdict.ok) {
      const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
      if (verdict.first) {
        options.log?.warn({ address, retryAfterSeconds: seconds }, `rate limited ${options.what}`);
      }
      c.header("retry-after", String(seconds));
      return c.json(
        {
          error: "RATE_LIMITED",
          message: `too many ${options.what} from this address; try again in ${seconds} seconds`,
        },
        429,
      );
    }
    await next();
    return undefined;
  };
}
