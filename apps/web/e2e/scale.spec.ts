import { expect, test } from "@playwright/test";
import { drawnCount, navigatorWithDots } from "./counts.js";

// Run by the `scale` project, whose Chromium draws at a real device scale of 2, laying text out in
// device pixels as Playwright's own deviceScaleFactor, which keeps CSS pixels, does not.

test("at a device scale of 2, a channel's dot for unseen posts is drawn level with its count's digits", async ({
  page,
}) => {
  const navigator = await navigatorWithDots(page);
  expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
  const drawn = await drawnCount(page, navigator.locator('a[href="/c/lab/general"]'), 2);
  // Centred on the row, the dot is drawn a whole device pixel below the digits here. Half a device
  // pixel is left for a shape of odd height.
  expect(
    Math.abs((drawn.green ?? Infinity) - drawn.digits),
    JSON.stringify(drawn),
  ).toBeLessThanOrEqual(0.5);
});
