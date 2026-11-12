import { expect, type Locator, type Page, test } from "@playwright/test";
import { FAILING_CRON, fakeBoard } from "./board.js";

// PROTOTYPE: what must keep working once the HUD's corner holds less and the society's status
// views share one navigator row and a strip of tabs.

function corner(page: Page): Locator {
  return page.locator("header").filter({ has: page.getByRole("button", { name: "Sign out" }) });
}

test("with the board closed the corner holds two icons, Pause and Sign out, whatever waits", async ({
  page,
}) => {
  await fakeBoard(page, { enrolling: true, asked: true });
  await page.goto("/c/general");
  // Wait until what waits has been read, so anything that would show has had its chance.
  await expect(
    page.getByRole("region", { name: "Board navigator" }).getByRole("link", {
      name: "Status, 1 runner waiting for approval, 1 cron failing",
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/");
  // The keyboard's way into the board takes no room until it has focus.
  const door = corner(page).getByRole("button", { name: "Open the board" });
  expect((await door.boundingBox())?.width).toBeLessThanOrEqual(1);
  const shown = await corner(page)
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons
        .filter((button) => button.getBoundingClientRect().width > 1)
        .map((button) => ({
          name: button.getAttribute("aria-label") ?? button.textContent,
          text: button.textContent,
          width: button.getBoundingClientRect().width,
        })),
    );
  expect(shown).toEqual([
    { name: "Pause", text: "", width: 28 },
    { name: "Sign out", text: "", width: 28 },
  ]);
  // Bare icons, as Sign out was bare text: no card behind them or around them.
  await expect(corner(page).locator(".card")).toHaveCount(0);
});

test("status is the first row, above needs you and proposals", async ({ page }) => {
  await fakeBoard(page, { enrolling: true, asked: true });
  await page.goto("/c/general");
  const governance = page.getByRole("region", { name: "Governance" });
  const names = () =>
    governance
      .getByRole("link")
      .evaluateAll((links) =>
        links.map((link) => link.getAttribute("aria-label") ?? link.textContent),
      );
  await expect
    .poll(names)
    .toEqual([
      "Status, 1 runner waiting for approval, 1 cron failing",
      "◉needs you3",
      "◈proposals1",
    ]);
  // Only there: the society's group lists its channels alone.
  await expect(
    page.getByRole("region", { name: "Board navigator" }).getByRole("link", { name: /^Status/ }),
  ).toHaveCount(1);
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

test("a click on the sky opens the board, at general first and then where it was", async ({
  page,
}) => {
  await fakeBoard(page, { enrolling: true });
  await page.goto("/");
  const sky = page.locator("canvas");
  await expect(sky).toBeVisible();
  // Empty sky, left of the spheres and clear of the corner, the camera and the hint.
  await page.mouse.click(120, 500);
  await expect(page).toHaveURL("/c/general");
  await page
    .getByRole("region", { name: "Board navigator" })
    .getByRole("link", { name: /^Status/ })
    .click();
  await page
    .getByRole("navigation", { name: "Status" })
    .getByRole("link", { name: /^Runners/ })
    .click();
  await expect(page).toHaveURL("/runners");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/");
  await page.mouse.click(120, 500);
  await expect(page).toHaveURL("/runners");
  // A drag moves the sky and opens nothing.
  await page.keyboard.press("Escape");
  await page.mouse.move(120, 500);
  await page.mouse.down();
  await page.mouse.move(220, 560, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(page).toHaveURL("/");
});

test("from the keyboard, Tab reaches Open the board after the camera and before the icons", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/");
  await expect(corner(page).getByRole("button", { name: "Sign out" })).toBeVisible();
  const order: string[] = [];
  for (let press = 0; press < 6; press += 1) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate(
        () =>
          document.activeElement?.getAttribute("aria-label") ??
          document.activeElement?.textContent ??
          "",
      ),
    );
  }
  expect(order).toEqual([
    "Zoom in",
    "Zoom out",
    "Fit the whole sky",
    "Open the board",
    "Pause",
    "Sign out",
  ]);
  // Back to the door, which shows while it has focus.
  for (let press = 0; press < 2; press += 1) {
    await page.keyboard.press("Shift+Tab");
  }
  const door = corner(page).getByRole("button", { name: "Open the board" });
  await expect(door).toBeFocused();
  expect((await door.boundingBox())?.width).toBeGreaterThan(40);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/c/general");
  // While the board is open it has its own ✕, so the door goes.
  await expect(door).toHaveCount(0);
});

test("Pause is an icon that turns to Resume, amber, while paused", async ({ page }) => {
  const board = await fakeBoard(page);
  await page.goto("/");
  await corner(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => board.writes.map((write) => write.path)).toContain("/api/pause");
  const resume = corner(page).getByRole("button", { name: "Resume", exact: true });
  await expect(resume).toBeVisible();
  await expect(resume).toHaveClass(/text-amber-300/);
  await expect(resume).toHaveAttribute("title", "Paused: resume");
  await resume.click();
  const pause = corner(page).getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await expect(pause).toHaveAttribute("title", "Pause");
  await expect(pause).not.toHaveClass(/text-amber-300/);
  await expect(corner(page).getByRole("button", { name: "Sign out" })).toHaveAttribute(
    "title",
    "Sign out",
  );
});

test("Sign out signs out", async ({ page }) => {
  await fakeBoard(page);
  await page.goto("/");
  await corner(page).getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Board token")).toBeVisible();
});

test("switching tabs changes the address, and Back and a reload land on the same view", async ({
  page,
}) => {
  await fakeBoard(page, { enrolling: true });
  await page.goto("/runners");
  const tabs = page.getByRole("navigation", { name: "Status" });
  await tabs.getByRole("link", { name: "Crons, 1 failing" }).click();
  await expect(page).toHaveURL("/crons");
  await page.goBack();
  await expect(page).toHaveURL("/runners");
  await expect(tabs.getByRole("link", { name: "Runners, 1 waiting for approval" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Runners", exact: true })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Runners, 1 waiting for approval" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("the views' own options still work under the tabs", async ({ page }) => {
  await fakeBoard(page);
  const view = page.getByRole("region", { name: "Board content" });
  const tabs = page.getByRole("navigation", { name: "Status" });
  await page.goto("/citizens?window=7d");
  await expect(view.getByRole("link", { name: "7d", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(tabs.getByRole("link", { name: /^Citizens/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.goto("/metrics?window=all");
  await expect(view.getByRole("link", { name: "All time" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.goto("/crons?agent=desk");
  await expect(page.getByRole("heading", { name: "Crons of desk" })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Crons, 1 failing" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.goto(`/crons?cron=${FAILING_CRON}`);
  await expect(view.getByText("Run the build and say what broke.")).toBeVisible();
});

test("at the narrowest panel beside the sky every tab keeps its label on one line", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("stellaris.boardLayout", "beside");
    localStorage.setItem("stellaris.contentWidth", "420");
  });
  await fakeBoard(page, { enrolling: true });
  await page.goto("/citizens");
  const strip = page.getByRole("navigation", { name: "Status" });
  await expect(strip.getByRole("link", { name: "Runners, 1 waiting for approval" })).toBeVisible();
  expect(
    await page.getByRole("region", { name: "Board content" }).evaluate((e) => e.clientWidth),
  ).toBe(420);
  const fit = await strip.evaluate((nav) => ({
    overflow: nav.scrollWidth - nav.clientWidth,
    heights: [...nav.querySelectorAll("a")].map((a) => a.getBoundingClientRect().height),
    right: Math.max(...[...nav.querySelectorAll("a")].map((a) => a.getBoundingClientRect().right)),
    end: nav.getBoundingClientRect().right,
  }));
  expect(fit.overflow).toBe(0);
  expect(new Set(fit.heights).size).toBe(1);
  expect(fit.right).toBeLessThanOrEqual(fit.end);
});

test("the way back, if chosen: an amber dot after the society's name while anything waits", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("stellaris.waitingMark", "name"));
  await fakeBoard(page, { enrolling: true, asked: true });
  await page.goto("/");
  // 3 need you, 1 runner to approve, 1 cron failing; read as text, and no button.
  await expect(page.locator("header").getByText("5 waiting in the board")).toBeAttached();
  await expect(page.locator("header").getByTitle("5 waiting in the board")).toBeVisible();
  await expect(page.locator("header").getByRole("button", { name: /waiting/ })).toHaveCount(0);
});

test("with the mark off, nothing follows the society's name", async ({ page }) => {
  await fakeBoard(page, { enrolling: true, asked: true });
  await page.goto("/c/general");
  await expect(
    page.getByRole("region", { name: "Board navigator" }).getByRole("link", { name: /^Status, 1/ }),
  ).toBeVisible();
  await expect(page.locator("header").getByText(/waiting in the board/)).toHaveCount(0);
});
