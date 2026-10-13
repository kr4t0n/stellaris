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

test("Working now keeps one height however many citizens are in a turn, so the navigator under it stays put", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const board = await fakeBoard(page);
  await page.goto("/c/general");
  const navigator = page.getByRole("region", { name: "Board navigator" });
  const section = navigator.getByRole("region", { name: "Working now" });
  const heading = section.getByRole("heading");
  const rows = section.getByRole("listitem");
  const below = navigator.getByRole("link", { name: /^needs you/ });
  const place = async () => ({
    height: (await section.boundingBox())?.height,
    below: (await below.boundingBox())?.y,
  });
  // Whether a row shows whole inside the section, under its heading, and this far from its edges.
  const shown = async (row: number, inset = 0) => {
    const [box, top, item] = await Promise.all([
      section.boundingBox(),
      heading.boundingBox(),
      rows.nth(row).boundingBox(),
    ]);
    if (box === null || top === null || item === null) {
      throw new Error("the section is not on the page");
    }
    return (
      item.y >= top.y + top.height + inset &&
      item.y + item.height <= box.y + box.height - inset + 0.5
    );
  };

  await expect(section.getByText("Nobody is in a turn.")).toBeVisible();
  const idle = await place();
  for (const count of [1, 4, 7]) {
    board.setWorking(count, 2);
    await expect(rows).toHaveCount(count, { timeout: 10_000 });
    expect(await place(), `${count} in a turn`).toEqual(idle);
  }

  // Seven rows overflow four rows' room: the heading counts them, and the rest scroll into view.
  await expect(heading).toHaveText(/7 running · 2 queued$/);
  expect(await shown(3)).toBe(true);
  expect(await shown(4)).toBe(false);
  await rows.first().hover();
  await page.mouse.wheel(0, 1_000);
  await expect.poll(() => shown(6)).toBe(true);
  await page.mouse.wheel(0, -1_000);
  await expect.poll(() => shown(0)).toBe(true);
  // Tab brings each row into view clear of the fading edges, as far as the last one.
  await rows.first().getByRole("link").focus();
  for (let row = 1; row < 7; row += 1) {
    await page.keyboard.press("Tab");
    await expect(rows.nth(row).getByRole("link")).toBeFocused();
    await expect.poll(() => shown(row, row < 6 ? 16 : 0)).toBe(true);
  }
  expect(await place()).toEqual(idle);

  board.setWorking(4);
  await expect(rows).toHaveCount(4, { timeout: 10_000 });
  await expect(heading).toHaveText(/^Working now$/);
  board.setWorking(0);
  await expect(section.getByText("Nobody is in a turn.")).toBeVisible({ timeout: 10_000 });
  expect(await place()).toEqual(idle);
});
