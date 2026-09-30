import { expect, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

test("the operations log floats from the top bar, apart from the board, and Esc closes it", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Board" }).click();
  // Signals have no channel in the board.
  await expect(page.getByRole("link", { name: "general" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "ops" })).toHaveCount(0);

  const logs = page.getByRole("button", { name: "Logs" });
  await logs.click();
  await expect(logs).toHaveAttribute("aria-expanded", "true");
  const log = page.getByRole("region", { name: "Operations log" });
  const gap = log.getByRole("listitem").filter({ hasText: "role gap" });
  await expect(gap).toContainText("a stage in lab waits on the referee role, which nobody fills");
  await expect(gap).toContainText("holds now");
  await expect(gap).toContainText("lab · role referee · wakes the steward");
  const runner = log.getByRole("listitem").filter({ hasText: "runner server is connected" });
  await expect(runner).not.toContainText("wakes the steward");
  await expect(runner).not.toContainText("value");
  await expect(runner).not.toContainText("holds now");

  // Esc closes the log first and leaves the board open.
  await page.keyboard.press("Escape");
  await expect(log).toBeHidden();
  await expect(page.getByRole("region", { name: "Board content" })).toBeVisible();
});
