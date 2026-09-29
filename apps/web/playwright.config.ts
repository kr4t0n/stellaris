import { defineConfig, devices } from "@playwright/test";

const PORT = 4174;

// The built interface in a real browser against a fake board: every /api request is answered by
// the test, and the preview's proxy points at a closed port so nothing can reach a live society.
export default defineConfig({
  testDir: "e2e",
  forbidOnly: process.env["CI"] !== undefined,
  reporter: process.env["CI"] === undefined ? "list" : "github",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `vite preview --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    env: { STELLARIS_BOARD_URL: "http://127.0.0.1:9" },
    reuseExistingServer: false,
  },
});
