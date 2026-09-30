import { expect, test } from "@playwright/test";
import { ARCHIVE_PROPOSAL, fakeBoard } from "./board.js";

test("an archived project leaves the projects for the navigator's archive and reads only", async ({
  page,
}) => {
  const board = await fakeBoard(page, { archived: true });
  await page.goto("/society");

  // It is listed once, under Archived, and no longer as a project with channels and tasks.
  const archive = page.getByRole("region", { name: "Archived projects" });
  await expect(archive).toContainText("iPhone study");
  await expect(page.getByRole("link", { name: "iPhone study" })).toHaveCount(1);

  await archive.getByRole("link", { name: "iPhone study" }).click();
  await expect(page.getByText(/^Archived .* by user: merged into lab\./)).toBeVisible();
  await expect(page.getByText("· 1 messages")).toBeVisible();

  await page.goto("/c/iphone/general");
  await expect(page.getByText("The findings are on task/")).toBeVisible();
  await expect(
    page.getByText("iPhone study is archived, so its channels are read-only."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "New thread" })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  expect(board.writes).toEqual([]);
});

test("an archive proposal says who leaves and that a task in play holds the project open", async ({
  page,
}) => {
  await fakeBoard(page, { archived: true });
  await page.goto(`/proposal/${ARCHIVE_PROPOSAL}`);

  await expect(page.getByText("If approved: Archives lab: its members leave")).toBeVisible();
  await expect(page.getByText("Members who leave").locator("..")).toContainText("desk");
  await expect(
    page.getByText("1: approval is refused until they are done, abandoned, or filed elsewhere"),
  ).toBeVisible();
});
