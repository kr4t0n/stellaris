import { expect, test } from "@playwright/test";
import { ANSWERED_ASK, fakeBoard } from "./board.js";

test("the new-thread form says whom its first message wakes, read as the message is sent", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto("/c/lab/general");
  const view = page.getByRole("region", { name: "Board content" });
  await view.getByRole("button", { name: "New thread" }).click();
  await view.getByRole("textbox", { name: "Thread title" }).fill("Run the harness");
  const first = view.getByRole("textbox", { name: "First message" });

  // A name in code wakes nobody, so the post is the front desk's.
  await first.fill("Run `@stew --fix` first.");
  await expect(view).toContainText("The first message wakes desk.");
  // Typed indented, the line would be code, but it is sent trimmed, where it names stew, who
  // takes it alone.
  await first.fill("    @stew please run it");
  await expect(view).toContainText("The first message wakes stew.");

  await view.getByRole("button", { name: "Open thread" }).click();
  await expect(page).toHaveURL(/\/thread\//);
  const posted = board.writes.find((write) => write.path === "/api/verbs/post_message");
  expect(posted?.body).toMatchObject({ body: "@stew please run it" });
});

test("a thread that can't be read says so, and one the board doesn't have says that", async ({
  page,
}) => {
  await fakeBoard(page, { asks: true });
  await page.route(`**/api/threads/${ANSWERED_ASK}`, (route) =>
    route.fulfill({ status: 500, json: { error: "INTERNAL", message: "disk full" } }),
  );
  const view = page.getByRole("region", { name: "Board content" });
  await page.goto(`/thread/${ANSWERED_ASK}`);
  await expect(view).toContainText("Could not read the thread.");
  await page.goto("/thread/01ARZ3NDEKTSV4RRFFQ69G5FAV");
  await expect(view).toContainText("There is no thread 01ARZ3NDEKTSV4RRFFQ69G5FAV.");
});
