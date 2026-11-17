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

test("a post a gateway answered with a 502 after the board stored it goes again with its key, stored once", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);
  const view = viewOf(page);
  const thread = view.getByRole("region", { name: "Thread" });
  const box = view.getByRole("textbox", { name: "Write in the task's thread" });
  await expect(thread).toContainText("Survey done");

  board.loseNextPostAnswer("502");
  await box.fill("Past the gateway once.");
  await box.press("Enter");
  await expect(view.getByRole("alert")).toHaveText("/api/verbs/post_message answered 502");
  await expect(box).toHaveValue("Past the gateway once.");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  await expect(thread.getByText("Past the gateway once.", { exact: true })).toHaveCount(1);
  expect(board.stored("Past the gateway once.")).toBe(1);
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

for (const loss of ["reset", "502"] as const) {
  test(`an ask whose thread's open lost its answer to a ${loss} opens one thread, with one post`, async ({
    page,
  }) => {
    const board = await fakeBoard(page, { asks: true });
    await page.goto("/");
    await expect(page.getByRole("button", { name: /to ask$/ })).toBeVisible();
    await page.keyboard.press("Space");
    const ask = page.getByRole("region", { name: "Ask", exact: true });
    const field = ask.getByRole("textbox", { name: "Ask the front desk" });
    await expect(field).toBeFocused();

    // The board opens the thread, but its answer never arrives, so nothing is posted yet.
    board.loseNextOpenAnswer(loss);
    await field.fill("Who runs the nightly?");
    await field.press("Enter");
    await expect(ask.getByRole("alert")).toHaveText(
      loss === "502" ? "/api/verbs/open_thread answered 502" : "The board server is not reachable.",
    );
    await expect(field).toHaveValue("Who runs the nightly?");
    // Sent again, the open carries the same key, and the board answers with the thread it opened.
    await field.press("Enter");
    await expect(field).toHaveValue("");

    const opens = board.writes.filter((write) => write.path === "/api/verbs/open_thread");
    expect(opens).toHaveLength(2);
    expect(board.opened(String(opens[0]?.body["title"]))).toBe(1);
    expect(board.stored("Who runs the nightly?")).toBe(1);
    expect(opens[0]?.body["idempotency_key"]).toMatch(KEY);
    expect(opens[1]?.body).toEqual(opens[0]?.body);
  });

  test(`a new thread whose open lost its answer to a ${loss} is opened once, with one first message`, async ({
    page,
  }) => {
    const board = await fakeBoard(page);
    await page.goto("/c/lab/general");
    const view = viewOf(page);
    await view.getByRole("button", { name: "New thread" }).click();
    await view.getByRole("textbox", { name: "Thread title" }).fill("Rollout order");
    await view.getByRole("textbox", { name: "First message" }).fill("Docs first.");

    board.loseNextOpenAnswer(loss);
    await view.getByRole("button", { name: "Open thread" }).click();
    await expect(view.getByRole("alert")).toHaveText(
      loss === "502" ? "/api/verbs/open_thread answered 502" : "The board server is not reachable.",
    );
    await view.getByRole("button", { name: "Open thread" }).click();
    await expect(page).toHaveURL(/\/thread\//);

    const opens = board.writes.filter((write) => write.path === "/api/verbs/open_thread");
    const posts = board.writes.filter((write) => write.path === "/api/verbs/post_message");
    expect(opens).toHaveLength(2);
    expect(posts).toHaveLength(1);
    expect(board.opened("Rollout order")).toBe(1);
    expect(board.stored("Docs first.")).toBe(1);
    expect(opens[0]?.body["idempotency_key"]).toMatch(KEY);
    expect(opens[1]?.body).toEqual(opens[0]?.body);
    expect(posts[0]?.body["idempotency_key"]).toMatch(KEY);
  });
}

test("a new thread whose first message lost its answer goes again into the same thread, stored once", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto("/c/lab/general");
  const view = viewOf(page);
  await view.getByRole("button", { name: "New thread" }).click();
  await view.getByRole("textbox", { name: "Thread title" }).fill("Rollout order");
  await view.getByRole("textbox", { name: "First message" }).fill("Docs first.");

  board.loseNextPostAnswer();
  await view.getByRole("button", { name: "Open thread" }).click();
  await expect(view.getByRole("alert")).toHaveText("The board server is not reachable.");
  await view.getByRole("button", { name: "Open thread" }).click();
  await expect(page).toHaveURL(/\/thread\//);

  const opens = board.writes.filter((write) => write.path === "/api/verbs/open_thread");
  const posts = board.writes.filter((write) => write.path === "/api/verbs/post_message");
  expect(opens).toHaveLength(2);
  expect(posts).toHaveLength(2);
  expect(board.opened("Rollout order")).toBe(1);
  expect(board.stored("Docs first.")).toBe(1);
  expect(opens[1]?.body).toEqual(opens[0]?.body);
  expect(posts[1]?.body).toEqual(posts[0]?.body);
});

test("a new thread's changed title goes with a new key, and its changed first message too", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto("/c/lab/general");
  const view = viewOf(page);
  await view.getByRole("button", { name: "New thread" }).click();
  const title = view.getByRole("textbox", { name: "Thread title" });
  const first = view.getByRole("textbox", { name: "First message" });
  await title.fill("Rollout order");
  await first.fill("Docs first.");

  // The open's answer is lost, then the title changes: a new open, with a new key.
  board.loseNextOpenAnswer();
  await view.getByRole("button", { name: "Open thread" }).click();
  await expect(view.getByRole("alert")).toHaveText("The board server is not reachable.");
  await title.fill("Rollout order, revised");
  // The next first message's answer is lost, then the message changes: a new post, new key.
  board.loseNextPostAnswer();
  await view.getByRole("button", { name: "Open thread" }).click();
  await expect(view.getByRole("alert")).toHaveText("The board server is not reachable.");
  await first.fill("Docs first, then the export view.");
  await view.getByRole("button", { name: "Open thread" }).click();
  await expect(page).toHaveURL(/\/thread\//);

  const opens = board.writes
    .filter((write) => write.path === "/api/verbs/open_thread")
    .map((write) => write.body["idempotency_key"]);
  const posts = board.writes
    .filter((write) => write.path === "/api/verbs/post_message")
    .map((write) => write.body["idempotency_key"]);
  expect(opens).toHaveLength(3);
  expect(opens[1]).not.toBe(opens[0]);
  expect(opens[2]).toBe(opens[1]);
  expect(posts).toHaveLength(2);
  expect(posts[1]).not.toBe(posts[0]);
  expect(board.opened("Rollout order, revised")).toBe(1);
  expect(board.stored("Docs first, then the export view.")).toBe(1);
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

test("what is typed while an approval is on its way stays in the box once it lands", async ({
  page,
}) => {
  const board = await fakeBoard(page);
  await page.goto(`/task/${STAGE_TASK}`);
  const view = viewOf(page);
  const box = view.getByRole("textbox", { name: "Write in the task's thread" });
  const approve = view.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeEnabled();

  const held = Promise.withResolvers<void>();
  await page.route("**/api/verbs/advance_task", async (route) => {
    await held.promise;
    await route.fallback();
  });
  await box.fill("LGTM.");
  await approve.click();
  await expect(approve).toHaveAttribute("aria-busy", "true");
  await box.press("End");
  await box.pressSequentially(" One more thing.");
  held.resolve();
  await expect(approve).toHaveCount(0);
  expect(board.writes.at(-1)).toEqual({
    path: "/api/verbs/advance_task",
    body: { task_id: STAGE_TASK, note: "LGTM." },
  });
  await expect(box).toHaveValue("LGTM. One more thing.");
});
