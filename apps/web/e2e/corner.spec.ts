import { expect, type Locator, type Page, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

// PROTOTYPE: what must keep working once the HUD's corner holds less.

function corner(page: Page): Locator {
  return page.locator("header").filter({ has: page.getByRole("button", { name: "Board" }) });
}

async function useMenu(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("stellaris.cornerForm", "menu"));
}

for (const form of ["plain", "menu"] as const) {
  test(`${form}: with the board closed the corner holds only what waits, Pause, Board and the way out`, async ({
    page,
  }) => {
    if (form === "menu") {
      await useMenu(page);
    }
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
      .toEqual([
        "3 need you",
        "1 runner to approve",
        "1 cron failing",
        "Pause",
        "Board",
        form === "menu" ? "More" : "Sign out",
      ]);
  });

  test(`${form}: each view the corner opened opens from the navigator by keyboard, at its old address`, async ({
    page,
  }) => {
    if (form === "menu") {
      await useMenu(page);
    }
    await fakeBoard(page, { enrolling: true });
    await page.goto("/c/general");
    const navigator = page.getByRole("region", { name: "Board navigator" });
    for (const [name, address, heading] of [
      [/^citizens/, "/citizens", "Citizens"],
      ["Runners, 1 waiting for approval", "/runners", "Runners"],
      ["Crons, 1 failing", "/crons", "Crons"],
      ["metrics", "/metrics", "Metrics"],
    ] as const) {
      const link = navigator.getByRole("link", { name, exact: typeof name === "string" });
      await link.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(address);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(link).toHaveClass(/bg-surface-2\/80/);
    }
    // The amber counts read as the corner's buttons did.
    await expect(
      navigator.getByRole("link", { name: "Runners, 1 waiting for approval" }),
    ).toContainText("1");
    await expect(navigator.getByRole("link", { name: "Crons, 1 failing" })).toContainText("1");
  });

  test(`${form}: what waits on the user is one click from the sky, and so is Pause`, async ({
    page,
  }) => {
    if (form === "menu") {
      await useMenu(page);
    }
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
}

test("plain: the log floats from the navigator's row, and Esc closes it before the board", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/c/general");
  const row = page
    .getByRole("region", { name: "Board navigator" })
    .getByRole("button", { name: "logs" });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("region", { name: "Operations log" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Operations log" })).toHaveCount(0);
  await expect(page).toHaveURL("/c/general");
});

test("plain: Sign out signs out", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/");
  await corner(page).getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Board token")).toBeVisible();
});

test("menu: ⋯ opens Logs and Sign out from the keyboard, and Esc closes the menu alone", async ({
  page,
}) => {
  await useMenu(page);
  await fakeBoard(page);
  await page.goto("/c/general");
  const more = corner(page).getByRole("button", { name: "More" });
  await more.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "More" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemcheckbox", { name: "Logs" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Sign out" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(page).toHaveURL("/c/general");

  // Logs floats the log over the board, from the sky too.
  await page.goto("/");
  await corner(page).getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Logs" }).click();
  await expect(page.getByRole("region", { name: "Operations log" })).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);

  await corner(page).getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByLabel("Board token")).toBeVisible();
});
