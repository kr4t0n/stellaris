import { expect, test } from "@playwright/test";
import { fakeBoard, STAGE_TASK } from "./board.js";

test("a path a citizen wrote through a task's worktree opens the file from the task's branch", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);

  const view = page.getByRole("region", { name: "Board content" });
  const thread = view.getByRole("region", { name: "Thread" });
  // A path on another machine reads as text, since nothing on the board can open it.
  await expect(thread).toContainText("my scratch notes are in notes.");
  await expect(thread.getByRole("link", { name: "notes" })).toHaveCount(0);

  const report = thread.getByRole("link", { name: "report.md" });
  await expect(report).toHaveAttribute("href", `/task/${STAGE_TASK}/files/docs/report.md`);
  await report.click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}/files/docs/report.md`);
  await expect(view.getByRole("heading", { name: "report.md" })).toBeVisible();
  await expect(view).toContainText("committed by ada");
  await expect(view).toContainText("4f2a9c1");
  await expect(view).toContainText("Dijkstra wins on sparse graphs.");
  // The report's figure sits beside it on the branch and shows in place.
  const figure = view.getByRole("img", { name: "Runtime by graph size" });
  await expect(figure).toBeVisible();
  await expect.poll(() => figure.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);

  await view.getByRole("link", { name: "the table" }).click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}/files/results.csv`);
  await expect(view.getByRole("columnheader", { name: "method" })).toBeVisible();
  await expect(view.getByRole("cell", { name: "A*, tuned" })).toBeVisible();
  await expect(view.getByRole("link", { name: "Download" })).toHaveAttribute(
    "download",
    "results.csv",
  );

  await view.getByRole("navigation", { name: "Path" }).getByRole("link", { name: "Files" }).click();
  await expect(view.getByRole("link", { name: "docs/" })).toBeVisible();
  await expect(view.getByRole("link", { name: "results.csv" })).toBeVisible();

  await page.goto(`/task/${STAGE_TASK}/files/draft.md`);
  await expect(view).toContainText(`draft.md is not on task/${STAGE_TASK} yet`);
  await view.getByRole("link", { name: /Back to the task/ }).click();
  await expect(page).toHaveURL(`/task/${STAGE_TASK}`);
});
