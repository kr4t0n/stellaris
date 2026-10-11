import { expect, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

test("a channel shows knowledge notes as quiet lines, a run on one topic as one, apart from the talk", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/c/lab/general");

  const view = page.getByRole("region", { name: "Board content" });
  await expect(view).toContainText("Seeds are fixed at 42 from now on.");
  await expect(view).toContainText("Thanks, the harness reads it.");
  // A topic written and then updated twice folds into one line, whoever wrote it.
  await expect(view).toContainText(
    "ada and ref wrote knowledge experiments · then updated it 2 times",
  );
  await expect(view.getByRole("link", { name: "experiments" })).toHaveAttribute(
    "href",
    "/knowledge/lab/experiments",
  );
  // A removed topic has no page to open.
  await expect(view).toContainText("ref removed knowledge old-harness");
  await expect(view.getByRole("link", { name: "old-harness" })).toHaveCount(0);
  await expect(view).not.toContainText("It is under knowledge/");

  await view.getByRole("link", { name: "experiments" }).click();
  await expect(page).toHaveURL("/knowledge/lab/experiments");
  await expect(view).toContainText("Every run fixes its seed at 42.");
});
