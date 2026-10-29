import type { AddressInfo } from "node:net";
import { serve, type Http2Bindings, type HttpBindings, type ServerType } from "@hono/node-server";

/** Node's own default `requestTimeout`, which the board keeps for every request but a git transfer. */
export const REQUEST_TIMEOUT_MS = 300_000;
/** Node's own default `headersTimeout`, which every request keeps. */
export const HEADERS_TIMEOUT_MS = 60_000;

/** Lifts the deadline of each request in flight that has one. */
const deadlines = new WeakMap<Request, () => void>();

export interface BoardServerOptions {
  readonly fetch: (request: Request, env: HttpBindings | Http2Bindings) => unknown;
  readonly port: number;
  readonly hostname: string;
  /** How long a request may take to arrive whole before the server cuts it; Node's 300 s if left out. */
  readonly requestTimeoutMs?: number | undefined;
  /** How long a request's headers may take to arrive; Node's 60 s if left out. */
  readonly headersTimeoutMs?: number | undefined;
  /** How often Node looks for headers past their time; its 30 s if left out, which a test shortens. */
  readonly connectionsCheckingIntervalMs?: number | undefined;
}

/**
 * The board's HTTP server: `@hono/node-server` with Node's request deadline replaced by one per
 * request, which cuts a request still arriving after `requestTimeoutMs`, as Node's does, unless its
 * route lifted it once it had authorized the request (`liftDeadline`). Node exempts no request from
 * its own, and a move's pack over a slow link between sites arrives in far more than 300 s. Headers
 * keep Node's limit, which is set again here: Node's `headersTimeout` defaults to the smaller of
 * 60 s and `requestTimeout`, so turning the latter off would turn it off too, and a client trickling
 * its headers, which needs no token, would hold a connection for good.
 */
export function serveBoard(
  options: BoardServerOptions,
  listening?: (info: AddressInfo) => void,
): ServerType {
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  return serve(
    {
      fetch: (request, env) => {
        const { incoming, outgoing } = env;
        if (!incoming.complete) {
          const timer = setTimeout(() => {
            if (!incoming.complete) {
              incoming.socket.destroy();
            }
          }, timeoutMs);
          timer.unref();
          const lift = (): void => clearTimeout(timer);
          deadlines.set(request, lift);
          outgoing.once("close", lift);
        }
        return options.fetch(request, env);
      },
      port: options.port,
      hostname: options.hostname,
      serverOptions: {
        requestTimeout: 0,
        headersTimeout: options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
        ...(options.connectionsCheckingIntervalMs === undefined
          ? {}
          : { connectionsCheckingInterval: options.connectionsCheckingIntervalMs }),
      },
    },
    listening,
  );
}

/**
 * Lifts a request's deadline, for a route that has authorized it and takes as long as its body
 * keeps arriving; a request no board server took, as in a test, has none.
 */
export function liftDeadline(request: Request): void {
  deadlines.get(request)?.();
  deadlines.delete(request);
}
