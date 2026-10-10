import { expect, test } from "@playwright/test";
import { FAILING_CRON, fakeBoard } from "./board.js";

test("Crons in the top bar counts the failing ones and lists every cron by when it fires", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/");
  const crons = page.getByRole("button", { name: "Crons, 1 failing" });
  await expect(crons).toHaveAttribute("aria-pressed", "false");
  await expect(crons).toContainText("1");
  await crons.click();
  await expect(page).toHaveURL("/crons");
  await expect(page.getByRole("heading", { name: "Crons" })).toBeVisible();
  await expect(page.getByText("2 running · 1 failing · times in UTC")).toBeVisible();

  // The hourly check comes before the weekday digest; the ended one waits, folded, below.
  const running = page.getByRole("list", { name: "Running" }).getByRole("listitem");
  await expect(running).toHaveCount(2);
  await expect(running.nth(0)).toContainText("Check the build");
  await expect(running.nth(0)).toContainText("0 * * * * · Europe/Berlin");
  await expect(running.nth(0)).toContainText("3 failed in a row");
  await expect(running.nth(1)).toContainText("Morning digest");
  await expect(running.nth(1)).toContainText("0 9 * * 1-5 · UTC");
  await expect(running.nth(1)).toContainText("home at the society");
  await expect(running.nth(1)).toContainText("last turn completed");
  await expect(page.getByText("Ended (1)")).toBeVisible();
  await expect(page.getByRole("list", { name: "Ended" })).toBeHidden();

  // Opened, a cron shows its note and where its last turn is.
  await running.nth(1).getByText("Morning digest").click();
  await expect(running.nth(1).getByText("Summarize what changed overnight in")).toBeVisible();
  await expect(running.nth(1).getByRole("link", { name: "Open its last turn" })).toBeVisible();
  await crons.click();
  await expect(page).toHaveURL("/");
});

test("pauses, resumes, and removes a cron, and sets the society's time zone", async ({ page }) => {
  const board = await fakeBoard(page);
  await page.goto("/crons");
  const running = page.getByRole("list", { name: "Running" });
  await running.getByText("Check the build").click();
  await running.getByRole("button", { name: "Pause" }).click();
  const paused = page.getByRole("region", { name: "Paused" });
  await expect(paused).toContainText("Check the build");
  await expect(page.getByText("1 running · 1 paused · 1 failing · times in UTC")).toBeVisible();
  await paused.getByText("Check the build").click();
  await paused.getByRole("button", { name: "Resume" }).click();
  await expect(paused).toBeHidden();

  await running.getByText("Check the build").click();
  await running.getByRole("button", { name: "Remove…" }).click();
  const remove = page.getByRole("form", { name: "Remove Check the build" });
  await expect(remove.getByRole("button", { name: "Remove cron" })).toBeDisabled();
  await remove.getByLabel("Why it ends").fill("the build is green for good");
  await remove.getByRole("button", { name: "Remove cron" }).click();
  await expect(page.getByText("Ended (2)")).toBeVisible();
  // With the failing cron gone, nothing is counted on the top bar's button.
  await expect(page.getByRole("button", { name: "Crons", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Time zone…" }).click();
  const zone = page.getByRole("form", { name: "Time zone" });
  await zone.getByLabel("Society time zone").fill("Asia/Shanghai");
  await zone.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("1 running · times in Asia/Shanghai")).toBeVisible();

  expect(board.writes).toEqual([
    { path: "/api/verbs/update_cron", body: { cron_id: FAILING_CRON, paused: true } },
    { path: "/api/verbs/update_cron", body: { cron_id: FAILING_CRON, paused: false } },
    {
      path: "/api/verbs/remove_cron",
      body: { cron_id: FAILING_CRON, reason: "the build is green for good" },
    },
    { path: "/api/society/timezone", body: { timezone: "Asia/Shanghai" } },
  ]);
});

test("sets a cron for a citizen, saying when it would fire or why it cannot", async ({ page }) => {
  const board = await fakeBoard(page);
  // A citizen's view counts its crons and links to them.
  await page.goto("/citizen/desk");
  await page.getByRole("link", { name: "2 crons" }).click();
  await expect(page).toHaveURL("/crons?agent=desk");
  await expect(page.getByRole("heading", { name: "Crons of desk" })).toBeVisible();

  await page.getByRole("button", { name: "New cron…" }).click();
  const form = page.getByRole("form", { name: "New cron" });
  await expect(form.getByLabel("Citizen")).toHaveValue("desk");
  await expect(form.getByLabel("Where")).toHaveValue("lab");
  await form.getByLabel("Title").fill("Weekly review");
  await form.getByLabel("Note").fill("Look over the week's tasks and post what stalled.");
  await form.getByLabel("Cron expression").fill("*/5 * * * *");
  await expect(form.getByText("a cron fires at most every 15 minutes")).toBeVisible();
  await expect(form.getByRole("button", { name: "Set cron" })).toBeDisabled();
  await form.getByLabel("Cron expression").fill("0 9 * * 1");
  await expect(form.getByText(/^Fires next Monday/)).toBeVisible();
  await form.getByLabel("Its time zone").fill("Europe/Berlin");
  await expect(form.getByText("(Europe/Berlin).")).toBeVisible();
  await form.getByRole("button", { name: "Set cron" }).click();
  await expect(page.getByRole("list", { name: "Running" })).toContainText("Weekly review");

  expect(board.writes).toEqual([
    {
      path: "/api/verbs/create_cron",
      body: {
        agent: "desk",
        title: "Weekly review",
        note: "Look over the week's tasks and post what stalled.",
        project: "lab",
        cron: "0 9 * * 1",
        timezone: "Europe/Berlin",
      },
    },
  ]);
});
