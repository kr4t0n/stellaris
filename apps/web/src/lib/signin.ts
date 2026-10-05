import { storeToken } from "./api.js";

/** What the board's GitHub sign-in left in the address's fragment: a token, or why there is none. */
export interface SignInLanding {
  readonly token: string | null;
  readonly error: string | null;
}

const SIGN_IN_ERRORS: Record<string, string> = {
  expired: "The sign-in took too long or was already used. Try again.",
  declined: "GitHub sign-in was cancelled.",
  github: "GitHub could not confirm who signed in. Try again.",
  "not-allowed": "That GitHub account is not allowed on this board.",
};

/** The sign-in a fragment carries, or null when it carries none. */
export function readSignInFragment(hash: string): SignInLanding | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("session");
  const error = params.get("signin-error");
  if (token === null && error === null) {
    return null;
  }
  return {
    token: token === null || token === "" ? null : token,
    error: error === null ? null : (SIGN_IN_ERRORS[error] ?? "GitHub sign-in failed."),
  };
}

/**
 * Takes a sign-in from the address once, before the interface renders: stores its token and drops
 * the fragment from the address and its history entry, so the token is not left in either.
 */
export function takeSignIn(): SignInLanding | null {
  const landing = readSignInFragment(window.location.hash);
  if (landing !== null) {
    if (landing.token !== null) {
      storeToken(landing.token);
    }
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }
  return landing;
}
