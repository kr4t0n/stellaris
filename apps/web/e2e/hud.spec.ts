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
  const name = corner.getByText("fixture", { exact: true });
  await expect(name).toBeVisible();
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
    boxOf(hud(page).getByRole("button", { name: "Pause", exact: true })),
  ]);
  expect(iconBox.width).toBe(28);
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(firstControl.x);
});

test("with the board closed the corner holds two icons, Pause and Sign out, whatever waits", async ({
  page,
}) => {
  await fakeBoard(page, { enrolling: true, asked: true });
  await page.goto("/c/general");
  // Wait until what waits has been read, so anything that would show has had its chance.
  await expect(
    page.getByRole("region", { name: "Board navigator" }).getByRole("link", {
      name: "Status, 1 runner waiting for approval, 1 cron failing",
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/");
  // The keyboard's way into the board takes no room until it has focus.
  const door = hud(page).getByRole("button", { name: "Open the board" });
  expect((await door.boundingBox())?.width).toBeLessThanOrEqual(1);
  const shown = await hud(page)
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons
        .filter((button) => button.getBoundingClientRect().width > 1)
        .map((button) => ({
          name: button.getAttribute("aria-label") ?? button.textContent,
          text: button.textContent,
          width: button.getBoundingClientRect().width,
        })),
    );
  expect(shown).toEqual([
    { name: "Pause", text: "", width: 28 },
    { name: "Sign out", text: "", width: 28 },
  ]);
  // The icons stand bare on the sky: nothing in the corner draws a card.
  await expect(hud(page).locator(".card")).toHaveCount(0);
});

test("a click on the sky opens the board, at general first and then where it was", async ({
  page,
}) => {
  await fakeBoard(page, { enrolling: true });
  await page.goto("/");
  const sky = page.locator("canvas");
  await expect(sky).toBeVisible();
  // Empty sky, left of the spheres and clear of the corner, the camera and the hint.
  await page.mouse.click(120, 500);
  await expect(page).toHaveURL("/c/general");
  await page
    .getByRole("region", { name: "Board navigator" })
    .getByRole("link", { name: /^Status/ })
    .click();
  await page
    .getByRole("navigation", { name: "Status" })
    .getByRole("link", { name: /^Runners/ })
    .click();
  await expect(page).toHaveURL("/runners");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/");
  await page.mouse.click(120, 500);
  await expect(page).toHaveURL("/runners");
  // A drag moves the sky and opens nothing.
  await page.keyboard.press("Escape");
  await page.mouse.move(120, 500);
  await page.mouse.down();
  await page.mouse.move(220, 560, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(page).toHaveURL("/");
});

test("from the keyboard, Tab reaches Open the board after the camera and before the icons", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/");
  await expect(hud(page).getByRole("button", { name: "Sign out" })).toBeVisible();
  const order: string[] = [];
  for (let press = 0; press < 6; press += 1) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate(
        () =>
          document.activeElement?.getAttribute("aria-label") ??
          document.activeElement?.textContent ??
          "",
      ),
    );
  }
  expect(order).toEqual([
    "Zoom in",
    "Zoom out",
    "Fit the whole sky",
    "Open the board",
    "Pause",
    "Sign out",
  ]);
  // Back to the door, which shows while it has focus.
  for (let press = 0; press < 2; press += 1) {
    await page.keyboard.press("Shift+Tab");
  }
  const door = hud(page).getByRole("button", { name: "Open the board" });
  await expect(door).toBeFocused();
  expect((await door.boundingBox())?.width).toBeGreaterThan(40);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/c/general");
  // While the board is open it has its own ✕, so the door goes.
  await expect(door).toHaveCount(0);
});

test("Pause is an icon that turns to Resume, amber, while paused", async ({ page }) => {
  const board = await fakeBoard(page);
  await page.goto("/");
  await hud(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => board.writes.map((write) => write.path)).toContain("/api/pause");
  const resume = hud(page).getByRole("button", { name: "Resume", exact: true });
  await expect(resume).toBeVisible();
  await expect(resume).toHaveClass(/text-amber-300/);
  await expect(resume).toHaveAttribute("title", "Paused: resume");
  await resume.click();
  const pause = hud(page).getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await expect(pause).toHaveAttribute("title", "Pause");
  await expect(pause).not.toHaveClass(/text-amber-300/);
  await expect(hud(page).getByRole("button", { name: "Sign out" })).toHaveAttribute(
    "title",
    "Sign out",
  );
});

test("Sign out signs out", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/");
  await hud(page).getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Board token")).toBeVisible();
});

test("an amber dot follows the society's name while anything waits, read as how many, and no button", async ({
  page,
}) => {
  await fakeBoard(page, { enrolling: true, asked: true });
  await page.goto("/");
  // 3 need you, 1 runner to approve, 1 cron failing.
  await expect(hud(page).getByText("5 waiting in the board")).toBeAttached();
  await expect(hud(page).getByTitle("5 waiting in the board")).toBeVisible();
  await expect(hud(page).getByRole("button", { name: /waiting/ })).toHaveCount(0);
});

test("with nothing waiting, nothing follows the society's name", async ({ page }) => {
  await fakeBoard(page);
  for (const read of ["requests", "proposals", "crons", "projects/*/tasks"]) {
    await page.route(`**/api/${read}`, (route) => route.fulfill({ json: [] }));
  }
  await page.goto("/c/general");
  await expect(
    page
      .getByRole("region", { name: "Board navigator" })
      .getByRole("link", { name: "Status", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hud(page).getByText("fixture", { exact: true })).toBeVisible();
  await expect(hud(page).getByText(/waiting in the board/)).toHaveCount(0);
});
