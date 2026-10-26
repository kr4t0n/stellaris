import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Board } from "@stellaris/board-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { githubAuthRoutes } from "./github-auth.js";

describe("GitHub sign-in's landing", () => {
  let dir: string;
  let board: Board;
  let login: string;
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
    return answer.headers.get("location") ?? "";
  };
  const signIn = async (query: string, code = "good") => back(await leave(query), code);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "stellaris-github-auth-"));
    board = (await Board.init(dir, { name: "github-auth" })).board;
    login = "signer-1";
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
    // The routes alone, without the per-address limit the app puts in front of them.
    routes = githubAuthRoutes({
      board,
      github: { clientId: "Iv1.test", clientSecret: "secret", users: ["signer-1"] },
      fetch: github,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lands a sign-in the app asked for at the app's own scheme", async () => {
    const landing = await signIn("landing=app");
    expect(landing).toMatch(/^stellaris:\/\/signin#session=stl_/);
    const token = decodeURIComponent(landing.split("#session=")[1] ?? "");
    expect(board.signInOf(token)).toMatchObject({ login: "signer-1" });
    // A failed sign-in lands there too, so the app hears of it.
    expect(await signIn("landing=app", "")).toBe("stellaris://signin#signin-error=declined");
    expect(await signIn("landing=app", "stale")).toBe("stellaris://signin#signin-error=github");
    login = "mallory";
    expect(await signIn("landing=app")).toBe("stellaris://signin#signin-error=not-allowed");
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

  it("lands nowhere a request names, with the flag or without it", async () => {
    // With the flag, `next` names nothing.
    for (const next of ["/runners", ...crafted]) {
      expect(await signIn(`landing=app&next=${encodeURIComponent(next)}`)).toMatch(
        /^stellaris:\/\/signin#session=/,
      );
    }
    // Any other flag is no flag: the board's own landing, with `next` read as without one.
    for (const flag of [
      "evil://signin",
      "https://evil.example/",
      "//evil.example/",
      "stellaris://evil",
      "stellaris://signin",
      "APP",
      "app ",
      "",
    ]) {
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
    expect(await signIn(`landing=${evil}&landing=app`)).toMatch(/^\/#session=/);
    expect(await signIn(`landing=app&landing=${evil}`)).toMatch(/^stellaris:\/\/signin#session=/);
    // Without the flag, `next` reaches neither the app's scheme nor any other host.
    for (const next of crafted) {
      expect(await signIn(`next=${encodeURIComponent(next)}`)).toMatch(/^\/#session=/);
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
    const state = await leave("landing=app");
    expect(await back(state)).toMatch(/^stellaris:\/\/signin#session=/);
    expect(await back(state)).toBe("/#signin-error=expired");
  });
});
