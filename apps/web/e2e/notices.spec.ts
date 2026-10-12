import { expect, test } from "@playwright/test";
import { ANSWERED_ASK, fakeBoard } from "./board.js";

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

test("a channel shows each thread where it was opened as one quiet line that opens it", async ({
  page,
}) => {
  await fakeBoard(page, { asks: true });
  await page.goto("/c/asks");

  const view = page.getByRole("region", { name: "Board content" });
  const open = view.getByRole("link", { name: /Who reviews the survey\?/ });
  await expect(open).toContainText("you opened topic thread");
  await expect(open).toContainText("2 messages · open");
  // A closed thread says so and carries its summary under it.
  const closed = view.getByRole("link", { name: /Merge the phone projects/ });
  await expect(closed).toContainText("2 messages · closed");
  await expect(closed).toContainText("Filed the merge as a task in lab and proposed archiving");

  await open.click();
  await expect(page).toHaveURL(new RegExp(`/thread/${ANSWERED_ASK}$`));
  await expect(view).toContainText("ada reviews it.");
});
