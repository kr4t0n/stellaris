import { useQueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { TokenGate } from "./components/TokenGate.js";
import { clearToken, createApi, storedToken, storeToken } from "./lib/api.js";
import { SessionContext, type Session } from "./lib/session.js";
import { router } from "./router.js";

export function App() {
  const client = useQueryClient();
  const [token, setToken] = useState<string | null>(storedToken);
  const signOut = useCallback(() => {
    clearToken();
    client.clear();
    setToken(null);
    void router.navigate({ to: "/" });
  }, [client]);
  const session = useMemo<Session | null>(
    () => (token === null ? null : { api: createApi(token), token, signOut }),
    [token, signOut],
  );

  if (session === null) {
    return (
      <TokenGate
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
