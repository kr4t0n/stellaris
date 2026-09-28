import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("board server", () => {
  it("answers the health check", async () => {
    const response = await createApp({ version: "test" }).request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: "test" });
  });
});
