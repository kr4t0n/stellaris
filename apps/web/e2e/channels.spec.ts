import { expect, test } from "@playwright/test";
import { fakeBoard, STAGE_TASK } from "./board.js";

test("a channel's back arrow returns to the project it was opened from, and a thread's to the channel", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/p/lab");
  const view = page.getByRole("region", { name: "Board content" });

  await view.getByRole("link", { name: "# general", exact: true }).click();
  await expect(page).toHaveURL("/c/lab/general");
  await view.getByRole("link", { name: /opened task thread Compare shortest-path/ }).click();
  await expect(page).toHaveURL(`/thread/${STAGE_TASK}`);

  await view.getByRole("button", { name: "Back to #general", exact: true }).click();
  await expect(page).toHaveURL("/c/lab/general");
  await view.getByRole("button", { name: "Back to Lab", exact: true }).click();
  await expect(page).toHaveURL("/p/lab");
});

test("a channel opened as a tab's first view goes up to its project, or to the society", async ({
  page,
}) => {
  await fakeBoard(page);
  const view = page.getByRole("region", { name: "Board content" });

  await page.goto("/c/lab/general");
  // It stays while a form under the header is open.
  await view.getByRole("button", { name: "New thread" }).click();
  await expect(view.getByRole("textbox", { name: "Thread title" })).toBeVisible();
  await view.getByRole("link", { name: "Back to Lab", exact: true }).click();
  await expect(page).toHaveURL("/p/lab");

  // An address loaded anew starts the tab's history over, as a link opened in a new tab does.
  await page.goto("/c/general");
  await view.getByRole("link", { name: "Back to the society", exact: true }).click();
  await expect(page).toHaveURL("/society");
});
