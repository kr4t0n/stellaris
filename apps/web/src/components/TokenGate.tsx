import { useEffect, useState, type FormEvent } from "react";
import { ApiError, authConfig, createApi } from "../lib/api.js";

function explain(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "This board does not recognize that token.";
  }
  if (error instanceof ApiError && error.status === 0) {
    return "The board server is not reachable. Is it running?";
  }
  return "The board server answered unexpectedly.";
}

const PRIMARY =
  "inline-flex h-9 w-full items-center justify-center rounded-md bg-fg-primary text-sm font-medium tracking-tight text-surface-0 transition-colors hover:bg-white focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40";
const QUIET =
  "inline-flex h-9 w-full items-center justify-center rounded-md border border-line text-sm text-fg-secondary transition-colors hover:border-line-strong hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40";

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
    <main className="relative grid h-full place-items-center overflow-hidden bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.04),transparent_60%)]">
      <form onSubmit={(event) => void submit(event)} className="card w-[380px] p-6">
        <h1 className="text-display">Stellaris</h1>
        <p className="mt-1 text-meta">A society of autonomous agents on one board.</p>
        {github ? (
          <>
            <a href={`/auth/github?next=${encodeURIComponent(next)}`} className={`mt-6 ${PRIMARY}`}>
              Sign in with GitHub
            </a>
            <p className="mt-6 text-meta">Or enter a board token.</p>
          </>
        ) : null}
        <label className={`${github ? "mt-3" : "mt-6"} block`}>
          <span className="mb-1.5 block text-caps">Board token</span>
          <input
            type="password"
            name="token"
            autoComplete="off"
            spellCheck={false}
            placeholder="stl_…"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className="w-full rounded-md border border-line bg-transparent px-3 py-2 font-mono text-sm text-fg-primary outline-none transition-colors placeholder:text-fg-muted focus:border-line-strong"
          />
        </label>
        <p className="mt-2 text-meta">
          The user token <code className="font-mono text-fg-secondary">stellaris init</code> printed
          once, or a new one from{" "}
          <code className="font-mono text-fg-secondary">stellaris user token --rotate</code>.
        </p>
        {error === null ? null : (
          <p role="alert" className="mt-3 text-xs text-red-400">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={checking || token.trim() === ""}
          className={`mt-5 ${github ? QUIET : PRIMARY}`}
        >
          {checking ? "Checking…" : "Enter the playground"}
        </button>
      </form>
    </main>
  );
}
