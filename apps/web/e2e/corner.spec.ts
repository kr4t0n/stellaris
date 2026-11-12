import { expect, type Locator, type Page, test } from "@playwright/test";
import { FAILING_CRON, fakeBoard } from "./board.js";

// PROTOTYPE: what must keep working once the HUD's corner holds less and the society's status
// views share one navigator row and a strip of tabs.

function corner(page: Page): Locator {
  return page.locator("header").filter({ has: page.getByRole("button", { name: "Board" }) });
}

test("with the board closed the corner holds Pause, Board and Sign out, whatever waits", async ({
  page,
}) => {
  await fakeBoard(page, { enrolling: true, asked: true });
  await page.goto("/");
  // Wait until what waits has been read, so a chip that would show has had its chance.
  await page.getByRole("button", { name: "Board" }).click();
  await expect(
    page.getByRole("region", { name: "Board navigator" }).getByRole("link", {
      name: "Status, 1 runner waiting for approval, 1 cron failing",
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/");
  const names = await corner(page)
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
    );
  expect(names).toEqual(["Pause", "Board", "Sign out"]);
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

test("what waits on the user is two clicks from the sky, Board then its row; Pause is one", async ({
  page,
}) => {
  const board = await fakeBoard(page, { enrolling: true, asked: true });
  const navigator = page.getByRole("region", { name: "Board navigator" });
  for (const [row, address] of [
    [/^needs you/, "/needs-you"],
    ["Status, 1 runner waiting for approval, 1 cron failing", "/citizens"],
  ] as const) {
    await page.goto("/");
    await corner(page).getByRole("button", { name: "Board" }).click();
    await navigator.getByRole("link", { name: row }).click();
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

test("the way back, if chosen: an amber dot on Board while anything waits, named by its count", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("stellaris.boardMark", "dot"));
  await fakeBoard(page, { enrolling: true, asked: true });
  await page.goto("/");
  // 3 need you, 1 runner to approve, 1 cron failing.
  await expect(corner(page).getByRole("button", { name: "Board, 5 waiting" })).toBeVisible();
  const names = await corner(page)
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
    );
  expect(names).toEqual(["Pause", "Board, 5 waiting", "Sign out"]);
});

test("with nothing waiting Board wears no dot", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stellaris.boardMark", "dot"));
  await fakeBoard(page);
  await page.route("**/api/requests", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/proposals", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/crons", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/projects/*/tasks", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "Board" }).click();
  await expect(
    page
      .getByRole("region", { name: "Board navigator" })
      .getByRole("link", { name: "Status", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(corner(page).getByRole("button", { name: "Board", exact: true })).toBeVisible();
});
