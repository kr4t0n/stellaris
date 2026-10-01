import { expect, test } from "@playwright/test";
import { fakeBoard, STAGE_TASK } from "./board.js";

test("the metrics open from the society in the navigator, and the window is part of the address", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/c/general");
  await page.getByRole("link", { name: "metrics" }).click();
  await expect(page).toHaveURL(/\/metrics$/);
  const view = page.getByRole("region", { name: "Board content" });
  await expect(view.getByRole("heading", { name: "Metrics" })).toBeVisible();

  // Each measure leads with its headline and breaks it down.
  await expect(view).toContainText("3 of 12 turns changed nothing on the board 25%");
  await expect(view).toContainText("1 turn kept no transcript and could not be counted.");
  const woken = view.getByRole("table", { name: "By what woke them" });
  await expect(woken.getByRole("row", { name: /a heartbeat/ })).toContainText("4375%");
  await expect(woken.getByRole("row", { name: /a stage to take/ })).not.toContainText("%");
  await expect(view).toContainText("1 of 2 finished tasks were sent back, 1 time in all");
  await expect(view).toContainText("4.5 posts a task, across 2 finished tasks");
  await expect(view).toContainText(
    "30s from a mention to its turn, at the median; the slowest took 1m",
  );
  await expect(view).toContainText("1 mention has no turn yet.");
  await expect(view).toContainText("2 decisions, about 0.3 a day");
  await expect(view).toContainText("needs gpu and no connected runner offers it");
  await expect(view).toContainText("blocked now");

  // A task in a breakdown opens the task; the window switch keeps the view at its own address.
  const busiest = view.getByRole("table", { name: "Most talked-over tasks" });
  await expect(
    busiest.getByRole("link", { name: "Compare shortest-path algorithms" }),
  ).toHaveAttribute("href", `/task/${STAGE_TASK}`);
  await view.getByRole("link", { name: "All time" }).click();
  await expect(page).toHaveURL(/\/metrics\?window=all$/);
  await expect(view.getByRole("link", { name: "All time" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(view).toContainText("5 decisions, about 2.5 a day");
  await page.reload();
  await expect(view).toContainText("5 decisions");
});
