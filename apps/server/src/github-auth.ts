import { randomBytes } from "node:crypto";
import type { Board } from "@stellaris/board-core";
import type { GithubSignIn } from "@stellaris/shared";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";

/** How long a sign-in lasts before the user signs in again. */
export const SIGN_IN_TTL_MS = 30 * 24 * 3_600_000;
/** How long a browser has to come back from GitHub with the state it was sent with. */
const STATE_TTL_MS = 10 * 60_000;
/**
 * States waiting at once; the oldest go first, so nobody can grow the map without bound, and the
 * rate limit per address keeps one client from churning out someone else's.
 */
const MAX_STATES = 1_000;

const TokenAnswerSchema = z.object({ access_token: z.string().min(1) });
const GithubUserSchema = z.object({ login: z.string().min(1), id: z.number().int() });

export interface GithubAuthOptions {
  readonly board: Board;
  /** The OAuth app and the logins it lets in, or null when the board takes tokens only. */
  readonly github: GithubSignIn | null;
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly log?: { warn(details: object, message: string): void } | undefined;
  /** Limits starting a sign-in, which anyone may do. */
  readonly limit?: MiddlewareHandler | undefined;
}

/** A path inside the board to land on after signing in; anything else lands on the sky. */
export function safeNext(next: string | undefined): string {
  return next !== undefined && /^\/(?![/\\])/.test(next) ? next : "/";
}

function land(c: Context, next: string, fragment: string): Response {
  return c.redirect(`${next}#${fragment}`, 302);
}

/**
 * Signing in to the board with GitHub, under `/auth`. The browser leaves for GitHub with a state
 * the server remembers, comes back to `/auth/github/callback`, and the server asks GitHub who
 * signed in; a login on the list gets a sign-in token, handed to the interface in the address's
 * fragment, which no request and no proxy log carries. The authorize request names no redirect, so
 * GitHub sends the browser to the one callback the OAuth app registers, the board's address.
 */
export function githubAuthRoutes(options: GithubAuthOptions): Hono {
  const { board, github } = options;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const states = new Map<string, { next: string; expiresAt: number }>();
  const routes = new Hono();

  routes.get("/config", (c) => c.json({ github: github !== null }));
  if (github === null) {
    return routes;
  }

  routes.get("/github", options.limit ?? ((_c, next) => next()), (c) => {
    for (const [state, pending] of states) {
      if (pending.expiresAt <= now() || states.size >= MAX_STATES) {
        states.delete(state);
      }
    }
    const state = randomBytes(24).toString("base64url");
    states.set(state, { next: safeNext(c.req.query("next")), expiresAt: now() + STATE_TTL_MS });
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", github.clientId);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("allow_signup", "false");
    return c.redirect(authorize.toString(), 302);
  });

  routes.get("/github/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const pending = states.get(state);
    states.delete(state);
    if (pending === undefined || pending.expiresAt <= now()) {
      return land(c, "/", "signin-error=expired");
    }
    const code = c.req.query("code");
    if (code === undefined || code === "") {
      return land(c, pending.next, "signin-error=declined");
    }
    let login: string;
    let id: number;
    try {
      const tokenAnswer = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: github.clientId,
          client_secret: github.clientSecret,
          code,
        }),
      });
      // GitHub answers a bad code with 200 and an error field, which the schema refuses.
      const { access_token: accessToken } = TokenAnswerSchema.parse(await tokenAnswer.json());
      const userAnswer = await fetchImpl("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": "stellaris",
        },
      });
      if (!userAnswer.ok) {
        throw new Error(`GitHub answered ${userAnswer.status} for the user`);
      }
      ({ login, id } = GithubUserSchema.parse(await userAnswer.json()));
    } catch (error) {
      options.log?.warn({ error: String(error) }, "GitHub sign-in failed");
      return land(c, pending.next, "signin-error=github");
    }
    // A login can be renamed and then taken by someone else; a numeric id never changes.
    if (!github.users.includes(login.toLowerCase()) && !github.users.includes(String(id))) {
      options.log?.warn({ login }, "GitHub sign-in refused a login that is not on the list");
      return land(c, pending.next, "signin-error=not-allowed");
    }
    const token = await board.signIn(login, SIGN_IN_TTL_MS);
    return land(c, pending.next, `session=${encodeURIComponent(token)}`);
  });

  return routes;
}
