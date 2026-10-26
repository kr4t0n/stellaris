import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { appleAppSiteAssociation, githubAuthRoutes } from "./github-auth.js";

const APP_ID = "ABCDE12345.com.example.app";

/** A PKCE pair as the app makes one: a random verifier and its S256 challenge. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const appQuery = (challenge: string) =>
  `landing=app&code_challenge=${challenge}&code_challenge_method=S256`;
const codeOf = (landing: string) => landing.split("#code=")[1] ?? "";

describe("GitHub sign-in's landing", () => {
  let dir: string;
  let board: Board;
  let login: string;
  let clock: number;
  let routes: ReturnType<typeof githubAuthRoutes>;

  /** Starts a sign-in with this raw query and gives the state GitHub would come back with. */
  const leave = async (query: string): Promise<string> => {
    const start = await routes.request(`/github?${query}`);
    expect(start.status).toBe(302);
    return new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  };
  /** Comes back from GitHub with this state and code, none when empty, and gives the landing. */
  const back = async (state: string, code = "good"): Promise<string> => {
    const answer = await routes.request(
      `/github/callback?state=${state}${code === "" ? "" : `&code=${code}`}`,
    );
    expect(answer.status).toBe(302);
    // The landing's fragment carries a code or a session, so no cache may keep the answer.
    expect(answer.headers.get("cache-control")).toBe("no-store");
    return answer.headers.get("location") ?? "";
  };
  const signIns = async () =>
    (await board.readEvents(null)).filter((event) => event.type === "user.signed_in").length;
  const signIn = async (query: string, code = "good") => back(await leave(query), code);
  const post = (body: string) =>
    routes.request("/app/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  /** Trades a code the app's sign-in landed with for the session, as the app does. */
  const trade = (code: string, verifier: string) =>
    post(JSON.stringify({ code, code_verifier: verifier }));
  const github: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const { code } = z.object({ code: z.string() }).parse(JSON.parse(body));
      // GitHub answers a bad code with 200 and an error.
      return Response.json(
        code === "good" ? { access_token: "gho_test" } : { error: "bad_verification_code" },
      );
    }
    return Response.json({ login, id: 1001 });
  };
  /** The routes alone, without the per-address limit the app puts in front of them. */
  const build = (appleAppId: string | null) =>
    githubAuthRoutes({
      board,
      github: { clientId: "Iv1.test", clientSecret: "secret", users: ["signer-1"], appleAppId },
      fetch: github,
      now: () => clock,
    });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-github-auth-"));
    board = (await Board.init(dir, { name: "github-auth" })).board;
    login = "signer-1";
    clock = Date.now();
    routes = build(APP_ID);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lands the app's sign-in on the board's https path with a code only its verifier trades", async () => {
    const { verifier, challenge } = pkce();
    const landing = await signIn(appQuery(challenge));
    expect(landing).toMatch(/^\/auth\/app\/signin#code=[A-Za-z0-9_-]{32}$/);
    const code = codeOf(landing);
    // A sign-in that stops at the landing leaves no session on the board, and the code is none.
    expect(await signIns()).toBe(0);
    expect(board.signInOf(code)).toBeNull();
    // Another verifier fails, and the try uses the code up.
    expect((await trade(code, pkce().verifier)).status).toBe(400);
    expect(await (await trade(code, verifier)).json()).toEqual({ error: "invalid_grant" });

    const fresh = codeOf(await signIn(appQuery(challenge)));
    const answer = await trade(fresh, verifier);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("access-control-allow-origin")).toBeNull();
    const { session } = z.object({ session: z.string() }).parse(await answer.json());
    expect(board.signInOf(session)).toMatchObject({ login: "signer-1" });
    expect(await signIns()).toBe(1);
    // A code is good once.
    expect(await (await trade(fresh, verifier)).json()).toEqual({ error: "invalid_grant" });
  });

  it("trades a code only with the verifier of the sign-in it came from", async () => {
    const first = pkce();
    const second = pkce();
    const firstCode = codeOf(await signIn(appQuery(first.challenge)));
    const secondCode = codeOf(await signIn(appQuery(second.challenge)));
    expect(await (await trade(firstCode, second.verifier)).json()).toEqual({
      error: "invalid_grant",
    });
    expect((await trade(secondCode, second.verifier)).status).toBe(200);
    expect(await signIns()).toBe(1);
  });

  it("gives the app two minutes to trade its code", async () => {
    const { verifier, challenge } = pkce();
    const early = codeOf(await signIn(appQuery(challenge)));
    const late = codeOf(await signIn(appQuery(challenge)));
    clock += 2 * 60_000 - 1;
    expect((await trade(early, verifier)).status).toBe(200);
    clock += 1;
    expect(await (await trade(late, verifier)).json()).toEqual({ error: "invalid_grant" });
  });

  it("lands a failed sign-in the app started at its landing, so the app hears of it", async () => {
    const { challenge } = pkce();
    expect(await signIn(appQuery(challenge), "")).toBe("/auth/app/signin#signin-error=declined");
    expect(await signIn(appQuery(challenge), "stale")).toBe("/auth/app/signin#signin-error=github");
    login = "mallory";
    expect(await signIn(appQuery(challenge))).toBe("/auth/app/signin#signin-error=not-allowed");
  });

  it("starts the app's sign-in only with an S256 code challenge, and trades only a well-formed body", async () => {
    const { challenge } = pkce();
    for (const query of [
      "landing=app",
      `landing=app&code_challenge=${challenge}`,
      `landing=app&code_challenge=${challenge}&code_challenge_method=plain`,
      `landing=app&code_challenge=${challenge.slice(1)}&code_challenge_method=S256`,
      `landing=app&code_challenge=${challenge.slice(1)}%2B&code_challenge_method=S256`,
    ]) {
      const start = await routes.request(`/github?${query}`);
      expect(start.status).toBe(400);
      expect(start.headers.get("location")).toBeNull();
    }
    expect(await (await post("{}")).json()).toEqual({ error: "invalid_request" });
    expect(await (await post("not json")).json()).toEqual({ error: "invalid_request" });
    expect(
      await (await post(JSON.stringify({ code: "c", code_verifier: "short" }))).json(),
    ).toEqual({ error: "invalid_request" });
    expect((await post(" ".repeat(17 * 1024))).status).toBe(413);
  });

  it("refuses the app's sign-in on a board that names no app", async () => {
    routes = build(null);
    const { verifier, challenge } = pkce();
    for (const query of [
      appQuery(challenge),
      "landing=app",
      `landing=app&next=${encodeURIComponent("/runners")}`,
    ]) {
      const start = await routes.request(`/github?${query}`);
      expect(start.status).toBe(403);
      expect(start.headers.get("location")).toBeNull();
      expect(await start.text()).toBe("Signing in to the app is off on this board");
    }
    // There is nothing to trade a code at.
    expect((await trade("anything", verifier)).status).toBe(404);
    // The board's own sign-in still lands on the board.
    expect(await signIn(`next=${encodeURIComponent("/runners")}`)).toMatch(/^\/runners#session=/);
    expect(await signIn("landing=APP")).toMatch(/^\/#session=/);
    expect(await (await routes.request("/config")).json()).toEqual({
      github: true,
      appLanding: false,
    });
    routes = build(APP_ID);
    expect(await (await routes.request("/config")).json()).toEqual({
      github: true,
      appLanding: true,
    });
  });

  it("serves nothing at the app's landing, whether the board names an app or not", async () => {
    for (const appleAppId of [null, APP_ID]) {
      routes = build(appleAppId);
      const page = await routes.request("/app/signin");
      expect(page.status).toBe(404);
      expect(page.headers.get("cache-control")).toBe("no-store");
    }
  });

  /** Values of `next` that name another host or scheme, as written or as a browser resolves them. */
  const crafted = [
    "//evil.example/",
    "https://evil.example/",
    "evil://signin",
    "stellaris://signin",
    "/\\evil.example/",
    // A browser drops tabs and newlines from an address before it parses it.
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r\n/evil.example",
    // Dot segments go, leaving a path that starts with two slashes.
    "/.//evil.example",
    "/a/..//evil.example",
    "/./\\evil.example",
  ];
  /** Flags that are not `app`, which lead to the board's own landing. */
  const flags = [
    "evil://signin",
    "https://evil.example/",
    "//evil.example/",
    "stellaris://evil",
    "stellaris://signin",
    "APP",
    "app ",
    "",
  ];

  it("lands nowhere a request names, with the flag or without it", async () => {
    const { challenge } = pkce();
    // With the flag, `next` names nothing.
    for (const next of ["/runners", ...crafted]) {
      expect(await signIn(`${appQuery(challenge)}&next=${encodeURIComponent(next)}`)).toMatch(
        /^\/auth\/app\/signin#code=/,
      );
    }
    // Any other flag is no flag: the board's own landing, with `next` read as without one.
    for (const flag of flags) {
      const flagged = `landing=${encodeURIComponent(flag)}`;
      expect(await signIn(flagged)).toMatch(/^\/#session=/);
      expect(await signIn(`${flagged}&next=${encodeURIComponent("/runners?code=BCDF")}`)).toMatch(
        /^\/runners\?code=BCDF#session=/,
      );
      for (const next of crafted) {
        expect(await signIn(`${flagged}&next=${encodeURIComponent(next)}`)).toMatch(/^\/#session=/);
      }
    }
    // The first of a repeated flag counts, and either way the landing is one of the two.
    const evil = encodeURIComponent("https://evil.example/");
    expect(await signIn(`landing=${evil}&${appQuery(challenge)}`)).toMatch(/^\/#session=/);
    expect(await signIn(`${appQuery(challenge)}&landing=${evil}`)).toMatch(
      /^\/auth\/app\/signin#code=/,
    );
    // Without the flag, `next` reaches neither the app's landing nor any other host.
    for (const next of crafted) {
      expect(await signIn(`next=${encodeURIComponent(next)}`)).toMatch(/^\/#session=/);
    }
  });

  it("never lands on a custom scheme or another host, whether the board names an app or not", async () => {
    const { challenge } = pkce();
    const queries = [
      appQuery(challenge),
      ...flags.map((flag) => `landing=${encodeURIComponent(flag)}`),
      ...crafted.map((next) => `next=${encodeURIComponent(next)}`),
      ...crafted.map((next) => `${appQuery(challenge)}&next=${encodeURIComponent(next)}`),
    ];
    for (const appleAppId of [null, APP_ID]) {
      routes = build(appleAppId);
      for (const query of queries) {
        for (const code of ["good", "", "stale"]) {
          // Only the app's sign-in on a board that names no app is refused.
          const refused = appleAppId === null && query.startsWith("landing=app&");
          const start = await routes.request(`/github?${query}`);
          expect(start.status).toBe(refused ? 403 : 302);
          if (refused) {
            continue;
          }
          const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
          const landing = await back(state ?? "", code);
          expect(landing).toMatch(/^\/(?![/\\])/);
          expect(landing).not.toMatch(/stellaris:/);
        }
      }
    }
  });

  it("lands the board's own sign-in as before, whatever code challenge a request adds", async () => {
    const { challenge } = pkce();
    for (const appleAppId of [null, APP_ID]) {
      routes = build(appleAppId);
      expect(
        await signIn(
          `next=${encodeURIComponent("/runners")}&code_challenge=${challenge}&code_challenge_method=S256`,
        ),
      ).toMatch(/^\/runners#session=/);
    }
  });

  it("lands the board's own sign-in on the path a browser would resolve `next` to", async () => {
    expect(await signIn(`next=${encodeURIComponent("/runners?code=BCDF")}`)).toMatch(
      /^\/runners\?code=BCDF#session=/,
    );
    expect(await signIn(`next=${encodeURIComponent("/a/../runners?code=BCDF")}`)).toMatch(
      /^\/runners\?code=BCDF#session=/,
    );
    // A fragment of its own would hide the session's.
    expect(await signIn(`next=${encodeURIComponent("/runners#top")}`)).toMatch(
      /^\/runners#session=/,
    );
  });

  it("lands a state it no longer holds on the sky, since nothing then says the app asked", async () => {
    const state = await leave(appQuery(pkce().challenge));
    expect(await back(state)).toMatch(/^\/auth\/app\/signin#code=/);
    expect(await back(state)).toBe("/#signin-error=expired");
  });
});

describe("Apple's association file", () => {
  const github = { clientId: "Iv1.test", clientSecret: "secret", users: ["signer-1"] };

  it("names exactly the board's app under webcredentials", async () => {
    const answer = await appleAppSiteAssociation({ ...github, appleAppId: APP_ID }).request(
      "/apple-app-site-association",
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/json");
    expect(await answer.text()).toBe(`{"webcredentials":{"apps":["${APP_ID}"]}}`);
  });

  it("is not found on a board that names no app, or has no GitHub sign-in", async () => {
    for (const signIn of [{ ...github, appleAppId: null }, null]) {
      const answer = await appleAppSiteAssociation(signIn).request("/apple-app-site-association");
      expect(answer.status).toBe(404);
    }
  });
});
