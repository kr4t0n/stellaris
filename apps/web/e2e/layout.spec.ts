import { expect, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

test("the board's content widens by its edge, stays so in this browser, and a double-click widens it all the way", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fakeBoard(page);
  await page.goto("/c/general");
  const content = page.getByRole("region", { name: "Board content" });
  const handle = page.getByRole("button", { name: /^Width of the board's content/ });
  const width = async () => (await content.boundingBox())?.width ?? 0;
  expect(await width()).toBe(576);

  // Dragging the edge 200 pixels to the left widens the island by as much.
  const edge = await handle.boundingBox();
  if (edge === null) {
    throw new Error("the edge is not on the page");
  }
  const y = edge.y + edge.height / 2;
  await page.mouse.move(edge.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(edge.x - 100, y);
  await page.mouse.move(edge.x - 196, y);
  await page.mouse.up();
  expect(await width()).toBe(776);

  await page.reload();
  await expect(content).toBeVisible();
  expect(await width()).toBe(776);

  // As wide as it goes is up to the navigator; again, and it is back to the default.
  await handle.dblclick();
  expect(await width()).toBe(1440 - 256 - 48);
  await handle.dblclick();
  expect(await width()).toBe(576);

  // The keyboard moves the edge a step at a time, and Enter widens it all the way.
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  expect(await width()).toBe(608);
  await page.keyboard.press("Enter");
  expect(await width()).toBe(1136);
});
