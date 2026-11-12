import { expect, test, type Page } from "@playwright/test";
import { fakeBoard, STAGE_TASK } from "./board.js";

/** The board's content island, where a task's view opens. */
function viewOf(page: Page) {
  return page.getByRole("region", { name: "Board content" });
}

/** A key as the composer makes one: 16 random bytes in hex. */
const KEY = /^[0-9a-f]{32}$/;

test("a sent message shows from the post's answer, while the thread's read is still held, and the composer reads nothing of its own", async ({
  page,
}) => {
  await fakeBoard(page);
  // Every read of the thread after the first is held until the end, and counted.
  let holding = false;
  let reads = 0;
  const held = Promise.withResolvers<void>();
  await page.route(`**/api/threads/${STAGE_TASK}`, async (route) => {
    if (holding) {
      reads += 1;
      await held.promise;
    }
    await route.fallback();
  });
  await page.goto(`/task/${STAGE_TASK}`);
  const view = viewOf(page);
  const thread = view.getByRole("region", { name: "Thread" });
  await expect(thread).toContainText("Survey done: twelve methods in SURVEY.md, with sources.");

  holding = true;
  const box = view.getByRole("textbox", { name: "Write in the task's thread" });
  await box.fill("Shown from the answer.");
  await box.press("Enter");
  await expect(thread).toContainText("Shown from the answer.");
  await expect(box).toHaveValue("");
  // The board's event for the post reads the thread again; the composer adds no read of its own.
  expect(reads).toBe(0);
  held.resolve();
});

test("a channel's post shows from its answer too", async ({ page }) => {
  await fakeBoard(page);
  const held = Promise.withResolvers<void>();
  let holding = false;
  await page.route("**/api/channels/lab/general", async (route) => {
    if (holding) {
      await held.promise;
    }
    await route.fallback();
  });
  await page.goto("/c/lab/general");
  const view = viewOf(page);
  const box = view.getByRole("textbox", { name: "Message #general" });
  await expect(box).toBeVisible();
  holding = true;
  await box.fill("In the channel at once.");
  await box.press("Enter");
  await expect(view.getByText("In the channel at once.", { exact: true })).toBeVisible();
  held.resolve();
});

test("a post whose answer was lost goes again with the same key and is stored once; changed text goes with a new key", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);
  const view = viewOf(page);
  const thread = view.getByRole("region", { name: "Thread" });
  const box = view.getByRole("textbox", { name: "Write in the task's thread" });
  await expect(thread).toContainText("Survey done");

  // The board stores the post, but its answer never arrives: the box keeps the text and says so.
  board.loseNextPostAnswer();
  await box.fill("Stored once.");
  await box.press("Enter");
  await expect(view.getByRole("alert")).toHaveText("The board server is not reachable.");
  await expect(box).toHaveValue("Stored once.");

  // Sent again, it carries the same key, and the board answers with the post it stored.
  await box.press("Enter");
  await expect(box).toHaveValue("");
  await expect(thread.getByText("Stored once.", { exact: true })).toHaveCount(1);
  expect(board.stored("Stored once.")).toBe(1);
  const posts = board.writes
    .filter((write) => write.path === "/api/verbs/post_message")
    .map((write) => write.body["idempotency_key"]);
  expect(posts).toHaveLength(2);
  expect(posts[0]).toMatch(KEY);
  expect(posts[1]).toBe(posts[0]);

  // A lost answer, then the text changed: a new post, with a new key.
  board.loseNextPostAnswer();
  await box.fill("A second post.");
  await box.press("Enter");
  await expect(view.getByRole("alert")).toHaveText("The board server is not reachable.");
  await box.fill("A second post, changed.");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  const keys = board.writes
    .filter((write) => write.path === "/api/verbs/post_message")
    .map((write) => write.body["idempotency_key"]);
  expect(keys).toHaveLength(4);
  expect(keys[3]).not.toBe(keys[2]);
  expect(new Set(keys).size).toBe(3);
});

test("an ask whose post's answer was lost goes again into the thread it opened, stored once", async ({
  page,
}) => {
  const board = await fakeBoard(page, { asks: true });
  await page.goto("/");
  // The hint shows once the page is up, and Space then opens the ask box.
  await expect(page.getByRole("button", { name: /to ask$/ })).toBeVisible();
  await page.keyboard.press("Space");
  const ask = page.getByRole("region", { name: "Ask", exact: true });
  const field = ask.getByRole("textbox", { name: "Ask the front desk" });
  await expect(field).toBeFocused();

  board.loseNextPostAnswer();
  await field.fill("Who owns the nightly?");
  await field.press("Enter");
  await expect(ask.getByRole("alert")).toHaveText("The board server is not reachable.");
  await field.press("Enter");
  await expect(field).toHaveValue("");

  const opened = board.writes.filter((write) => write.path === "/api/verbs/open_thread");
  const posts = board.writes.filter((write) => write.path === "/api/verbs/post_message");
  expect(opened).toHaveLength(1);
  expect(posts).toHaveLength(2);
  expect(posts[1]?.body).toEqual(posts[0]?.body);
  expect(board.stored("Who owns the nightly?")).toBe(1);
});

test("what is typed while a post is on its way stays in the box once it is sent", async ({
  page,
}) => {
  await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);
  const view = viewOf(page);
  const thread = view.getByRole("region", { name: "Thread" });
  const box = view.getByRole("textbox", { name: "Write in the task's thread" });
  const send = view.getByRole("button", { name: "Send" });
  await expect(thread).toContainText("Survey done");

  const held = Promise.withResolvers<void>();
  await page.route("**/api/verbs/post_message", async (route) => {
    await held.promise;
    await route.fallback();
  });
  await box.fill("First thought.");
  await box.press("Enter");
  await expect(send).toHaveAttribute("aria-busy", "true");
  await box.press("End");
  await box.pressSequentially(" And a second.");
  held.resolve();
  await expect(thread).toContainText("First thought.");
  await expect(send).toHaveAttribute("aria-busy", "false");
  await expect(box).toHaveValue("First thought. And a second.");
});
