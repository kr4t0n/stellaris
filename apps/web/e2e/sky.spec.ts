import { expect, test } from "@playwright/test";
import { fakeBoard, STAGE_TASK } from "./board.js";

test("a task in play is a mark in the sky whose card says where it stands", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/");

  // The keyboard mirror of the sky lists the marks; focusing one shows its card.
  const mark = page.getByRole("button", { name: /^Task Compare shortest-path algorithms/ });
  await expect(mark).toHaveAccessibleName("Task Compare shortest-path algorithms, waiting at Lab");
  await mark.focus();
  const card = page.getByRole("article", { name: "Task Compare shortest-path algorithms" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("waiting for a holder");
  await expect(card).toContainText("Sign off");
  await expect(card).toContainText("Waiting foruser");

  await mark.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/task/${STAGE_TASK}$`));
});

test("dragging the sky moves it without opening what the drag began on", async ({ page }) => {
  // Without motion the camera lands at once, so the last click finds the sky where home puts it
  // rather than wherever the ease back has got to.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fakeBoard(page);
  await page.goto("/");
  const sky = page.locator("canvas");
  await expect(page.getByRole("group", { name: "Camera" })).toBeVisible();
  const box = await sky.boundingBox();
  if (box === null) throw new Error("the sky is not drawn");

  // The core sits in the middle with desk's seat, the first, at its center: a plain click there
  // opens desk, and a drag that begins on it opens nothing.
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 120, center.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Fit the whole sky" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.mouse.click(center.x, center.y);
  await expect(page).toHaveURL(/\/citizen\/desk$/);
});
