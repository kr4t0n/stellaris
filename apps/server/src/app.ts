import { Hono } from "hono";

export interface AppDependencies {
  readonly version: string;
}

/** The HTTP surface of the board server. Verbs, SSE, and the MCP endpoint mount here in Phase 1. */
export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, version: deps.version }));
  return app;
}
