import { expect, test } from "@playwright/test";
import { FAILING_CRON, fakeBoard } from "./board.js";

// The society's status: one row in the navigator, above needs you, opening the views that the
// strip over the content switches between, each at its own address.

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

for (const layout of ["around", "beside"] as const) {
  test(`at a 20 px root font every tab stays inside the strip, a row of its own if need be (${layout} the sky, 420 px panel)`, async ({
    page,
  }) => {
    // Chrome's Font size "Large": the app sets no root size, so the browser's scales every rem.
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript((chosen) => {
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.style.fontSize = "20px";
      });
      localStorage.setItem("stellaris.boardLayout", chosen);
      localStorage.setItem("stellaris.contentWidth", "420");
    }, layout);
    await fakeBoard(page, { enrolling: true });
    await page.goto("/citizens");
    const strip = page.getByRole("navigation", { name: "Status" });
    await expect(
      strip.getByRole("link", { name: "Runners, 1 waiting for approval" }),
    ).toBeVisible();
    const fit = await strip.evaluate((nav) => {
      const box = nav.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        root: getComputedStyle(document.documentElement).fontSize,
        tabs: [...nav.querySelectorAll("a")].map((a) => {
          const r = a.getBoundingClientRect();
          return { name: a.textContent, left: r.left, right: r.right, height: r.height };
        }),
      };
    });
    expect(fit.root).toBe("20px");
    for (const tab of fit.tabs) {
      expect(tab.right, `${tab.name} ends inside the strip`).toBeLessThanOrEqual(fit.right);
      expect(tab.left, `${tab.name} starts inside the strip`).toBeGreaterThanOrEqual(fit.left);
    }
    // Each label on one line: a tab wraps whole to the next row, never its words.
    expect(new Set(fit.tabs.map((tab) => tab.height)).size).toBe(1);
  });
}
