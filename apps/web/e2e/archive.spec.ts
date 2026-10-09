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

test("a channel is opened for a workstream from its project's page and archived from its own", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto("/p/lab");
  const view = page.getByRole("region", { name: "Board content" });
  await view.getByRole("button", { name: "New channel…" }).click();
  const form = page.getByRole("form", { name: "New channel" });
  await expect(form).toContainText(
    "Announced in lab's general, where its members choose to follow it;",
  );
  await form.getByRole("textbox", { name: "Channel name" }).fill("release-1");
  await form.getByRole("textbox", { name: "Purpose" }).fill("Release 0.1.0");
  await form.getByRole("button", { name: "Open" }).click();

  // It opens on the new channel, which the navigator lists under its project.
  await expect(page).toHaveURL(/\/c\/lab\/release-1$/);
  await expect(view.getByRole("heading", { name: "# release-1" })).toBeVisible();
  const navigator = page.getByRole("navigation");
  await expect(navigator.getByRole("link", { name: /release-1/ })).toBeVisible();

  // The board's own channels offer no archive; this one does, with a reason.
  await view.getByRole("button", { name: "Archive…" }).click();
  const archive = page.getByRole("form", { name: "Archive the channel" });
  await expect(archive.getByRole("button", { name: "Archive channel" })).toBeDisabled();
  await archive.getByRole("textbox", { name: "Reason" }).fill("0.1.0 shipped");
  await archive.getByRole("button", { name: "Archive channel" }).click();

  await expect(page.getByText(/^Archived .* by user: 0\.1\.0 shipped\./)).toBeVisible();
  await expect(view.getByRole("button", { name: "New thread" })).toHaveCount(0);
  await expect(view.getByRole("textbox")).toHaveCount(0);
  await expect(navigator.getByRole("link", { name: /release-1/ })).toHaveCount(0);
  await page.goto("/c/lab/general");
  await expect(view.getByRole("button", { name: "Archive…" })).toHaveCount(0);

  // Its project's page still lists it, marked archived.
  await page.goto("/p/lab");
  await expect(view.getByText(/# release-1/)).toBeVisible();
  await expect(view.getByText(/archived/)).toBeVisible();
  expect(board.writes).toEqual([
    {
      path: "/api/verbs/create_channel",
      body: { project: "lab", name: "release-1", purpose: "Release 0.1.0" },
    },
    {
      path: "/api/verbs/archive_channel",
      body: { channel: "lab/release-1", reason: "0.1.0 shipped" },
    },
  ]);
});
