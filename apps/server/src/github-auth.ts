import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Board } from "@stellaris/board-core";
import type { GithubSignIn } from "@stellaris/shared";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { APP_TOKEN_BODY_LIMIT_BYTES, limitBody } from "./body-limit.js";

/** How long a sign-in lasts before the user signs in again. */
export const SIGN_IN_TTL_MS = 30 * 24 * 3_600_000;
/** How long a browser has to come back from GitHub with the state it was sent with. */
const STATE_TTL_MS = 10 * 60_000;
/**
 * States waiting at once; the oldest go first, so nobody can grow the map without bound, and the
 * rate limit per address keeps one client from churning out someone else's.
 */
const MAX_STATES = 1_000;
/** How long the app has to trade the code its sign-in landed with for the session. */
const CODE_TTL_MS = 2 * 60_000;

const TokenAnswerSchema = z.object({ access_token: z.string().min(1) });
/** RFC 7636: the base64url of a SHA-256, and the verifier the app keeps, 43 to 128 characters. */
const CodeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const CodeExchangeSchema = z.object({
  code: z.string().min(1).max(64),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
const GithubUserSchema = z.object({
  login: z.string().min(1),
  id: z.number().int(),
  avatar_url: z.string().optional(),
});

/** The account's picture, kept only as an address on GitHub's own avatar host. */
function githubAvatar(url: string | undefined): string | undefined {
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "https:" && parsed.hostname === "avatars.githubusercontent.com"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

export interface GithubAuthOptions {
  readonly board: Board;
  /** The OAuth app and the logins it lets in, or null when the board takes tokens only. */
  readonly github: GithubSignIn | null;
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly log?: { warn(details: object, message: string): void } | undefined;
  /** Limits starting a sign-in and trading the app's code, which anyone may do. */
  readonly limit?: MiddlewareHandler | undefined;
}

/** Stands in for the board's own origin while `safeNext` resolves a path; never a real host. */
const BOARD_ORIGIN = "https://board.invalid";

/**
 * A path inside the board to land on after signing in; anything else lands on the sky. `next` is
 * resolved as a browser resolves it, which drops tabs and newlines first, so `/<tab>/host` names
 * another host however the raw string reads. The landing is rebuilt from the resolved path and
 * query, and refused when that path starts with `//` or `/\`, as `/.//host`'s does once its dot
 * segment goes.
 */
export function safeNext(next: string | undefined): string {
  if (next === undefined || !next.startsWith("/")) {
    return "/";
  }
  let url: URL;
  try {
    url = new URL(next, BOARD_ORIGIN);
  } catch {
    return "/";
  }
  const path = `${url.pathname}${url.search}`;
  return url.origin === BOARD_ORIGIN && /^\/(?![/\\])/.test(path) ? path : "/";
}

/**
 * Where a sign-in the app started lands, on the board's own origin: the `https` address its
 * `ASWebAuthenticationSession` waits for, which Apple lets only the app the association file names
 * take. Fixed here; a request only asks for it, with `landing=app`, and never names a host. It
 * carries a one-time code, never the session, and answers a browser that opens it with a 404.
 */
const APP_LANDING = "/auth/app/signin";

/** Sends the browser on with a fragment it alone keeps, in an answer nothing may cache. */
function land(c: Context, next: string, fragment: string): Response {
  c.header("cache-control", "no-store");
  return c.redirect(`${next}#${fragment}`, 302);
}

/** Drops what has expired, and the oldest once the map is full. */
function prune<T extends { expiresAt: number }>(map: Map<string, T>, now: number): void {
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now || map.size >= MAX_STATES) {
      map.delete(key);
    }
  }
}

/** Whether `verifier` is the one whose S256 challenge the app sent when it started (RFC 7636). */
function provesChallenge(verifier: string, challenge: string): boolean {
  const answer = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return answer.length === expected.length && timingSafeEqual(answer, expected);
}

/**
 * Signing in to the board with GitHub, under `/auth`. The browser leaves for GitHub with a state
 * the server remembers, comes back to `/auth/github/callback`, and the server asks GitHub who
 * signed in; a login on the list gets a sign-in token in the address's fragment, which no request
 * and no proxy log carries. A state the server no longer holds lands on the sky, since nothing then
 * says the app asked. The authorize request names no redirect, so GitHub sends the browser to the
 * one callback the OAuth app registers, the board's address.
 *
 * The app's sign-in, only on a board that names it (`appleAppId`), starts with a PKCE challenge
 * and lands at `APP_LANDING` with a one-time code, which the app trades with its verifier at
 * `/auth/app/token` for the session, which exists only once the app that started proves it.
 */
export function githubAuthRoutes(options: GithubAuthOptions): Hono {
  const { board, github } = options;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const states = new Map<string, { next: string; challenge: string | null; expiresAt: number }>();
  const codes = new Map<
    string,
    { challenge: string; login: string; avatar: string | undefined; expiresAt: number }
  >();
  const routes = new Hono();

  routes.get("/config", (c) =>
    c.json({ github: github !== null, appLanding: (github?.appleAppId ?? null) !== null }),
  );
  // Nothing is served at the app's landing: the app's session takes the address when it navigates
  // there, and a browser that opens it holds a code it can't trade without the app's verifier.
  routes.get("/app/signin", (c) => c.text("not found", 404, { "cache-control": "no-store" }));
  if (github === null) {
    return routes;
  }

  const limit = options.limit ?? ((_c, next) => next());
  routes.get("/github", limit, (c) => {
    const app = c.req.query("landing") === "app";
    let challenge: string | null = null;
    if (app) {
      // Refused, not sent to the board's own landing: the app would never hear back, and the
      // session would stay in a browser nobody meant to sign in.
      if (github.appleAppId === null) {
        return c.text("Signing in to the app is off on this board", 403);
      }
      const parsed = CodeChallengeSchema.safeParse(c.req.query("code_challenge"));
      if (!parsed.success || c.req.query("code_challenge_method") !== "S256") {
        return c.text("Signing in to the app needs a code_challenge with method S256", 400);
      }
      challenge = parsed.data;
    }
    prune(states, now());
    const state = randomBytes(24).toString("base64url");
    const next = app ? APP_LANDING : safeNext(c.req.query("next"));
    states.set(state, { next, challenge, expiresAt: now() + STATE_TTL_MS });
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
    let avatar: string | undefined;
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
      const user = GithubUserSchema.parse(await userAnswer.json());
      ({ login, id } = user);
      avatar = githubAvatar(user.avatar_url);
    } catch (error) {
      options.log?.warn({ error: String(error) }, "GitHub sign-in failed");
      return land(c, pending.next, "signin-error=github");
    }
    // A login can be renamed and then taken by someone else; a numeric id never changes.
    if (!github.users.includes(login.toLowerCase()) && !github.users.includes(String(id))) {
      options.log?.warn({ login }, "GitHub sign-in refused a login that is not on the list");
      return land(c, pending.next, "signin-error=not-allowed");
    }
    if (pending.challenge !== null) {
      prune(codes, now());
      const appCode = randomBytes(24).toString("base64url");
      codes.set(appCode, {
        challenge: pending.challenge,
        login,
        avatar,
        expiresAt: now() + CODE_TTL_MS,
      });
      return land(c, pending.next, `code=${appCode}`);
    }
    const token = await board.signIn(login, SIGN_IN_TTL_MS, avatar);
    return land(c, pending.next, `session=${encodeURIComponent(token)}`);
  });

  if (github.appleAppId !== null) {
    // Under the same limit per address as starting, which a sign-in in the app passes twice.
    routes.post("/app/token", limit, limitBody(APP_TOKEN_BODY_LIMIT_BYTES), async (c) => {
      const body = CodeExchangeSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        return c.json({ error: "invalid_request" }, 400);
      }
      const pending = codes.get(body.data.code);
      codes.delete(body.data.code);
      if (
        pending === undefined ||
        pending.expiresAt <= now() ||
        !provesChallenge(body.data.code_verifier, pending.challenge)
      ) {
        return c.json({ error: "invalid_grant" }, 400);
      }
      const token = await board.signIn(pending.login, SIGN_IN_TTL_MS, pending.avatar);
      return c.json({ session: token }, 200, { "cache-control": "no-store" });
    });
  }

  return routes;
}

/**
 * Apple's association file, `/.well-known/apple-app-site-association`, naming the app that may take
 * the board's `https` sign-in landing under the `webcredentials` service, which an
 * `ASWebAuthenticationSession` `https` callback needs. A 404 on a board that names no app.
 */
export function appleAppSiteAssociation(github: GithubSignIn | null): Hono {
  const routes = new Hono();
  routes.get("/apple-app-site-association", (c) => {
    const appId = github?.appleAppId ?? null;
    return appId === null
      ? c.text("not found", 404)
      : c.json({ webcredentials: { apps: [appId] } });
  });
  return routes;
}
