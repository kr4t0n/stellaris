import { expect, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

test("the operations log is a status view of its own, apart from the channels, and Esc closes the board", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/c/general");
  // Signals have no channel in the board.
  await expect(page.getByRole("link", { name: "general" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "ops" })).toHaveCount(0);

  await page
    .getByRole("region", { name: "Governance" })
    .getByRole("link", { name: /^Status/ })
    .click();
  const logs = page.getByRole("navigation", { name: "Status" }).getByRole("link", { name: "Logs" });
  await logs.click();
  await expect(page).toHaveURL("/logs");
  await expect(logs).toHaveAttribute("aria-current", "page");
  const log = page.getByRole("region", { name: "Board content" });
  await expect(log.getByRole("heading", { name: "Operations log" })).toBeVisible();
  const gap = log.getByRole("listitem").filter({ hasText: "role gap" });
  await expect(gap).toContainText("a stage in lab waits on the referee role, which nobody fills");
  await expect(gap).toContainText("holds now");
  await expect(gap).toContainText("lab · role referee · wakes the steward");
  const runner = log.getByRole("listitem").filter({ hasText: "runner server is connected" });
  await expect(runner).not.toContainText("wakes the steward");
  await expect(runner).not.toContainText("value");
  await expect(runner).not.toContainText("holds now");
  // A repeat of a condition that wakes the steward only when it is new or crosses a step.
  const idle = log.getByRole("listitem").filter({ hasText: "idle member" });
  await expect(idle).toContainText("ada · role researcher");
  await expect(idle).not.toContainText("wakes the steward");

  // Esc closes the board from it, as from any view.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/");
  await expect(log).toHaveCount(0);
});
