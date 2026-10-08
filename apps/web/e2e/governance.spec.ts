import { expect, test } from "@playwright/test";
import { fakeBoard, SKILL_PROPOSAL, STAGE_TASK } from "./board.js";

test("approving takes a second click, says what it does, and shows what it made", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);

  await expect(page.getByText("If approved: Publishes refereed-research")).toBeVisible();
  await expect(page.getByRole("region", { name: "Governance" })).toContainText("proposals1");
  // The pitch opened the proposal's thread, shown in its view.
  const thread = page.getByRole("region", { name: "Thread" });
  await expect(thread).toContainText("The plan has run on four tasks.");

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const form = page.getByRole("form", { name: "Approve the proposal" });
  // The decision wakes the proposer, not the front desk.
  await expect(form).toContainText("wakes stew, who proposed it");
  expect(board.writes).toEqual([]);

  await form.getByRole("button", { name: "Confirm approval" }).click();
  await expect(page.getByText("Approved by you")).toBeVisible();
  await expect(thread).toContainText("Approved: skill refereed-research.");
  await expect(page.getByText("Published the society's skill refereed-research.")).toBeVisible();
  expect(board.writes).toEqual([
    { path: "/api/verbs/approve", body: { proposal_id: SKILL_PROPOSAL } },
  ]);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
});

test("signed in with GitHub, the user's posts and names show the account", async ({ page }) => {
  await fakeBoard(page, { github: true });
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("button", { name: "Confirm approval" }).click();
  await expect(page.getByText("Approved by octocat")).toBeVisible();

  const decision = page
    .getByRole("region", { name: "Thread" })
    .getByRole("article")
    .filter({ hasText: "Approved: skill refereed-research." });
  await expect(decision.getByText("octocat", { exact: true })).toBeVisible();
  // The account's picture, at the size the post shows it, in place of the "you" mark.
  const avatar = decision.locator("img");
  await expect(avatar).toHaveAttribute(
    "src",
    "https://avatars.githubusercontent.com/u/583231?v=4&s=56",
  );
  await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  await expect(decision.getByText("you", { exact: true })).toHaveCount(0);
});

test("a rejection needs a reason, which goes with it", async ({ page }) => {
  const board = await fakeBoard(page);
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);

  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const confirm = page.getByRole("button", { name: "Confirm rejection" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Reason for rejecting").fill("Not before the next study.");
  await confirm.click();

  await expect(page.getByText(/^Rejected by you .*: Not before the next study\.$/)).toBeVisible();
  expect(board.writes).toEqual([
    {
      path: "/api/verbs/reject",
      body: { proposal_id: SKILL_PROPOSAL, reason: "Not before the next study." },
    },
  ]);
});

test("the board's refusal is shown in its own words and nothing changes", async ({ page }) => {
  const board = await fakeBoard(page);
  board.refuseNext(`proposal ${SKILL_PROPOSAL} is already provisioned`);
  await page.goto(`/proposal/${SKILL_PROPOSAL}`);

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("button", { name: "Confirm approval" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    `proposal ${SKILL_PROPOSAL} is already provisioned`,
  );
  await expect(page.getByText("If approved:")).toBeVisible();
});

test("the pause switch pauses and resumes the society", async ({ page }) => {
  const board = await fakeBoard(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Paused · resume" })).toBeVisible();
  await page.getByRole("button", { name: "Paused · resume" }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  expect(board.writes.map((write) => write.path)).toEqual(["/api/pause", "/api/resume"]);
});

test("needs you gathers a proposal, a stage that names the user, and a question asked in a thread", async ({
  page,
}) => {
  const board = await fakeBoard(page, { asked: true });
  await page.goto("/");

  await page.getByRole("button", { name: "3 need you" }).click();
  await expect(page).toHaveURL(/\/needs-you$/);
  const view = page.getByRole("region", { name: "Board content" });
  await expect(view.getByRole("link", { name: /^Skill refereed-research/ })).toHaveAttribute(
    "href",
    `/proposal/${SKILL_PROPOSAL}`,
  );
  await expect(view.getByRole("link", { name: /Sign off \(gate\) in Lab/ })).toHaveAttribute(
    "href",
    `/task/${STAGE_TASK}`,
  );

  // A question is answered where it was asked: the task's thread. Answering there settles it.
  await view.getByRole("link", { name: /should the survey cover the 2025 results too/ }).click();
  await expect(page).toHaveURL(new RegExp(`/task/${STAGE_TASK}$`));
  const box = view.getByRole("textbox", { name: "Write in the task's thread" });
  await box.fill("Yes, include 2025.");
  await box.press("Enter");
  await expect(page.getByRole("button", { name: "2 need you" })).toBeVisible();
  expect(board.writes.at(-1)).toEqual({
    path: "/api/verbs/post_message",
    body: { thread_id: STAGE_TASK, body: "Yes, include 2025." },
  });
});
