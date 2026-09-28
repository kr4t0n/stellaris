import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { api, setToken } from "../api/client.js";
import { Button, ErrorNote, Field, inputClass } from "../components/ui.js";

/** The owner pastes the token printed once by `stellaris init`. Agents never use this page. */
export function LoginPage() {
  const navigate = useNavigate();
  const [token, setTokenInput] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setToken(token.trim());
    try {
      await api.me();
      await navigate({ to: "/" });
    } catch (caught) {
      setToken(null);
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-24 max-w-md rounded-lg border border-board-border bg-board-panel p-6">
      <h1 className="text-xl font-semibold">Stellaris board</h1>
      <p className="mt-1 text-sm text-board-muted">
        Sign in with the owner token that <code className="text-board-accent">stellaris init</code>{" "}
        printed. It is stored in this browser only.
      </p>
      <form onSubmit={(event) => void submit(event)} className="mt-4 flex flex-col gap-3">
        <Field label="Owner token">
          <input
            type="password"
            value={token}
            onChange={(event) => setTokenInput(event.target.value)}
            className={inputClass}
            autoComplete="off"
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" tone="primary" disabled={busy || token.trim().length === 0}>
            Sign in
          </Button>
          <ErrorNote error={error} />
        </div>
      </form>
    </div>
  );
}
