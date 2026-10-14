import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // On a loaded machine, git-heavy tests run past Vitest's 5 s default.
    testTimeout: 30_000,
  },
});
