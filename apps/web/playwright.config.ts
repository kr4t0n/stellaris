import { defineConfig, devices } from "@playwright/test";

const PREVIEW_PORT = 4174;
const SOCIETY = /society\.spec\.ts/;

// Two kinds of browser session. Most specs run the built interface against a fake board: every
// /api request is answered by the test, and the preview's proxy points at a closed port so nothing
// can reach a live society. The exit test starts a whole board server of its own on a fresh
// society of scripted citizens, which serves the interface itself; build the server before it.
export default defineConfig({
  testDir: "e2e",
  forbidOnly: process.env["CI"] !== undefined,
  reporter: process.env["CI"] === undefined ? "list" : "github",
  use: {
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: SOCIETY,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PREVIEW_PORT}` },
    },
    { name: "society", testMatch: SOCIETY, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `vite preview --port ${PREVIEW_PORT} --strictPort`,
    url: `http://127.0.0.1:${PREVIEW_PORT}`,
    env: { STELLARIS_BOARD_URL: "http://127.0.0.1:9" },
    reuseExistingServer: false,
  },
});
