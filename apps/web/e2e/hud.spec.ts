import { expect, type Locator, type Page, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

/** The HUD: the header that holds the controls, sign-out among them. */
function hud(page: Page): Locator {
  return page
    .locator("header")
    .filter({ has: page.getByRole("button", { name: "Sign out", exact: true }) });
}

async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("the element is not on the page");
  }
  return box;
}

test("the HUD's corner shows the app's icon, loaded, with the society's name beside it", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/");

  // The icon says what the word said, and its picture loaded.
  const icon = hud(page).getByRole("img", { name: "Stellaris", exact: true });
  await expect(icon).toBeVisible();
  await expect
    .poll(() => icon.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);

  // The society's name follows it on one line, both on the controls' centre line.
  const corner = icon.locator("..");
  await expect(corner).toHaveText("fixture");
  const name = corner.getByText("fixture", { exact: true });
  const [iconBox, nameBox, pauseBox] = await Promise.all([
    boxOf(icon),
    boxOf(name),
    boxOf(hud(page).getByRole("button", { name: "Pause", exact: true })),
  ]);
  expect(iconBox.width).toBe(28);
  expect(iconBox.height).toBe(28);
  expect(nameBox.x).toBeGreaterThan(iconBox.x + iconBox.width);
  expect(iconBox.y + iconBox.height / 2).toBe(pauseBox.y + pauseBox.height / 2);
  expect(nameBox.y + nameBox.height / 2).toBe(pauseBox.y + pauseBox.height / 2);
});

test("the HUD no longer spells out the word Stellaris", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/");
  await expect(hud(page).getByText("fixture", { exact: true })).toBeVisible();
  await expect(hud(page).getByText("Stellaris")).toHaveCount(0);
});

test("in a narrow window the icon keeps its size and the name stays clear of the controls", async ({
  page,
}) => {
  // Half of a 1280 px screen, where the header runs out of room and its blocks shrink.
  await page.setViewportSize({ width: 640, height: 900 });
  await fakeBoard(page);
  await page.goto("/");
  const name = hud(page).getByText("fixture", { exact: true });
  await expect(name).toBeVisible();

  const [iconBox, nameBox, firstControl] = await Promise.all([
    boxOf(hud(page).getByRole("img", { name: "Stellaris", exact: true })),
    boxOf(name),
    boxOf(hud(page).getByRole("button").first()),
  ]);
  expect(iconBox.width).toBe(28);
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(firstControl.x);
});
