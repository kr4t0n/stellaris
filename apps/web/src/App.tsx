import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { TokenGate } from "./components/TokenGate.js";
import { clearToken, storedToken, storeToken } from "./lib/api.js";
import { Playground } from "./Playground.js";

export function App() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(storedToken);
  const signOut = useCallback(() => {
    clearToken();
    queryClient.clear();
    setToken(null);
  }, [queryClient]);

  if (token === null) {
    return (
      <TokenGate
        onEnter={(value) => {
          storeToken(value);
          setToken(value);
        }}
      />
    );
  }
  return <Playground token={token} onSignOut={signOut} />;
}
