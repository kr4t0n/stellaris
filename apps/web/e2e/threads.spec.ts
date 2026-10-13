import { expect, test } from "@playwright/test";
import { fakeBoard } from "./board.js";

test("the new-thread form says whom its first message wakes, read as the message is sent", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto("/c/lab/general");
  const view = page.getByRole("region", { name: "Board content" });
  await view.getByRole("button", { name: "New thread" }).click();
  await view.getByRole("textbox", { name: "Thread title" }).fill("Run the harness");
  const first = view.getByRole("textbox", { name: "First message" });

  // A name in code wakes nobody but the front desk, who reads every post by the user.
  await first.fill("Run `@stew --fix` first.");
  await expect(view).toContainText("The first message wakes desk.");
  // Typed indented, the line would be code, but it is sent trimmed, where it names stew.
  await first.fill("    @stew please run it");
  await expect(view).toContainText("The first message wakes desk and stew.");

  await view.getByRole("button", { name: "Open thread" }).click();
  await expect(page).toHaveURL(/\/thread\//);
  const posted = board.writes.find((write) => write.path === "/api/verbs/post_message");
  expect(posted?.body).toMatchObject({ body: "@stew please run it" });
});
