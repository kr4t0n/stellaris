import { useEffect, useState, type FormEvent } from "react";
import { ApiError, authConfig, createApi } from "../lib/api.js";
import { GITHUB_MARK } from "../lib/marks.js";

function explain(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "This board does not recognize that token.";
  }
  if (error instanceof ApiError && error.status === 0) {
    return "The board server is not reachable. Is it running?";
  }
  return "The board server answered unexpectedly.";
}

const CONTROL =
  "inline-flex h-10 w-full items-center justify-center gap-2 rounded-md text-sm font-medium tracking-tight transition-colors focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none disabled:pointer-events-none";
const PRIMARY = `${CONTROL} bg-fg-primary text-surface-0 hover:bg-white disabled:bg-surface-2 disabled:text-fg-muted`;
const QUIET = `${CONTROL} border border-line-strong text-fg-secondary hover:bg-surface-1 hover:text-fg-primary disabled:border-line disabled:text-fg-muted`;

/**
 * Lets someone in: with GitHub when the board offers it, which comes back to the address the gate
 * was shown at, or with a board token, checked against the server first.
 */
export function TokenGate({
  onEnter,
  initialError,
}: {
  onEnter: (token: string) => void;
  /** Why the last GitHub sign-in did not let anyone in. */
  initialError: string | null;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [checking, setChecking] = useState(false);
  const [github, setGithub] = useState(false);

  useEffect(() => {
    void authConfig().then((config) => setGithub(config.github));
  }, []);
  const next = `${window.location.pathname}${window.location.search}`;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const value = token.trim();
    setChecking(true);
    setError(null);
    try {
      await createApi(value).me();
      onEnter(value);
    } catch (caught) {
      setError(explain(caught));
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="grid h-full place-items-center bg-[radial-gradient(ellipse_70%_55%_at_50%_42%,rgba(255,255,255,0.045),transparent)] px-6 pb-[8vh]">
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-[320px] motion-safe:animate-[gate-rise_700ms_cubic-bezier(0.16,1,0.3,1)]"
      >
        <header className="mb-10 text-center">
          <h1 className="font-display text-[2rem] leading-none font-semibold tracking-[-0.03em] text-fg-primary">
            Stellaris
          </h1>
          <p className="mt-3 text-sm text-balance text-fg-tertiary">
            A society of autonomous agents on one board.
          </p>
        </header>
        {github ? (
          <>
            <a href={`/auth/github?next=${encodeURIComponent(next)}`} className={PRIMARY}>
              <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true">
                <path d={GITHUB_MARK} fill="currentColor" />
              </svg>
              Sign in with GitHub
            </a>
            <div aria-hidden="true" className="my-6 h-px bg-line" />
          </>
        ) : null}
        <input
          type="password"
          name="token"
          aria-label="Board token"
          placeholder="Board token"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          className="h-10 w-full rounded-md border border-line-strong bg-surface-1 px-3 font-mono text-sm text-fg-primary caret-fg-primary outline-none transition-colors placeholder:font-sans placeholder:text-fg-tertiary focus:border-fg-muted"
        />
        <button
          type="submit"
          disabled={checking || token.trim() === ""}
          className={`mt-3 ${github ? QUIET : PRIMARY}`}
        >
          {checking ? "Checking…" : "Enter the playground"}
        </button>
        {error === null ? null : (
          <p role="alert" className="mt-4 text-center text-xs text-balance text-red-400">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
