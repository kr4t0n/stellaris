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
  // An open thread's mark is green, its state is said only to screen readers, and the line ends
  // in when it opened, with no count.
  await expect(open).toHaveText(
    /^you opened topic thread Who reviews the survey\?, open\d+ days ago$/,
  );
  await expect(open.getByTitle("open", { exact: true })).toHaveClass(/text-emerald-400/);
  await expect(open.locator("time")).toHaveAttribute("title", /^opened /);
  // A closed thread's mark stays quiet, and the line ends in when it closed, its summary under it.
  const closed = view.getByRole("link", { name: /Merge the phone projects/ });
  await expect(closed).toContainText(/Merge the phone projects, closed\d+ days ago/);
  await expect(closed.getByTitle("closed", { exact: true })).toHaveClass(/text-fg-muted/);
  await expect(closed.locator("time")).toHaveAttribute("title", /^closed /);
  await expect(closed).toContainText("Filed the merge as a task in lab and proposed archiving");
  await expect(closed).not.toContainText("messages");

  await open.click();
  await expect(page).toHaveURL(new RegExp(`/thread/${ANSWERED_ASK}$`));
  await expect(view).toContainText("ada reviews it.");
});
