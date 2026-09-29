import path from "node:path";
import { startScriptedServer } from "../apps/server/dist/testing/e2e-server.js";

const PORT = 4799;

/** Starts one scripted board server for the whole session and hands its address to the tests. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = await startScriptedServer({
    port: PORT,
    staticDir: path.resolve(import.meta.dirname, "../apps/ui/dist"),
  });
  process.env["E2E_URL"] = server.url;
  process.env["E2E_TOKEN"] = server.ownerToken;
  return async () => {
    await server.stop();
  };
}
