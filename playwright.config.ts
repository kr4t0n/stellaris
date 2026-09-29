import { defineConfig } from "@playwright/test";

/**
 * The browser session that closes the Phase 7 exit criterion: a real Chromium against a real board
 * server whose only stand-in is the scripted backend. Run `pnpm build && pnpm build:ui` first;
 * the global setup serves the built UI from disk.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  outputDir: "./e2e/output/results",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] === undefined ? 0 : 1,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["github"]],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      // Software WebGL, so the world renders on a machine without a GPU, which CI is.
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
