import { expect, type Locator, type Page, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

// PROTOTYPE: what must keep working once the HUD's corner holds less and the society's status
// views share one navigator row and a strip of tabs.

function corner(page: Page): Locator {
  return page.locator("header").filter({ has: page.getByRole("button", { name: "Board" }) });
}

test("with the board closed the corner holds only what waits, Pause, Board and Sign out", async ({
  page,
}) => {
  await fakeBoard(page, { enrolling: true, asked: true });
  await page.goto("/");
  const names = () =>
    corner(page)
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
      );
  await expect
    .poll(names)
    .toEqual(["3 need you", "1 runner to approve", "1 cron failing", "Pause", "Board", "Sign out"]);
});

test("one status row opens the first tab, and the tabs open each view by keyboard at its address", async ({
  page,
}) => {
  await fakeBoard(page, { enrolling: true });
  await page.goto("/c/general");
  const navigator = page.getByRole("region", { name: "Board navigator" });
  // One row, whose name says what waits behind its count.
  const row = navigator.getByRole("link", {
    name: "Status, 1 runner waiting for approval, 1 cron failing",
  });
  await expect(row).toContainText("2");
  for (const gone of ["citizens", "runners", "crons", "metrics", "logs"]) {
    await expect(navigator.getByRole("link", { name: gone, exact: true })).toHaveCount(0);
  }
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/citizens");
  await expect(row).toHaveClass(/bg-surface-2\/80/);

  const tabs = page.getByRole("navigation", { name: "Status" });
  for (const [name, address, heading] of [
    ["Runners, 1 waiting for approval", "/runners", "Runners"],
    ["Crons, 1 failing", "/crons", "Crons"],
    ["Metrics", "/metrics", "Metrics"],
    ["Logs", "/logs", "Operations log"],
    [/^Citizens/, "/citizens", "Citizens"],
  ] as const) {
    const tab = tabs.getByRole("link", { name, exact: typeof name === "string" });
    await tab.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(address);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(tab).toHaveAttribute("aria-current", "page");
    await expect(tabs.locator("[aria-current='page']")).toHaveCount(1);
    // The status row stays lit on every tab.
    await expect(row).toHaveClass(/bg-surface-2\/80/);
  }
});

test("each status view opened at its address shows the tabs; others show none", async ({
  page,
}) => {
  await fakeBoard(page);
  for (const address of ["/citizens", "/runners", "/crons", "/metrics", "/logs"]) {
    await page.goto(address);
    await expect(page.getByRole("navigation", { name: "Status" })).toBeVisible();
  }
  await page.goto("/c/general");
  await expect(page.getByRole("link", { name: "general" }).first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Status" })).toHaveCount(0);
});

test("the log reads as it did, and Esc closes the board from it", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/logs");
  const view = page.getByRole("region", { name: "Board content" });
  const gap = view.getByRole("listitem").filter({ hasText: "role gap" });
  await expect(gap).toContainText("a stage in lab waits on the referee role, which nobody fills");
  await expect(gap).toContainText("holds now");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/");
});

test("what waits on the user is one click from the sky, and so is Pause", async ({ page }) => {
  const board = await fakeBoard(page, { enrolling: true, asked: true });
  for (const [chip, address] of [
    ["3 need you", "/needs-you"],
    ["1 runner to approve", "/runners"],
    ["1 cron failing", "/crons"],
  ] as const) {
    await page.goto("/");
    await corner(page).getByRole("button", { name: chip, exact: true }).click();
    await expect(page).toHaveURL(address);
  }
  await page.goto("/");
  await corner(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => board.writes.map((write) => write.path)).toContain("/api/pause");
});

test("Sign out signs out", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/");
  await corner(page).getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Board token")).toBeVisible();
});
