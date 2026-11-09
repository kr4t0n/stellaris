import { defineConfig, devices } from "@playwright/test";

const PREVIEW_PORT = 4174;
const SOCIETY = /society\.spec\.ts/;
const SCALE = /scale\.spec\.ts/;

// Two kinds of browser session. Most specs run the built interface against a fake board: every
// /api request is answered by the test, and the preview's proxy points at a closed port so nothing
// can reach a live society; one of them, in its own project, at a real device scale. The exit test
// starts a whole board server of its own on a fresh society of scripted citizens, which serves the
// interface itself; build the server before it.
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
      testIgnore: [SOCIETY, SCALE],
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PREVIEW_PORT}` },
    },
    // Chromium at a real device scale of 2, which lays text out in device pixels. Playwright's
    // deviceScaleFactor keeps CSS pixels, and a device descriptor's refuses the null viewport the
    // window's own scale needs.
    {
      name: "scale",
      testMatch: SCALE,
      use: {
        baseURL: `http://127.0.0.1:${PREVIEW_PORT}`,
        viewport: null,
        launchOptions: { args: ["--force-device-scale-factor=2", "--window-size=1600,1000"] },
      },
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
