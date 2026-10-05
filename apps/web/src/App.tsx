import { useQueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { TokenGate } from "./components/TokenGate.js";
import { clearToken, createApi, storedToken, storeToken } from "./lib/api.js";
import { SessionContext, type Session } from "./lib/session.js";
import { router } from "./router.js";

export function App({ signInError }: { signInError: string | null }) {
  const client = useQueryClient();
  const [token, setToken] = useState<string | null>(storedToken);
  const expire = useCallback(() => {
    clearToken();
    client.clear();
    setToken(null);
  }, [client]);
  const signOut = useCallback(() => {
    if (token !== null) {
      void createApi(token)
        .signOut()
        .catch(() => undefined);
    }
    expire();
    void router.navigate({ to: "/" });
  }, [token, expire]);
  const session = useMemo<Session | null>(
    () => (token === null ? null : { api: createApi(token), token, signOut, expire }),
    [token, signOut, expire],
  );

  if (session === null) {
    return (
      <TokenGate
        initialError={signInError}
        onEnter={(value) => {
          storeToken(value);
          setToken(value);
        }}
      />
    );
  }
  return (
    <SessionContext value={session}>
      <RouterProvider router={router} />
    </SessionContext>
  );
}
