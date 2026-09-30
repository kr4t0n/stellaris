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
